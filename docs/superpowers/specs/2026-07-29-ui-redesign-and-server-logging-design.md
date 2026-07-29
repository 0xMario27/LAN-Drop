# UI 重设计 + 信令服务日志增强

日期：2026-07-29
状态：已确认，待实现

## 目标

1. 重新设计 Chrome 扩展弹窗 UI：简洁、扁平化，使用内联 SVG 图标，去掉所有 emoji。
2. 增强信令服务日志：结构化、带时间戳与级别标签，覆盖连接、join/leave、信令转发、房间生命周期与错误。

## 非目标

- 不改变现有交互逻辑与协议。
- 不引入前端依赖或构建步骤（保持 tsc only）。
- 不做手动主题开关（仅跟随系统暗色）。
- 不改扩展功能集合。

## 方案

实现方案 A：样式刷新 + 内联 SVG。保留现有 HTML 结构与交互，重写 CSS，CSS 变量驱动浅/暗双主题，所有 emoji 换成内联 SVG。零新依赖。

## UI 设计

### 主题

CSS 变量驱动；`@media (prefers-color-scheme: dark)` 自动切换，无手动开关。

| token | 浅色 | 暗色 |
|---|---|---|
| --bg | `#ffffff` | `#1b1d21` |
| --surface | `#f7f8fa` | `#25272c` |
| --text | `#1f2329` | `#e6e8eb` |
| --text-muted | `#8a909a` | `#9aa0a6` |
| --accent | `#4f46e5` | `#818cf8` |
| --accent-soft | `#eef2ff` | `#2a2d4a` |
| --border | `#e8eaed` | `#34363b` |
| --bubble-in | `#f1f3f5` | `#2c2f35` |
| --ok / --warn / --err | `#22c55e` / `#f59e0b` / `#9ca3af` | 同 |

### 扁平化原则

- 1px 细边框 + 极轻阴影（`0 1px 2px rgba(0,0,0,.04)`）替代重投影。
- 圆角：卡片 8px，控件 6px。
- 间距尺：4 / 8 / 12 / 16。
- 系统字体栈：`-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`。

### 图标（内联 SVG，stroke 风格，16–18px）

| 用途 | 替换的 emoji | 位置 |
|---|---|---|
| 设置 | ⚙ | header 齿轮按钮 |
| 自动发现 | 🔍 | 设置面板扫描按钮 |
| 发文件 | 📎 | footer 回形针按钮 |
| 接收方向 | ⬇ | 传输行 |
| 发送方向 | ⬆ | 传输行 |
| 警告 | ⚠️ | 系统消息（去 emoji，改样式） |
| 发送 | — | footer 发送按钮（纸飞机） |

状态点保持纯色圆点，不用图标。系统消息（"已接收文件…"、"正在发送…"、"发给 X 失败…"）去掉 emoji，改为居中、`--text-muted`、小字号的系统消息样式。

### 布局

- header：状态点 + 昵称（strong）+ 房间徽标（小药丸）+ 齿轮图标按钮（右）。
- 设置面板（可折叠）：信令地址行（input + 扫描图标按钮）、扫描状态、昵称、群组码、连接/断开按钮行、说明小字。
- 在线成员：标题 + 计数；列表项含就绪圆点 + 昵称。
- 消息流：气泡。自己右对齐 `--accent` 软底；他人左对齐 `--bubble-in`。系统消息居中淡化。每条带昵称 + 时间。
- 传输区：图标 + 文件名 · 对端 · 进度文本 + 进度条；完成 4s 后淡出。
- footer：目标选择 + 多行文本框 + 回形针图标按钮 + 发送按钮（图标 + 文字）。

### 改动文件

- `extension/popup.css`：重写。
- `extension/popup.html`：微调结构 + 注入内联 SVG（设置/扫描/回形针/发送按钮）。
- `src/popup.ts`：
  - `renderTransfer` 改为 SVG 图标 + 文本节点（不再用 textContent 拼 emoji）。
  - 系统消息样式：新增 `msg-system` class，渲染时区分。
- `src/offscreen.ts`：
  - `note`/`addMessage` 调用中的 emoji（📎⚠️）去掉，纯文本。

### 系统消息渲染细节

`addMessage` 产出的系统消息（文件接收/发送/失败提示）目前与普通消息同渲染。改为：这些消息文本不带 emoji；在 `popup.ts` 的 `renderMessage` 中，若消息来自 self 且为系统提示，可加 `msg-system` 样式。简化方案：所有 self 发出的 `note` 一律走 `msg-system` 居中淡化样式。判定方式：offscreen 的 `note()` 走 `addMessage(text, self, true)`，与用户主动发送的文本（也 `self=true`）无法区分。

为避免误判，给 `ChatMessage` 增加可选 `system?: boolean` 字段；`note()` 设 `system: true`，`sendText` 不设。`renderMessage` 据 `system` 加 `msg-system` class。这是 protocol.ts 的唯一改动（纯类型，零运行时影响）。

## 信令日志设计

### Logger

`server/signal.ts` 新增零依赖 logger，仅 `console`：

```ts
function ts(): string { return new Date().toISOString(); }
function log(level: 'INFO' | 'WARN' | 'ERROR', msg: string): void {
  console.log(`[${ts()}] ${level.padEnd(5)} ${msg}`);
}
```

### 事件覆盖

| 事件 | 级别 | 内容 |
|---|---|---|
| 启动监听 | INFO | `监听 ws://0.0.0.0:${port}` |
| 新连接 | INFO | `连接 ${ip}` |
| join 成功 | INFO | `join id=${id} 房间=${roomKey.slice(0,8)} 人数=${room.size} 昵称=${name}` |
| 新建房间 | INFO | `新建房间 ${roomKey.slice(0,8)}` |
| 信令转发 | INFO | `relay ${sdp?'SDP':'ICE'} ${from} -> ${to}` |
| leave | INFO | `leave id=${id} 房间=${roomKey.slice(0,8)} 人数=${room.size}` |
| 空房间销毁 | INFO | `空房间销毁 ${roomKey.slice(0,8)}` |
| 连接关闭 | INFO | `断开 ${ip}` |
| 连接错误 | WARN | `连接错误 ${ip}` |
| 错误帧（拒绝加入/id 冲突等） | WARN | `拒绝：${message} ip=${ip}` |

房间号只打印 SHA-256 前 8 位避免刷屏。ip 取 `req.socket.remoteAddress`（去 `::ffff:` 前缀）。每条信令转发都打日志（LAN 规模可接受）。

### 改动文件

- `server/signal.ts`：新增 logger + 在 connection/join/relay/leave/close/error 各处插点。

## 验证

- `make typecheck`：扩展（DOM + @types/chrome）与服务端两套配置均通过。
- `make test`：服务端现有测试（房间隔离、信令转发、网段归组、40 人容量）仍通过；日志为纯副作用，不改变行为。
- 手动：加载扩展，确认浅/暗主题切换、图标显示、无 emoji 残留、消息气泡与传输进度正常。
- 手动：`make serve` 启动信令服务，扩展连接后观察日志覆盖连接/join/relay/leave。

## 风险

- `ChatMessage.system` 字段：protocol.ts 纯类型改动，需确保 offscreen `snapshot()` 与 popup `renderMessage` 同步处理。回归面小。
- 暗色主题仅靠媒体查询，用户系统未开暗色时看不到-符合预期。
- 日志量：每条 relay 一行，全网状多人房间下 IO 增多，但 LAN 规模无性能问题。
