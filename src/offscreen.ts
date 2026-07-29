// 核心：信令 WebSocket + 全网状 RTCPeerConnection + DataChannel 收发。
// 跑在 offscreen 文档里，弹窗关掉也不会断线。

import { candidates, discover, portFrom, subnetsToScan } from './discover.js';
import type {
  AppState,
  ChannelFrame,
  ChatMessage,
  ClientFrame,
  Config,
  Discovery,
  LogEntry,
  Reply,
  OffscreenMessage,
  OutgoingFile,
  PopupMessage,
  ServerFrame,
  SignalPayload,
  Status,
  SwMessage,
  Transfer,
} from './protocol.js';

const CHUNK = 16 * 1024;
const MAX_BUFFER = 1 << 20; // 1 MiB 背压水位
const MAX_MESSAGES = 200;
const MAX_LOGS = 40;
const RECONNECT_MS = 3000;
const DEFAULT_URL = 'ws://localhost:8787';

// ponytail: iceServers 留空 —— 不连 STUN，既省事又保证只能在同一局域网内打通。
// 要跨 NAT 就在这里加 STUN/TURN，但那已经不是"局域网工具"了。
const RTC_CONFIG: RTCConfiguration = { iceServers: [] };

interface Incoming {
  fid: string;
  name: string;
  mime: string;
  chunks: ArrayBuffer[];
  received: number;
}

interface Peer {
  id: string;
  name: string;
  pc: RTCPeerConnection;
  ch: RTCDataChannel | null;
  ready: boolean;
  /** 每个对端一条串行发送队列，避免多文件的二进制帧交错 */
  queue: Promise<void>;
  incoming: Incoming | null;
}

const selfId = crypto.randomUUID().slice(0, 8);

const state = {
  cfg: { url: DEFAULT_URL, name: '', room: '' } as Config,
  selfName: '',
  status: 'disconnected' as Status,
  error: '',
  peers: new Map<string, Peer>(),
  messages: [] as ChatMessage[],
  transfers: new Map<string, Transfer>(),
  logs: [] as LogEntry[],
};

/** 诊断日志。连不上时这是唯一能看清卡在哪一步的东西，所以关键路径都要记。 */
function log(text: string): void {
  const entry: LogEntry = { ts: Date.now(), text };
  state.logs.push(entry);
  if (state.logs.length > MAX_LOGS) state.logs.splice(0, state.logs.length - MAX_LOGS);
  console.info('[LAN Drop]', text);
}

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

/* ---------- 与 popup 通信 ---------- */

/**
 * offscreen 文档只有 chrome.runtime 可用，其余扩展 API 全部委托 service worker。
 * 直接在这里调 chrome.storage / chrome.downloads 会拿到 undefined。
 */
async function toSw<T>(msg: SwMessage): Promise<T> {
  const res = (await chrome.runtime.sendMessage(msg)) as Reply<T> | undefined;
  if (!res?.ok) throw new Error(res?.error ?? 'service worker 无响应');
  return res.data;
}

function emit(msg: Omit<PopupMessage, 'target'>): void {
  void chrome.runtime.sendMessage({ target: 'popup', ...msg }).catch(() => {
    /* 弹窗没开，忽略 */
  });
}

function snapshot(): AppState {
  return {
    self: { id: selfId, name: state.selfName },
    cfg: state.cfg,
    status: state.status,
    error: state.error,
    peers: [...state.peers.values()].map((p) => ({ id: p.id, name: p.name, ready: p.ready })),
    messages: state.messages,
    transfers: [...state.transfers.values()],
    logs: state.logs,
  };
}

function pushState(): void {
  emit({ event: 'state', payload: snapshot() });
}

function addMessage(text: string, from: { id: string; name: string }, self: boolean): void {
  const msg: ChatMessage = { id: crypto.randomUUID(), from: from.id, name: from.name, text, ts: Date.now(), self };
  state.messages.push(msg);
  if (state.messages.length > MAX_MESSAGES) {
    state.messages.splice(0, state.messages.length - MAX_MESSAGES);
  }
  emit({ event: 'message', payload: msg });
}

function note(text: string): void {
  addMessage(text, { id: selfId, name: state.selfName }, true);
}

function setStatus(status: Status, error = ''): void {
  state.status = status;
  state.error = error;
  pushState();
}

/* ---------- 配置 ---------- */

const anonName = (): string => `匿名-${selfId.slice(0, 4)}`;

/** @returns 用户此前是否已配置过地址 */
async function loadConfig(): Promise<boolean> {
  let stored: Partial<Config> | null = null;
  try {
    stored = await toSw<Partial<Config> | null>({ target: 'sw', t: 'get-config' });
  } catch (e) {
    // 读不到就用默认值继续跑，但要让用户看见原因，别静默降级
    state.error = `读取配置失败：${(e as Error).message}`;
  }

  state.cfg = { url: DEFAULT_URL, name: '', room: '', ...stored };
  state.selfName = state.cfg.name.trim() || anonName();
  return Boolean(stored?.url);
}

async function saveConfig(patch: Partial<Config>): Promise<void> {
  state.cfg = { ...state.cfg, ...patch };
  state.selfName = state.cfg.name.trim() || anonName();
  await toSw({ target: 'sw', t: 'set-config', cfg: state.cfg });
}

/* ---------- 自动发现信令服务 ---------- */

let scanning = false;

function reportDiscovery(patch: Partial<Discovery>): void {
  emit({
    event: 'discovery',
    payload: { scanning, scanned: 0, total: 0, found: null, error: '', ...patch },
  });
}

/**
 * 扫本机所在网段，找出跑着信令服务的地址。
 * 手动填的地址（含公网 wss://）永远优先 —— 这里只在用户主动点击或首次启动时跑。
 */
async function runDiscovery(): Promise<string | null> {
  if (scanning) throw new Error('正在扫描中');
  scanning = true;
  reportDiscovery({ scanning: true });

  try {
    const subnets = subnetsToScan(state.cfg.url);
    const port = portFrom(state.cfg.url);
    const urls = candidates(subnets, port);
    log(`开始扫描 ${subnets.join(', ')} 的 :${port}（共 ${urls.length} 个地址）`);

    const found = await discover(urls, (p) => reportDiscovery({ scanning: true, ...p }));
    log(found ? `扫描命中 ${found}` : '扫描结束，没找到信令服务');
    if (found) await saveConfig({ url: found });

    reportDiscovery({ scanning: false, found, total: urls.length, scanned: urls.length });
    return found;
  } catch (e) {
    log(`扫描失败：${(e as Error).message}`);
    reportDiscovery({ scanning: false, error: (e as Error).message });
    throw e;
  } finally {
    scanning = false;
  }
}

async function sha256hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------- 信令 ---------- */

function teardown(): void {
  for (const peer of state.peers.values()) peer.pc.close();
  state.peers.clear();
}

function closeSocket(): void {
  if (!ws) return;
  ws.onclose = null;
  ws.close();
  ws = null;
}

function send(frame: ClientFrame): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

async function connect(): Promise<void> {
  clearTimeout(reconnectTimer);
  closeSocket();
  teardown();
  setStatus('connecting');

  let socket: WebSocket;
  try {
    socket = new WebSocket(state.cfg.url);
  } catch (e) {
    setStatus('disconnected', `信令地址无效：${(e as Error).message}`);
    return;
  }
  ws = socket;
  log(`正在连接 ${state.cfg.url}`);

  socket.onopen = () => {
    log('WebSocket 已握手，发送 join');
    // 群组名本地哈希后再发，服务器看不到明文群名
    const code = state.cfg.room.trim();
    void (code ? sha256hex(code) : Promise.resolve(null)).then((room) =>
      send({ t: 'join', room, id: selfId, name: state.selfName })
    );
  };

  socket.onmessage = (e: MessageEvent<string>) => {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(e.data) as ServerFrame;
    } catch {
      return; // 非法帧直接丢弃
    }
    void handleSignal(frame).catch((err: unknown) => console.warn('[LAN Drop] signal error', err));
  };

  socket.onerror = () => {
    log(`连接 ${state.cfg.url} 失败`);
    setStatus('connecting', `连不上 ${state.cfg.url}，确认信令服务已启动且地址可达`);
  };

  socket.onclose = (e) => {
    if (ws !== socket) return;
    ws = null;
    teardown();
    log(`连接关闭（code=${e.code}），${RECONNECT_MS / 1000} 秒后重试`);
    setStatus('disconnected', state.error || '连接已断开，正在重试…');
    reconnectTimer = setTimeout(() => void connect(), RECONNECT_MS);
  };
}

function disconnect(): void {
  clearTimeout(reconnectTimer);
  closeSocket();
  teardown();
  setStatus('disconnected');
}

async function handleSignal(frame: ServerFrame): Promise<void> {
  switch (frame.t) {
    case 'joined':
      log(`已加入房间，房内已有 ${frame.peers.length} 人`);
      setStatus('connected');
      // 后进者主动发 offer，天然避免 glare，不需要 perfect negotiation
      for (const p of frame.peers) await createPeer(p.id, p.name, true);
      break;

    case 'peer-join':
      await createPeer(frame.id, frame.name, false);
      break;

    case 'peer-leave':
      dropPeer(frame.id);
      break;

    case 'signal':
      await onPeerSignal(frame.from, frame.data);
      break;

    case 'error':
      setStatus('disconnected', frame.message);
      break;
  }
}

/* ---------- WebRTC ---------- */

async function createPeer(id: string, name: string, initiator: boolean): Promise<Peer> {
  const existing = state.peers.get(id);
  if (existing) return existing;

  const pc = new RTCPeerConnection(RTC_CONFIG);
  const peer: Peer = {
    id,
    name: name || '匿名',
    pc,
    ch: null,
    ready: false,
    queue: Promise.resolve(),
    incoming: null,
  };
  state.peers.set(id, peer);

  pc.onicecandidate = (e) => {
    if (e.candidate) send({ t: 'signal', to: id, data: { ice: e.candidate.toJSON() } });
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') dropPeer(id);
  };

  if (initiator) {
    wireChannel(peer, pc.createDataChannel('lan-drop'));
    await pc.setLocalDescription(await pc.createOffer());
    if (pc.localDescription) send({ t: 'signal', to: id, data: { sdp: pc.localDescription.toJSON() } });
  } else {
    pc.ondatachannel = (e) => wireChannel(peer, e.channel);
  }

  pushState();
  return peer;
}

function dropPeer(id: string): void {
  const peer = state.peers.get(id);
  if (!peer) return;
  peer.pc.close();
  state.peers.delete(id);
  pushState();
}

async function onPeerSignal(from: string, data: SignalPayload): Promise<void> {
  const peer = state.peers.get(from) ?? (await createPeer(from, '', false));
  const pc = peer.pc;

  if (data.sdp) {
    await pc.setRemoteDescription(data.sdp);
    if (data.sdp.type === 'offer') {
      await pc.setLocalDescription(await pc.createAnswer());
      if (pc.localDescription) send({ t: 'signal', to: from, data: { sdp: pc.localDescription.toJSON() } });
    }
    return;
  }

  try {
    await pc.addIceCandidate(data.ice);
  } catch (e) {
    console.warn('[LAN Drop] addIceCandidate failed', e);
  }
}

/* ---------- DataChannel 协议 ---------- */

function post(ch: RTCDataChannel, frame: ChannelFrame): void {
  ch.send(JSON.stringify(frame));
}

function wireChannel(peer: Peer, ch: RTCDataChannel): void {
  peer.ch = ch;
  ch.binaryType = 'arraybuffer';
  ch.bufferedAmountLowThreshold = MAX_BUFFER / 2;

  ch.onopen = () => {
    peer.ready = true;
    post(ch, { t: 'hello', name: state.selfName });
    pushState();
  };
  ch.onclose = () => {
    peer.ready = false;
    pushState();
  };
  ch.onerror = (e) => console.warn('[LAN Drop] channel error', e);
  ch.onmessage = (e: MessageEvent<string | ArrayBuffer>) => {
    if (typeof e.data !== 'string') return onFileChunk(peer, e.data);

    let frame: ChannelFrame;
    try {
      frame = JSON.parse(e.data) as ChannelFrame;
    } catch {
      return;
    }
    onChannelFrame(peer, frame);
  };
}

function onChannelFrame(peer: Peer, frame: ChannelFrame): void {
  switch (frame.t) {
    case 'hello':
      peer.name = String(frame.name ?? '').slice(0, 32) || peer.name;
      pushState();
      break;

    case 'msg':
      addMessage(String(frame.text ?? '').slice(0, 4000), peer, false);
      break;

    case 'file-meta':
      startIncoming(peer, frame);
      break;

    case 'file-end':
      finishIncoming(peer, frame.fid);
      break;
  }
}

/* ---------- 接收文件 ---------- */

function startIncoming(peer: Peer, meta: Extract<ChannelFrame, { t: 'file-meta' }>): void {
  const size = Number(meta.size);
  if (!meta.fid || !Number.isFinite(size) || size < 0) return;

  // 对端发来的文件名不可信：去掉路径分隔符，防止写到下载目录之外
  const name = String(meta.name || 'file')
    .replace(/[/\\]/g, '_')
    .slice(0, 120);

  peer.incoming = {
    fid: meta.fid,
    name,
    mime: String(meta.mime || 'application/octet-stream'),
    chunks: [],
    received: 0,
  };
  state.transfers.set(meta.fid, { fid: meta.fid, name, size, received: 0, dir: 'in', peer: peer.name, done: false });
  pushState();
}

function onFileChunk(peer: Peer, buf: ArrayBuffer): void {
  const inc = peer.incoming;
  if (!inc) return; // 没有 file-meta 的裸二进制，丢弃

  inc.chunks.push(buf);
  inc.received += buf.byteLength;

  const t = state.transfers.get(inc.fid);
  if (t) {
    t.received = inc.received;
    emit({ event: 'transfer', payload: t });
  }
}

function finishIncoming(peer: Peer, fid: string): void {
  const inc = peer.incoming;
  if (!inc || inc.fid !== fid) return;
  peer.incoming = null;

  const blob = new Blob(inc.chunks, { type: inc.mime });
  void toSw({ target: 'sw', t: 'download', url: URL.createObjectURL(blob), filename: inc.name }).catch((e: unknown) =>
    note(`⚠️ 保存 ${inc.name} 失败：${(e as Error).message}`)
  );

  const t = state.transfers.get(fid);
  if (t) {
    t.received = blob.size;
    t.done = true;
    emit({ event: 'transfer', payload: t });
  }
  addMessage(`📎 已接收文件：${inc.name}（${formatBytes(blob.size)}）`, peer, false);
}

/* ---------- 发送 ---------- */

function targets(to: string): Peer[] {
  const ready = [...state.peers.values()].filter((p) => p.ready && p.ch);
  return to && to !== 'all' ? ready.filter((p) => p.id === to) : ready;
}

function sendText(text: string, to: string): void {
  const clean = text.slice(0, 4000);
  if (!clean.trim()) throw new Error('消息为空');

  for (const peer of targets(to)) post(peer.ch as RTCDataChannel, { t: 'msg', text: clean });
  addMessage(clean, { id: selfId, name: state.selfName }, true);
}

function untilLowBuffer(ch: RTCDataChannel): Promise<void> {
  return new Promise((resolve) => ch.addEventListener('bufferedamountlow', () => resolve(), { once: true }));
}

async function sendFileTo(peer: Peer, meta: { name: string; type: string }, bytes: ArrayBuffer): Promise<void> {
  const ch = peer.ch;
  if (!ch) throw new Error('通道未就绪');

  const fid = crypto.randomUUID();
  const size = bytes.byteLength;
  post(ch, { t: 'file-meta', fid, name: meta.name, size, mime: meta.type });

  const record: Transfer = { fid, name: meta.name, size, received: 0, dir: 'out', peer: peer.name, done: false };
  state.transfers.set(fid, record);
  pushState();

  for (let offset = 0; offset < size; offset += CHUNK) {
    if (ch.readyState !== 'open') throw new Error('连接已断开');
    if (ch.bufferedAmount > MAX_BUFFER) await untilLowBuffer(ch);
    ch.send(bytes.slice(offset, offset + CHUNK));
    record.received = Math.min(offset + CHUNK, size);
    emit({ event: 'transfer', payload: record });
  }

  post(ch, { t: 'file-end', fid });
  record.done = true;
  emit({ event: 'transfer', payload: record });
}

// popup 传来的是 blob URL —— 扩展消息只走 JSON 序列化，ArrayBuffer 传不过去。
// ponytail: 整个文件读进内存。局域网传几百 MB 没问题，要传 GB 级才需要改成流式分片。
async function sendFile(file: OutgoingFile, to: string): Promise<void> {
  const list = targets(to);
  if (!list.length) throw new Error('没有已连接的对端');

  const bytes = await fetch(file.url).then((r) => r.arrayBuffer());

  for (const peer of list) {
    peer.queue = peer.queue
      .then(() => sendFileTo(peer, file, bytes))
      .catch((e: unknown) => note(`⚠️ 发给 ${peer.name} 失败：${(e as Error).message}`));
  }

  note(`📎 正在发送：${file.name}（${formatBytes(bytes.byteLength)}）→ ${list.length} 个对端`);
}

function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

/* ---------- 弹窗指令入口 ---------- */

async function runCommand(msg: OffscreenMessage): Promise<unknown> {
  switch (msg.t) {
    case 'get-state':
      return snapshot();
    case 'connect':
      await saveConfig(msg.cfg);
      await connect();
      return snapshot();
    case 'disconnect':
      disconnect();
      return snapshot();
    case 'discover':
      await runDiscovery();
      return snapshot();
    case 'send-text':
      sendText(msg.text, msg.to);
      return { ok: true };
    case 'send-file':
      await sendFile(msg.file, msg.to);
      return { ok: true };
  }
}

chrome.runtime.onMessage.addListener((raw: unknown, _sender, reply) => {
  const msg = raw as OffscreenMessage;
  if (msg?.target !== 'offscreen') return undefined;

  runCommand(msg).then(
    (data) => reply({ ok: true, data }),
    (e: unknown) => reply({ ok: false, error: (e as Error).message })
  );
  return true; // 异步回复
});

void (async () => {
  log('offscreen 启动');
  const configured = await loadConfig();
  log(configured ? `读到已保存的地址 ${state.cfg.url}` : '没有已保存的地址，准备自动发现');
  pushState();

  // 已配置过就直接连；只有首次启动才扫一轮，免得每次开扩展都扫局域网。
  if (configured) {
    await connect();
    return;
  }

  const found = await runDiscovery().catch(() => null);
  if (found) await connect();
})();
