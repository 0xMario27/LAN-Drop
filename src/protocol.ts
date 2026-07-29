// 全部线上协议的唯一定义处：扩展和信令服务器都从这里 import type。
// 纯类型文件 —— 编译后不产生任何 JS，所以引用它的地方一律用 `import type`。

/* ---------- 信令（扩展 ↔ 服务器，JSON over WebSocket） ---------- */

/** 不透明的 WebRTC 协商载荷；服务器只转发，不解析。 */
export type SignalPayload =
  | { sdp: RTCSessionDescriptionInit; ice?: never }
  | { ice: RTCIceCandidateInit; sdp?: never };

export interface PeerInfo {
  id: string;
  name: string;
  /** base64 的 X25519 公钥；旧版无此字段 = 未认证 */
  pubkey?: string;
}

export type ClientFrame =
  | { t: 'join'; room: string | null; id: string; name: string; pubkey: string }
  | { t: 'signal'; to: string; data: SignalPayload }
  | { t: 'ping' };

export type ServerFrame =
  | { t: 'joined'; room: string; peers: PeerInfo[] }
  | { t: 'peer-join'; id: string; name: string; pubkey: string }
  | { t: 'peer-leave'; id: string }
  | { t: 'signal'; from: string; data: SignalPayload }
  | { t: 'error'; message: string }
  | { t: 'pong' };

/* ---------- DataChannel（对端 ↔ 对端） ---------- */

/** 字符串帧是控制信息，二进制帧一律是当前 file-meta 所属文件的分片。 */
export type ChannelFrame =
  | { t: 'hello'; name: string }
  | { t: 'msg'; text: string; dm?: true }
  | { t: 'file-meta'; fid: string; name: string; size: number; mime: string }
  | { t: 'file-end'; fid: string };

/* ---------- 应用状态（offscreen → popup） ---------- */

export type Status = 'disconnected' | 'connecting' | 'connected';

export interface Config {
  url: string;
  name: string;
  room: string;
}

export type TrustLevel = 'tofu' | 'verified';

export interface TrustState {
  level: TrustLevel;
  fingerprint: string;
  /** 指纹与首次不符时为 true（密钥变更警告） */
  changed: boolean;
}

export interface PeerView extends PeerInfo {
  ready: boolean;
  /** 已认证对端的信任状态；未认证（无 pubkey）为 undefined */
  trust?: TrustState;
}

export interface ChatMessage {
  id: string;
  from: string;
  name: string;
  text: string;
  /** Unix 毫秒 */
  ts: number;
  self: boolean;
  system?: boolean;
  /** 私信标记：self 消息时 = 收件人名称；接收消息时 = 'dm' */
  to?: string;
  /** 文件卡片消息（dir=in 有下载按钮，dir=out 只展示） */
  file?: { fid: string; name: string; size: number; dir: 'in' | 'out' };
}

export interface Transfer {
  fid: string;
  name: string;
  size: number;
  received: number;
  dir: 'in' | 'out';
  peer: string;
  done: boolean;
}

/** 诊断日志：出问题时唯一能看清卡在哪一步的东西。 */
export interface LogEntry {
  /** Unix 毫秒 */
  ts: number;
  text: string;
}

export interface AppState {
  self: PeerInfo;
  cfg: Config;
  status: Status;
  error: string;
  peers: PeerView[];
  messages: ChatMessage[];
  transfers: Transfer[];
  logs: LogEntry[];
}

/* ---------- 扩展内部消息（popup ↔ service worker ↔ offscreen） ---------- */

export interface OutgoingFile {
  name: string;
  type: string;
  /** popup 建的 blob URL —— 扩展消息只走 JSON，ArrayBuffer 传不过去 */
  url: string;
}

export type PopupCommand =
  | { t: 'get-state' }
  | { t: 'connect'; cfg: Partial<Config> }
  | { t: 'disconnect' }
  | { t: 'discover' }
  | { t: 'send-text'; text: string; to: string }
  | { t: 'send-file'; file: OutgoingFile; to: string }
  | { t: 'download-received'; fid: string }
  | { t: 'set-visible'; visible: boolean };

export type OffscreenMessage = { target: 'offscreen' } & PopupCommand;

/**
 * offscreen 文档只能用 chrome.runtime，其余扩展 API 一律经 service worker 代办。
 * 新增任何需要 chrome.* 的能力时，都走这里，别直接在 offscreen 里调。
 */
export type SwMessage = { target: 'sw' } & (
  | { t: 'ensure' }
  | { t: 'get-config' }
  | { t: 'set-config'; cfg: Config }
  | { t: 'download'; url: string; filename: string }
  | { t: 'get-identity' }
  | { t: 'set-identity'; blob: string }
  | { t: 'get-trusted-peer'; peerId: string }
  | { t: 'set-trusted-peer'; peerId: string; pubkey: string; level: TrustLevel }
  | { t: 'notify'; title: string }
);

/** 自动发现的实时进度；找到或扫完时 done 为 true。 */
export interface Discovery {
  scanning: boolean;
  scanned: number;
  total: number;
  found: string | null;
  error: string;
}

export type PopupMessage = { target: 'popup' } & (
  | { event: 'state'; payload: AppState }
  | { event: 'message'; payload: ChatMessage }
  | { event: 'transfer'; payload: Transfer }
  | { event: 'discovery'; payload: Discovery }
);

export type Reply<T> = { ok: true; data: T } | { ok: false; error: string };
