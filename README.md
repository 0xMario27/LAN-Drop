# LAN Drop

Anonymous peer-to-peer chat and file transfer for your local network — a Chrome extension that uses WebRTC DataChannels with end-to-end encryption. No accounts, no servers in the data path, no message storage.

**[中文说明](#中文说明)**

---

## Features

- **Zero-config discovery** — automatically scans your subnet for the signaling relay
- **End-to-end encrypted** — Noise IK handshake + ChaCha20-Poly1305 per-frame encryption on top of DTLS
- **Self-authenticating identities** — libp2p-style peer IDs (Ed25519 → SHA-256 → base32); MITM attempts fail the handshake
- **TOFU trust model** — first-seen keys are auto-trusted; key changes trigger a visible warning
- **Click-to-download files** — received files appear as cards in chat; you choose when to save
- **No room limit** — full-mesh P2P, tested with 40 concurrent peers
- **LAN-only by default** — `iceServers` is empty, so connections can't leave the local network

## Quick Start

### 1. Start the signaling relay

Pick one machine on your LAN:

```bash
make up          # Docker (recommended), prints the ws:// address when done
# or
make serve       # Bare Node ≥ 22.18 (native type stripping, no build step)
```

### 2. Build and load the extension

```bash
make build       # or: make build-docker (no local Node needed)
```

Open `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the `extension/` directory. Click the extension icon to open the app in a tab.

### 3. Connect

Click the ⚙ gear icon → either click **Auto-discover** or paste the `ws://` address from `make ip` → **Connect**. Everyone on the same subnet appears in the member list.

## Deployment

### Docker (recommended)

```bash
make up                    # Build image + start container in background
make up PORT=9000          # Custom port
make logs                  # Follow server logs
make down                  # Stop
```

The container uses `node:24-alpine`. On Docker Desktop (macOS/Windows) all clients share the gateway IP and land in the same default room — acceptable for a LAN tool. For precise subnet isolation, use `network_mode: host` on Linux (see `compose.yaml`).

### Bare Node

```bash
# Requires Node ≥ 22.18 (native TypeScript type stripping)
npm install
PORT=8787 node server/signal.ts
```

### Public server

Deploy `server/signal.ts` to any host with Node 22+. Point the extension at `wss://your-domain.example` — auto-discovery is skipped for non-LAN addresses.

### Build the extension

```bash
make build          # tsc + esbuild (bundles crypto deps into offscreen.js)
make zip            # Produce distributable lan-drop-extension.zip (strips .map)
```

`make build-docker` does the same in a throwaway container — no local Node required.

## Architecture

```
src/
  protocol.ts            Shared type definitions (signaling + DataChannel + app state)
  crypto-primitives.ts   noble wrappers: base64/base32, SHA-256, HKDF, ChaCha20-Poly1305, X25519
  identity.ts            Long-term X25519 keypair, peerID derivation, serialization
  noise.ts               Noise IK handshake (Noise_IK_25519_ChaChaPoly_SHA256)
  secure-channel.ts      HKDF-derived send/recv keys + per-frame AEAD
  background.ts          Service worker: offscreen keepalive, storage proxy, downloads
  offscreen.ts           Core: signaling WebSocket + mesh PeerConnections + encrypted DataChannel
  popup.ts               UI rendering and event handling
  discover.ts            LAN signaling auto-discovery (subnet scanning)
server/
  signal.ts              Signaling relay (~150 lines, only forwards SDP/ICE + pubkey)
extension/               Built extension (manifest + HTML/CSS sources + compiled JS)
```

WebRTC runs in an **offscreen document** (`reasons: ['WEB_RTC']`) because MV3 service workers are killed after 30 s. The offscreen document stays alive as long as the extension is loaded.

### Security model

| Layer | What it does |
|---|---|
| DTLS (WebRTC built-in) | Session-level encryption + PFS |
| Noise IK handshake | Mutual authentication, MITM detection, shared root key |
| Secure channel (ChaCha20-Poly1305) | Per-frame AEAD with HKDF-derived directional keys |
| TOFU trust store | First-seen pubkey stored in `chrome.storage.local`; changes trigger UI warning |

The signaling server **only** forwards SDP/ICE frames and pubkeys. It cannot read messages or files. It sees your IP (TCP inherent) but not your identity, content, or transfers.

### What's intentionally left out

- **No message persistence** — messages live in memory (max 200), cleared on reload
- **No file streaming** — files are read into memory before sending (fine up to a few hundred MB)
- **No SFU** — full-mesh means O(n²) connections; fine for dozens of peers, not hundreds
- **No per-message forward secrecy** — DTLS provides session-level PFS; the app-layer channel uses a stable key per session (no Double Ratchet)

## Development

```bash
make typecheck     # Two configs: extension (DOM + @types/chrome) + server (Node)
make test          # 15 tests: signaling, discovery, Noise IK, secure channel
make watch         # Recompile on change
```

Dependencies: `ws` (server), `@noble/curves` / `@noble/ciphers` / `@noble/hashes` (crypto), `esbuild` (build). No runtime frontend framework.

## License

[MIT](LICENSE)

---

# 中文说明

局域网内匿名 P2P 聊天与文件传输的 Chrome 扩展。WebRTC DataChannel 端到端加密，无账号、无服务器中转数据、无消息存储。

## 功能

- **零配置发现** — 自动扫描本网段寻找信令中转服务
- **端到端加密** — Noise IK 握手 + 每帧 ChaCha20-Poly1305 加密（DTLS 之上再加一层）
- **自认证身份** — libp2p 风格 peer ID（Ed25519 → SHA-256 → base32）；中间人握手必失败
- **TOFU 信任** — 首次见到的公钥自动信任；密钥变更时弹出警告
- **点击下载文件** — 接收到的文件以卡片形式出现在聊天中，由你决定何时保存
- **房间无人数上限** — 全网状 P2P，已验证 40 人同时在线
- **默认仅限局域网** — `iceServers` 留空，连接物理上出不了内网

## 快速开始

### 1. 启动信令服务

局域网里任选一台机器：

```bash
make up          # Docker（推荐），启动后打印 ws:// 地址
# 或
make serve       # 裸 Node ≥ 22.18（原生 type stripping，无需构建）
```

### 2. 构建并加载扩展

```bash
make build       # 或 make build-docker（本机不用装 Node）
```

打开 `chrome://extensions` → 右上角「开发者模式」→「加载已解压的扩展程序」→ 选 `extension/` 目录。点扩展图标在标签页中打开应用。

### 3. 连接

点 ⚙ 设置 → 点「自动发现」或手动填 `make ip` 打印的 `ws://` 地址 → 点「连接」。同网段的人会自动出现在成员列表里。

## 部署

### Docker（推荐）

```bash
make up                    # 构建镜像 + 后台启动
make up PORT=9000          # 自定义端口
make logs                  # 查看日志
make down                  # 停止
```

容器基于 `node:24-alpine`。Docker Desktop（macOS/Windows）下所有客户端来源 IP 会变成网关地址，落进同一默认房间——对局域网工具可接受。要精确按网段隔离，在 Linux 上用 `network_mode: host`（见 `compose.yaml` 注释）。

### 裸 Node

```bash
# 需 Node ≥ 22.18（原生 TypeScript type stripping）
npm install
PORT=8787 node server/signal.ts
```

### 公网部署

把 `server/signal.ts` 部署到任意有 Node 22+ 的主机。扩展里填 `wss://your-domain.example`——公网地址不走自动发现。

### 构建扩展

```bash
make build          # tsc + esbuild（把 crypto 依赖打包进 offscreen.js）
make zip            # 生成可分发的 lan-drop-extension.zip（去掉 .map）
```

`make build-docker` 在一次性容器里完成同样工作——本机不需要装 Node。

## 代码结构

```
src/
  protocol.ts            所有线上协议的类型定义（纯类型）
  crypto-primitives.ts   noble 封装：base64/base32、SHA-256、HKDF、ChaCha20-Poly1305、X25519
  identity.ts            X25519 长期密钥、peerID 派生、序列化
  noise.ts               Noise IK 握手（Noise_IK_25519_ChaChaPoly_SHA256）
  secure-channel.ts      HKDF 派生收发密钥 + 每帧 AEAD
  background.ts          service worker：保活 offscreen + 代办存储/下载
  offscreen.ts           核心：信令 WebSocket + 全网状 PeerConnection + 加密 DataChannel
  popup.ts               UI 渲染与事件
  discover.ts            局域网信令自动发现（网段扫描）
server/
  signal.ts              信令中转（约 150 行，只转发 SDP/ICE + pubkey）
extension/               构建产物（manifest + HTML/CSS 源码 + 编译 JS）
```

WebRTC 跑在 **offscreen 文档**（`reasons: ['WEB_RTC']`）里——MV3 service worker 30 秒就被回收，offscreen 文档只要扩展加载着就活着。

### 安全模型

| 层 | 作用 |
|---|---|
| DTLS（WebRTC 自带） | 会话级加密 + 前向保密 |
| Noise IK 握手 | 双向认证、MITM 检测、共享根密钥 |
| 加密通道（ChaCha20-Poly1305） | 每帧 AEAD，HKDF 派生方向密钥 |
| TOFU 信任存储 | 首次公钥存入 `chrome.storage.local`；变更时 UI 告警 |

信令服务**只**转发 SDP/ICE 帧和公钥。它看不到消息和文件，看得到你的 IP（TCP 固有）但看不到身份、内容、传输。

### 已经砍掉的东西

- **无消息持久化** — 消息只在内存里留最近 200 条，重载即清空
- **无文件流式传输** — 文件整个读进内存再发（几百 MB 没问题）
- **无 SFU** — 全网状 O(n²) 连接，几十人以内没问题
- **无 per-message 前向保密** — DTLS 提供会话级 PFS；应用层通道每会话用固定密钥（无 Double Ratchet）

## 开发

```bash
make typecheck     # 两套配置：扩展（DOM + @types/chrome）+ 服务端（Node）
make test          # 15 个测试：信令、发现、Noise IK、加密通道
make watch         # 改动即重编译
```

依赖：`ws`（服务端）、`@noble/curves` / `@noble/ciphers` / `@noble/hashes`（加密）、`esbuild`（构建）。无运行时前端框架。

## 许可证

[MIT](LICENSE)
