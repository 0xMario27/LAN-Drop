// 核心：信令 WebSocket + 全网状 RTCPeerConnection + DataChannel 收发。
// 跑在 offscreen 文档里，弹窗关掉也不会断线。

import { candidates, discover, portFrom, subnetsToScan } from './discover.js';
import { generateIdentity, serializeIdentity, deserializeIdentity, derivePeerId, fingerprint, type Identity } from './identity.js';
import { initiatorHandshake, responderHandshake, type HandshakeResult } from './noise.js';
import { SecureChannel, packFrame, unpackFrame, CTRL_PREFIX } from './secure-channel.js';
import { fromBase64, toBase64 } from './crypto-primitives.js';
import type {
  AppState,
  ChannelFrame,
  ChatMessage,
  ClientFrame,
  Config,
  Discovery,
  LogEntry,
  PeerView,
  Reply,
  OffscreenMessage,
  OutgoingFile,
  PopupMessage,
  ServerFrame,
  SignalPayload,
  Status,
  SwMessage,
  TrustState,
  Transfer,
} from './protocol.js';

const CHUNK = 16 * 1024;
const MAX_BUFFER = 1 << 20; // 1 MiB 背压水位
const MAX_MESSAGES = 200;
const MAX_LOGS = 40;
const MAX_RECEIVED = 20;

interface ReceivedFile {
  blob: Blob;
  name: string;
}
const RECONNECT_MS = 3000;
const DEFAULT_URL = 'ws://localhost:8787';

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
  pubkey: string; // base64，从信令帧拿到
  pc: RTCPeerConnection;
  ch: RTCDataChannel | null;
  ready: boolean;
  handshaking: boolean;
  channel: SecureChannel | null; // 握手成功后创建
  /** 握手期间暂存收到的消息（等 handshake recv 调用） */
  handshakeQueue: Uint8Array[];
  handshakeResolve: ((msg: Uint8Array) => void) | null;
  /** 每个对端一条串行发送队列，避免多文件的二进制帧交错 */
  queue: Promise<void>;
  incoming: Incoming | null;
  trust: TrustState | undefined;
}

let selfId = '--------'; // 握手前占位，loadIdentity 后替换为 peerId
let myIdentity: Identity | null = null;

/** 已知的对端 pubkey（从信令帧拿到，握手时用） */
const knownPubkeys = new Map<string, string>();

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

/** 已接收但尚未下载的文件（blob 留在内存里等用户点击下载按钮） */
const receivedFiles = new Map<string, ReceivedFile>();

/** 诊断日志。连不上时这是唯一能看清卡在哪一步的东西，所以关键路径都要记。 */
function log(text: string): void {
  const entry: LogEntry = { ts: Date.now(), text };
  state.logs.push(entry);
  if (state.logs.length > MAX_LOGS) state.logs.splice(0, state.logs.length - MAX_LOGS);
  console.info('[LAN Drop]', text);
}

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let pongTimer: ReturnType<typeof setTimeout> | undefined;
let popupVisible = true;

const HEARTBEAT_MS = 30000;
const PONG_TIMEOUT_MS = 10000;

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

/* ---------- 身份 ---------- */

async function loadIdentity(): Promise<Identity> {
  const stored = await toSw<string | null>({ target: 'sw', t: 'get-identity' });
  if (stored) {
    const id = deserializeIdentity(stored);
    selfId = id.peerId;
    return id;
  }
  const id = generateIdentity();
  selfId = id.peerId;
  await toSw({ target: 'sw', t: 'set-identity', blob: serializeIdentity(id) });
  return id;
}

/** TOFU：查 / 存 trusted peer，返回信任状态 */
async function checkAndSaveTrust(peerId: string, pubkey: Uint8Array): Promise<TrustState> {
  const fp = fingerprint(pubkey);
  const pubkeyB64 = toBase64(pubkey);
  const stored = await toSw<{ pubkey: string; level: 'tofu' | 'verified'; firstSeen: number } | null>(
    { target: 'sw', t: 'get-trusted-peer', peerId }
  );

  if (!stored) {
    // 首次见到：TOFU 存储
    await toSw({ target: 'sw', t: 'set-trusted-peer', peerId, pubkey: pubkeyB64, level: 'tofu' });
    return { level: 'tofu', fingerprint: fp, changed: false };
  }

  if (stored.pubkey !== pubkeyB64) {
    // 指纹变更：密钥换了，警告但不自动更新
    return { level: stored.level, fingerprint: fp, changed: true };
  }

  return { level: stored.level, fingerprint: fp, changed: false };
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
    peers: [...state.peers.values()].map((p): PeerView => ({
      id: p.id,
      name: p.name,
      pubkey: p.pubkey || undefined,
      ready: p.ready,
      trust: p.trust,
    })),
    messages: state.messages,
    transfers: [...state.transfers.values()],
    logs: state.logs,
  };
}

function pushState(): void {
  emit({ event: 'state', payload: snapshot() });
}

function addMessage(text: string, from: { id: string; name: string }, self: boolean, system = false): void {
  const msg: ChatMessage = { id: crypto.randomUUID(), from: from.id, name: from.name, text, ts: Date.now(), self, system };
  state.messages.push(msg);
  if (state.messages.length > MAX_MESSAGES) {
    state.messages.splice(0, state.messages.length - MAX_MESSAGES);
  }
  emit({ event: 'message', payload: msg });
}

function note(text: string): void {
  addMessage(text, { id: selfId, name: state.selfName }, true, true);
}

function addFileMessage(from: { id: string; name: string }, fid: string, filename: string, size: number): void {
  const msg: ChatMessage = {
    id: crypto.randomUUID(),
    from: from.id,
    name: from.name,
    text: filename,
    ts: Date.now(),
    self: false,
    file: { fid, name: filename, size, dir: 'in' },
  };
  state.messages.push(msg);
  if (state.messages.length > MAX_MESSAGES) state.messages.splice(0, state.messages.length - MAX_MESSAGES);
  emit({ event: 'message', payload: msg });
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

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      send({ t: 'ping' });
      pongTimer = setTimeout(() => {
        log('心跳超时，主动断开重连');
        ws?.close();
      }, PONG_TIMEOUT_MS);
    }
  }, HEARTBEAT_MS);
}

function stopHeartbeat(): void {
  clearInterval(heartbeatTimer);
  clearTimeout(pongTimer);
  heartbeatTimer = undefined;
  pongTimer = undefined;
}

function teardown(): void {
  for (const peer of state.peers.values()) peer.pc.close();
  state.peers.clear();
}

function closeSocket(): void {
  stopHeartbeat();
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
    startHeartbeat();
    const code = state.cfg.room.trim();
    void (code ? sha256hex(code) : Promise.resolve(null)).then((room) =>
      send({ t: 'join', room, id: selfId, name: state.selfName, pubkey: myIdentity ? toBase64(myIdentity.publicKey) : '' })
    );
  };

  socket.onmessage = (e: MessageEvent<string>) => {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(e.data) as ServerFrame;
    } catch {
      return;
    }
    if (frame.t === 'pong') {
      clearTimeout(pongTimer);
      return;
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
      for (const p of frame.peers) {
        if (p.pubkey) knownPubkeys.set(p.id, p.pubkey);
        await createPeer(p.id, p.name, p.pubkey ?? '', true);
      }
      break;

    case 'peer-join':
      if (frame.pubkey) knownPubkeys.set(frame.id, frame.pubkey);
      await createPeer(frame.id, frame.name, frame.pubkey ?? '', false);
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

async function createPeer(id: string, name: string, pubkey: string, initiator: boolean): Promise<Peer> {
  const existing = state.peers.get(id);
  if (existing) return existing;

  const pc = new RTCPeerConnection(RTC_CONFIG);
  const peer: Peer = {
    id,
    name: name || '匿名',
    pubkey,
    pc,
    ch: null,
    ready: false,
    handshaking: false,
    channel: null,
    handshakeQueue: [],
    handshakeResolve: null,
    queue: Promise.resolve(),
    incoming: null,
    trust: undefined,
  };
  state.peers.set(id, peer);
  (peer as Peer & { _initiator?: boolean })._initiator = initiator;

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
  const peer = state.peers.get(from) ?? (await createPeer(from, '', knownPubkeys.get(from) ?? '', false));
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

/** 加密发送控制帧 */
function securePost(peer: Peer, frame: ChannelFrame): void {
  if (!peer.ch || !peer.channel) return;
  const plaintext = new TextEncoder().encode('\x01' + JSON.stringify(frame));
  const { nonce, ciphertext } = peer.channel.encrypt(plaintext);
  peer.ch.send(packFrame(nonce, ciphertext));
}

/** 加密发送文件分片 */
function secureSendChunk(peer: Peer, chunk: ArrayBuffer): void {
  if (!peer.ch || !peer.channel) return;
  const { nonce, ciphertext } = peer.channel.encrypt(new Uint8Array(chunk));
  peer.ch.send(packFrame(nonce, ciphertext));
}

function wireChannel(peer: Peer, ch: RTCDataChannel): void {
  peer.ch = ch;
  ch.binaryType = 'arraybuffer';
  ch.bufferedAmountLowThreshold = MAX_BUFFER / 2;

  ch.onopen = () => void runHandshake(peer);
  ch.onclose = () => {
    peer.ready = false;
    peer.channel = null;
    pushState();
  };
  ch.onerror = (e) => console.warn('[LAN Drop] channel error', e);
  ch.onmessage = (e: MessageEvent<string | ArrayBuffer>) => {
    if (typeof e.data === 'string') return; // 握手期可能有 string，忽略
    const msg = new Uint8Array(e.data as ArrayBuffer);

    // 握手期：消息进队列等 handshake recv 取走
    if (peer.handshaking) {
      if (peer.handshakeResolve) {
        peer.handshakeResolve(msg);
        peer.handshakeResolve = null;
      } else {
        peer.handshakeQueue.push(msg);
      }
      return;
    }

    // 加密期：解密后分发
    if (!peer.channel) return;
    const { nonce, ciphertext } = unpackFrame(e.data as ArrayBuffer);
    let plaintext: Uint8Array;
    try {
      plaintext = peer.channel.decrypt(nonce, ciphertext);
    } catch (e) {
      console.warn('[LAN Drop] decrypt failed', e);
      return;
    }

    if (plaintext[0] === CTRL_PREFIX) {
      let frame: ChannelFrame;
      try {
        frame = JSON.parse(new TextDecoder().decode(plaintext.slice(1))) as ChannelFrame;
      } catch {
        return;
      }
      onChannelFrame(peer, frame);
    } else {
      onFileChunk(peer, plaintext.buffer as ArrayBuffer);
    }
  };
}

/** 握手 recv：从队列取或等下一条消息 */
function handshakeRecv(peer: Peer): Promise<Uint8Array> {
  const queued = peer.handshakeQueue.shift();
  if (queued) return Promise.resolve(queued);
  return new Promise((resolve) => {
    peer.handshakeResolve = resolve;
  });
}

/** 握手 send：发原始字节 */
function handshakeSend(peer: Peer, msg: Uint8Array): void {
  peer.ch?.send(msg.buffer as ArrayBuffer);
}

async function runHandshake(peer: Peer): Promise<void> {
  if (!myIdentity || !peer.ch) return;
  peer.handshaking = true;
  log(`开始与 ${peer.id} 握手`);

  const remotePubkeyB64 = knownPubkeys.get(peer.id);
  if (!remotePubkeyB64) {
    log(`对端 ${peer.id} 无 pubkey，跳过握手（未认证模式）`);
    peer.ready = true;
    peer.handshaking = false;
    securePost(peer, { t: 'hello', name: state.selfName });
    pushState();
    return;
  }
  const remotePubkey = fromBase64(remotePubkeyB64);

  // 发起方 = 后进者（createPeer initiator=true），响应方 = 先进者
  // 但这里 initiator 由 createPeer 的参数决定，存于 peer 上的逻辑
  // 实际上：initiator 创建 DataChannel，所以 ch.onopen 时 initiator 先发
  // 我们通过 peer.pc.currentLocalDescription 判断... 不，太复杂。
  // 更简单：createPeer(initiator=true) 的那个创建了 DataChannel（wireChannel 在 createDataChannel 后调用）
  // createPeer(initiator=false) 的那个在 ondatachannel 里调用 wireChannel
  // 所以：如果 peer.ch 是我们自己 createDataChannel 创建的 -> initiator
  // 判断方式：initiator=true 的 createPeer 调用了 wireChannel(peer, pc.createDataChannel(...))
  // 我们在 createPeer 里记录 initiator 标志

  try {
    // 10s 超时
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('握手超时')), 10000)
    );

    // 判断是否为 initiator：initiator 在 createPeer 里创建了 DataChannel
    // 用 peer._initiator 标记（在 createPeer 里设置）
    const isInitiator = (peer as Peer & { _initiator?: boolean })._initiator ?? false;

    let result: HandshakeResult;
    const handshakePromise = isInitiator
      ? initiatorHandshake(myIdentity, remotePubkey, (m) => handshakeSend(peer, m), () => handshakeRecv(peer))
      : responderHandshake(myIdentity, (m) => handshakeSend(peer, m), () => handshakeRecv(peer));

    result = await Promise.race([handshakePromise, timeout]);

    // 验证：解出的对端公钥 hash 必须等于 peer.id
    const derivedId = derivePeerId(result.remoteStaticPubkey);
    if (derivedId !== peer.id) {
      peer.pc.close();
      log(`对端身份不符：MITM 嫌疑（peer=${peer.id}）`);
      note(`对端身份校验失败：${peer.name} 可能存在中间人`);
      return;
    }

    // TOFU 信任
    peer.trust = await checkAndSaveTrust(peer.id, result.remoteStaticPubkey);

    // 创建加密通道
    peer.channel = new SecureChannel(result.rootKey, isInitiator);
    peer.handshaking = false;
    peer.ready = true;
    log(`与 ${peer.name} 握手成功，信任=${peer.trust.level}${peer.trust.changed ? '（变更警告）' : ''}`);
    securePost(peer, { t: 'hello', name: state.selfName });
    pushState();
  } catch (e) {
    peer.handshaking = false;
    log(`与 ${peer.name} 握手失败：${(e as Error).message}`);
    peer.pc.close();
    state.peers.delete(peer.id);
    pushState();
  }
}

function onChannelFrame(peer: Peer, frame: ChannelFrame): void {
  switch (frame.t) {
    case 'hello':
      peer.name = String(frame.name ?? '').slice(0, 32) || peer.name;
      pushState();
      break;

    case 'msg':
      addMessage(String(frame.text ?? '').slice(0, 4000), peer, false);
      if (!popupVisible) {
        void toSw({ target: 'sw', t: 'notify', title: `${peer.name} sent a message` }).catch(() => {});
      }
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
  receivedFiles.set(fid, { blob, name: inc.name });
  if (receivedFiles.size > MAX_RECEIVED) {
    const oldest = receivedFiles.keys().next().value;
    if (oldest) receivedFiles.delete(oldest);
  }

  const t = state.transfers.get(fid);
  if (t) {
    t.received = blob.size;
    t.done = true;
    emit({ event: 'transfer', payload: t });
  }
  addFileMessage({ id: peer.id, name: peer.name }, fid, inc.name, blob.size);
}

/* ---------- 发送 ---------- */

function targets(to: string): Peer[] {
  const ready = [...state.peers.values()].filter((p) => p.ready && p.ch);
  return to && to !== 'all' ? ready.filter((p) => p.id === to) : ready;
}

function sendText(text: string, to: string): void {
  const clean = text.slice(0, 4000);
  if (!clean.trim()) throw new Error('消息为空');

  for (const peer of targets(to)) securePost(peer, { t: 'msg', text: clean });
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
  securePost(peer, { t: 'file-meta', fid, name: meta.name, size, mime: meta.type });

  for (let offset = 0; offset < size; offset += CHUNK) {
    if (ch.readyState !== 'open') throw new Error('连接已断开');
    if (ch.bufferedAmount > MAX_BUFFER) await untilLowBuffer(ch);
    secureSendChunk(peer, bytes.slice(offset, offset + CHUNK));
  }

  securePost(peer, { t: 'file-end', fid });
}

// popup 传来的是 blob URL —— 扩展消息只走 JSON 序列化，ArrayBuffer 传不过去。
async function sendFile(file: OutgoingFile, to: string): Promise<void> {
  const list = targets(to);
  if (!list.length) throw new Error('没有已连接的对端');

  const bytes = await fetch(file.url).then((r) => r.arrayBuffer());

  for (const peer of list) {
    peer.queue = peer.queue
      .then(() => sendFileTo(peer, file, bytes))
      .catch((e: unknown) => note(`发给 ${peer.name} 失败：${(e as Error).message}`));
  }

  const outMsg: ChatMessage = {
    id: crypto.randomUUID(),
    from: selfId,
    name: state.selfName,
    text: file.name,
    ts: Date.now(),
    self: true,
    file: { fid: crypto.randomUUID(), name: file.name, size: bytes.byteLength, dir: 'out' },
  };
  state.messages.push(outMsg);
  if (state.messages.length > MAX_MESSAGES) state.messages.splice(0, state.messages.length - MAX_MESSAGES);
  emit({ event: 'message', payload: outMsg });
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
    case 'download-received': {
      const rf = receivedFiles.get(msg.fid);
      if (!rf) throw new Error('文件已过期，请让对方重发');
      await toSw({ target: 'sw', t: 'download', url: URL.createObjectURL(rf.blob), filename: rf.name });
      receivedFiles.delete(msg.fid);
      return { ok: true };
    }
    case 'set-visible':
      popupVisible = msg.visible;
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
  myIdentity = await loadIdentity();
  log(`身份加载完成：peerId=${selfId.slice(0, 16)}…`);
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
