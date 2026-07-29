# LAN Drop

局域网内匿名 P2P 聊天与文件传输的 Chrome 扩展。全部用 TypeScript 编写，文本和文件走 WebRTC DataChannel，不经过任何服务器。

## 为什么需要一个信令服务

浏览器里没有任何 API 能做 UDP 广播或 mDNS 扫描（`chrome.sockets` 只属于已下线的 Chrome App），所以 WebRTC 无法自己"发现"对端。这里用一个约 110 行的中转解决：

- 服务器**只**转发 SDP / ICE，聊天内容和文件字节一个都看不到；
- 不落盘、不记日志、不需要账号；
- `iceServers` 留空，连 STUN 都不连 —— 只能靠局域网内的 host / mDNS 候选打通，物理上出不了内网。

## 跑起来

`make` 列出全部命令：

| 命令 | 作用 |
|---|---|
| `make build` | 编译扩展：`src/*.ts` → `extension/*.js` |
| `make build-docker` | 同上，但在一次性容器里跑 —— **本机不用装 Node** |
| `make watch` | 改动即重编译 |
| `make up` / `make down` / `make logs` | Docker 起 / 停 / 看信令服务 |
| `make serve` | 不用 Docker，直接 `node server/signal.ts` |
| `make ip` | 打印该填进扩展设置里的 `ws://` 地址 |
| `make zip` | 把 `extension/` 打包成可分发的 zip |
| `make typecheck` / `make test` / `make test-docker` | 类型检查 / 测试 |
| `make clean` | 删掉编译产物 |

依赖会按需自动安装，不必先手动 `npm install`。端口用 `make up PORT=9000` 覆盖。

### 不想在本机装 Node

`make build-docker` 和 `make test-docker` 用一次性 `node:24-alpine` 容器完成全部工作，跑完即销毁，本机只需要 Docker。容器以调用者的 uid 运行，所以产物不会变成 root 所有；`node_modules` 会落在项目目录里（已 gitignore），换镜像用 `make build-docker NODE_IMAGE=node:22-alpine`。

**1. 局域网里任选一台机器启动信令服务**

```bash
make up            # Docker，后台常驻，跑完顺带打印信令地址
# 或 make serve    # 裸 Node（≥ 22.18，原生 type stripping 直接跑 .ts，无构建步骤）
```

**2. 构建并加载扩展**

```bash
make build          # 或 make build-docker，本机不用装 Node
```

产物是 `extension/` 目录本身 —— 编译后它就是一个**完整的未打包扩展**：

```
extension/
  manifest.json                    入口清单
  popup.html  popup.css            UI（源码，手写）
  offscreen.html                   WebRTC 宿主页（源码，手写）
  background.js  offscreen.js
  popup.js       discover.js       ← tsc 从 src/*.ts 生成
  *.js.map                         调试用，分发时可去掉
```

安装：打开 `chrome://extensions` → 右上角打开「开发者模式」→ 点「加载已解压的扩展程序」→ **选 `extension/` 这个目录**（不是里面的某个文件）。改完代码跑 `make build`，回到该页点扩展卡片上的刷新图标即可。开发时用 `make watch`。

要发给别人就 `make zip`，生成的 `lan-drop-extension.zip` 已剔除 `.map`；对方解压后同样用「加载已解压的扩展程序」。上架 Chrome 应用商店也是传这个 zip。

**3. 点扩展图标打开界面，点 ⚙ 设置信令地址**

点图标会打开一个独立标签页（不是小弹窗），左侧栏是状态 / 成员 / 设置 / 诊断日志，右侧整块留给聊天。重复点图标会聚焦已开的那个标签页而不是新开一个。

点「🔍 自动发现」让它扫本网段，或者手动填 `make ip` 打印的那串（形如 `ws://192.168.1.105:8787`）→ 点「连接」。同网段的人会自动出现在「在线成员」里。

首次安装时扩展会自动扫一次并连上；之后一律用保存的地址，不会每次开扩展都扫局域网。

## 功能对照

| 需求 | 实现 |
|---|---|
| 发现信令服务 | 按常见私有网段并发探测（见下），也可手动填任意 `ws://` / `wss://` 地址 |
| 发现局域网用户 | 未填群组码时，服务器按来源 IP 的 /24 网段自动归组 |
| 文本 + 文件 | DataChannel，文件 16 KiB 分片 + `bufferedAmountLow` 背压，收完自动下载 |
| 群组 | 群组码本地 SHA-256 后再发给服务器，服务器只见密文；同码即同群 |
| 任意两人互通 | 房间内全网状（每对之间一条独立 PeerConnection） |
| 房间人数 | **无上限**（`server/signal.test.ts` 用 40 人验证） |
| 匿名 | 无账号、无注册；ID 每次启动随机生成，昵称默认随机且可留空 |

## 代码结构

```
src/protocol.ts     所有线上协议的唯一类型定义（纯类型，编译后不产出运行时代码）
src/background.ts   service worker：只负责保活 offscreen 文档 + 代调 chrome.downloads
src/offscreen.ts    信令 WebSocket + 全网状 PeerConnection + DataChannel 收发
src/popup.ts        UI
extension/          manifest / html / css 是源码，*.js 由 tsc 生成（已 gitignore）
server/signal.ts    信令中转，Node 直接执行 .ts
```

WebRTC 逻辑放在 **offscreen 文档**（`reasons: ['WEB_RTC']`）而不是 service worker —— MV3 的 worker 三十秒就被回收，连接会断。

```bash
make typecheck   # 扩展（DOM + @types/chrome）与服务端（Node）两套配置分别检查
make test        # 服务端全部非平凡逻辑：房间隔离、信令转发、无人数上限、网段归组
```

## 自动发现是怎么做的，以及它的边界

MV3 扩展**拿不到本机 IP**：`chrome.system.network` 是已下线的 Chrome Apps 专有 API，而 WebRTC 的 host candidate 会被 Chrome 用 mDNS 混淆成 `*.local`。所以没法先算出网段再精确扫，只能按常见私有网段挨个探测 —— 能握手成功的 WebSocket 就是信令服务（`src/discover.ts`）。

默认扫这几个，按命中概率排序：`192.168.1` / `192.168.0` / `10.0.0` / `192.168.31`（小米路由）/ `192.168.2` / `172.20.10`（iPhone 热点）。每段 254 个地址，96 并发、1.2 秒超时，命中即停。

**已配置过的地址所在网段永远排第一**，所以手动填过一次之后再点自动发现基本是秒中。命中不了就手动填 —— 这也是把信令服务部署到公网时的用法，直接填 `wss://signal.example.com` 即可，扩展不会去扫。

## Docker 下的一个行为差异

`compose.yaml` 默认用端口映射，这在 Docker Desktop（macOS / Windows）下会让所有客户端的来源 IP 都变成网关地址，于是全都落进同一个默认房间。对局域网工具来说这行为可以接受。要精确按网段隔离，就在 Linux 上改用 `network_mode: host`（`compose.yaml` 里有注释），或者让大家填同一个群组码。

## 匿名性的边界

说清楚而不是含糊过去：

- 服务器**必然**看得到你的 IP —— TCP 连接本身就带着它。它看不到你是谁、说了什么、传了什么。
- 同一房间内的对端会通过 ICE 候选看到你的局域网 IP。这是 P2P 直连的固有代价。
- DataChannel 由 DTLS 加密，但没有做端到端身份验证，同一房间内不防主动的中间人。局域网内的临时协作够用，别拿它传机密。

## 已经砍掉的东西

- **没有历史记录持久化**：消息只在内存里留最近 200 条，扩展重载即清空。要留档再加 IndexedDB。
- **没有断点续传 / 秒传**：文件整个读进内存再发。几百 MB 没问题，要传 GB 级才需要改成流式分片。
- **没有 SFU**：房间不限人数，但客户端是全网状，连接数 O(n²)。几十人以内没问题，上百人需要改成星型转发。
