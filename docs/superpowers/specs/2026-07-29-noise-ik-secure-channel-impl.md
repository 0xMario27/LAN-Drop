# LAN Drop 身份认证与加密通道 - 实现手册（简化版）

> 日期：2026-07-29（修订）
> 适用范围：当前 LAN Drop 仓库（MV3 Chrome 扩展 + Node 信令服务）
> 目标：把"无身份验证的 DTLS 通道"升级为"自认证 peer ID + Noise IK 握手 + 应用层对称加密"，挡掉同房间内的主动 MITM。
> 与原方案差异：去掉 Double Ratchet 与 libsignal 依赖。DTLS 已提供会话级加密，应用层只需身份绑定 + 一层薄对称加密，不引入复杂状态机。

## 1. 目标与非目标

### 目标
- 挡掉同房间内的主动 MITM：攻击者无法用偷来的 SDP/ICE 帧伪造对端身份。
- 身份可见：UI 显示对端指纹与信任状态（TOFU / verified / 变更警告）。
- 应用层加密：握手派生的密钥用 ChaCha20-Poly1305 加密所有 DataChannel 应用帧。
- 完全透明：正常用户察觉不到变化（除首次信任提示外）。
- 协议向下兼容：旧版本扩展仍能加入（"未认证"模式），不强制升级。

### 非目标
- 不做 per-message 前向保密（Double Ratchet）。会话级 PFS 已由 DTLS 提供，LAN 场景足够。
- 不引入 libsignal-protocol-javascript（2019 年停维、依赖 Node API、浏览器不兼容）。
- 不在服务端维护 PreKey 服务器。不替换 WebRTC 传输层。不实现 libp2p 全部功能。

## 2. 总体架构

两层：
- **身份层（libp2p 风格）**：peer ID = base32(SHA-256(长期公钥))；握手时强制把"我以为连的是谁"和"实际拿到的公钥"绑起来。
- **会话层（Noise IK + 对称加密）**：握手完成后从 RootKey 派生一对收发密钥，后续每帧用 ChaCha20-Poly1305 + 递增 nonce 加密。

```
┌─────────────── 不可信管道（WebRTC DataChannel + DTLS）───────────────┐
│  ① Noise IK 握手（一次性，每对端，3 条消息）                          │
│     - 交换长期公钥 + 临时公钥；三次 ECDH -> 32B RootKey               │
│     - 验证：hash(对端长期公钥) 必须等于 join 帧里声明的 peerID        │
│  ② 对称加密通道（每条应用帧）                                         │
│     - 从 RootKey 派生 sendKey / recvKey（HKDF-SHA256）                │
│     - 每帧：ChaCha20-Poly1305(key, nonce, plaintext, AD=counter)      │
│     - nonce = 12B，前 4B 固定 0，后 8B 为递增计数器（大端）            │
│  ③ 应用载荷（文本/文件控制帧 + 文件分片，全部走加密通道）              │
└───────────────────────────────────────────────────────────────────────┘
```

## 3. 依赖

```json
{
  "dependencies": {
    "ws": "^8.18.0",
    "@noble/curves": "^1.4.0",
    "@noble/ciphers": "^1.0.0",
    "@noble/hashes": "^1.4.0"
  }
}
```

不用 libsignal：旧 JS 版停维且依赖 Node Buffer/crypto，在 offscreen 文档无法运行；Double Ratchet 状态机复杂、ROI 低；@noble/* 纯 JS audited，浏览器原生兼容，gzip 30-50KB。

## 4. 文件结构

```
src/
  protocol.ts            修改：PeerInfo 加 pubkey；SwMessage 加 identity/trusted-peer
  crypto-primitives.ts   新增：noble 封装（base64/base32/sha256/hkdf/chacha20poly1305）
  identity.ts            新增：长期密钥生成、peerID 派生、storage I/O
  noise.ts               新增：Noise IK 握手状态机
  secure-channel.ts      新增：RootKey 派生 + ChaCha20-Poly1305 收发加密
  background.ts          修改：增加 identity / trusted-peer 存取 handler
  offscreen.ts           修改：握手 + 加密通道嵌入 PeerConnection
  popup.ts               修改：信任状态显示（盾牌图标）
  noise.test.ts          新增
  secure-channel.test.ts 新增
server/
  signal.ts              修改：joined/peers/peer-join 携带 pubkey
```

## 5. 身份层

每个扩展实例持有一对 X25519 长期密钥。peerID = `"12D3Koo" + base32(SHA-256(pubkey)).slice(0,36)`。

- `loadOrCreateIdentity()`：通过 SwMessage 让 SW 代读写 `chrome.storage.local`（offscreen 无 storage API）。
- `fingerprint(pubkey)`：SHA-256 前 8 字节 hex，供 UI 显示。

SwMessage 新增：`get-identity` / `set-identity` / `get-trusted-peer` / `set-trusted-peer`。
TrustLevel = `'tofu' | 'verified'`。trusted peer 存储结构：`{ pubkey, name, firstSeen, level }`。

## 6. Noise IK 握手

- **为什么 IK**：发起方在对端 `peer-join`/`joined` 帧里已拿到对端 pubkey，匹配 IK 前提；比 XX 少一轮往返。
- **3 条消息**：① e + AEAD(static) + AEAD(payload) ② e + AEAD(ee) + AEAD(static) + AEAD(payload) ③ AEAD(static) + AEAD(payload)。payload 槽带 1 字节版本标志。
- **DH 链**：DH1=DH(e,rs), DH2=DH(e,re), DH3=DH(s,re)；MixKey=HKDF-SHA256(ck,ikm,64B)，前32=新ck 后32=k；最终 RootKey=ck。
- **身份绑定**：握手解出的 remoteStaticPubkey，`derivePeerId` 必须等于 join 帧声明的 peer.id，否则 close + 报 MITM。
- **TOFU**：首次见到存 `level:tofu`；已存在则比对 pubkey，不符则 UI 弹变更警告。
- **错误**：解密失败 / 指纹不符 / 超时 10s -> `pc.close()` + 提示。

## 7. 对称加密通道（替代 Double Ratchet）

### 密钥派生
```
sendKey = HKDF(RootKey, "lan-drop-send-" + (isInitiator?'initiator':'responder'))
recvKey = HKDF(RootKey, "lan-drop-recv-" + (isInitiator?'initiator':'responder'))
```
发起方 sendKey = 响应方 recvKey，反之亦然。

### 帧格式
```
┌────────────┬────────────────────┐
│ nonce(12B) │ ciphertext + tag    │
│ 4B 0 + 8B  │ N + 16B             │
│ counter BE │                     │
└────────────┴────────────────────┘
```
- nonce 前 4B 固定 0，后 8B 递增计数器（大端）。每帧 counter++，nonce 不重复即 AEAD 安全。
- 无乱序处理：DataChannel 走 SCTP，有序可靠，不需 skipped map。

### 与 offscreen 集成
- 控制帧（ChannelFrame JSON）前缀 `0x01`，文件分片为裸字节（前缀非 0x01）。
- `secureSend(ch, peer, frame)`：编码 -> encrypt -> 拼 nonce+ciphertext -> `ch.send`。
- `ch.onmessage`：解 nonce/ciphertext -> decrypt -> 看前缀区分控制帧 / 文件分片。
- **握手期/加密期切换**：DataChannel 打开后先跑 Noise（明文 3 帧），握手成功才 `peer.ready=true`。`targets()` 过滤 `peer.ready`，握手未完成前不发应用帧。

## 8. 协议字段变更

```ts
export interface PeerInfo { id: string; name: string; pubkey: string }       // 加 pubkey
export type ClientFrame =
  | { t: 'join'; room: string | null; id: string; name: string; pubkey: string }
  | { t: 'signal'; to: string; data: SignalPayload };
export type ServerFrame =
  | { t: 'joined'; room: string; peers: PeerInfo[] }
  | { t: 'peer-join'; id: string; name: string; pubkey: string }
  | { t: 'peer-leave'; id: string }
  | { t: 'signal'; from: string; data: SignalPayload }
  | { t: 'error'; message: string };
```

兼容：扩展收到 peer 无 pubkey -> 标记"未认证"（灰盾），不阻断；服务端不验证 pubkey，只中转 + 长度限制。

## 9. 服务端改动

`Member` 加 `pubkey`；join 时存；peer-join / joined 广播带上。零逻辑改动。

## 10. UI 改动

每个 peer 名字旁盾牌图标：无（旧版）/ 灰盾+问号（TOFU）/ 绿盾+对勾（verified）/ 黄三角（指纹变更警告）。hover 显示指纹前 8 位 + 信任按钮。

## 11. 测试

- `noise.test.ts`：双方 rootKey 一致；篡改 static pubkey -> 握手失败。
- `secure-channel.test.ts`：A->B 连续加密/解密 100 帧；错误 nonce -> 解密失败。
- 复用 `signal.test.ts`：pubkey 字段中转正常；旧测试不回归。

## 12. 分步落地

1. **基础设施**：装 @noble/*；crypto-primitives.ts + identity.ts + background handler；typecheck。
2. **Noise IK**：noise.ts 状态机；offscreen createPeer 后握手，成功才 ready；noise.test.ts。
3. **对称加密通道**：secure-channel.ts；offscreen 收发改造；secure-channel.test.ts。
4. **协议与服务端**：protocol.ts 加 pubkey；signal.ts 中转；旧测试不回归。
5. **UI**：popup.ts 盾牌图标 + 信任状态。
6. **验证**：make typecheck && make test 全通过。

## 13. 风险

| 风险 | 缓解 |
|---|---|
| Noise 实现易错 | 严格参考 noiseprotocol.org；HKDF/AEAD 用 noble 已审计实现 |
| bundle 体积 | @noble/* gzip 30-50KB，可接受 |
| 信令服务伪造 pubkey | 握手会失败=DoS 而非 MITM；UI 显示指纹供用户比对 |
| 老客户端兼容 | pubkey 缺失=未认证，不拒连 |
| 本地明文私钥 | chrome.storage.local 不加密；后续可加密码派生密钥加密（非本次范围） |
