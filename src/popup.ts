import type { AppState, ChatMessage, Discovery, PopupCommand, PopupMessage, Reply, Transfer } from './protocol.js';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少 #${id}`); // 模板和脚本对不上就立刻炸，别静默降级
  return node as T;
}

const els = {
  dot: el<HTMLSpanElement>('dot'),
  me: el<HTMLElement>('me'),
  status: el<HTMLSpanElement>('status'),
  room: el<HTMLSpanElement>('room'),
  log: el<HTMLPreElement>('log'),
  settings: el<HTMLElement>('settings'),
  toggleSettings: el<HTMLButtonElement>('toggle-settings'),
  url: el<HTMLInputElement>('url'),
  scan: el<HTMLButtonElement>('scan'),
  scanStatus: el<HTMLParagraphElement>('scan-status'),
  name: el<HTMLInputElement>('name'),
  group: el<HTMLInputElement>('group'),
  connect: el<HTMLButtonElement>('connect'),
  disconnect: el<HTMLButtonElement>('disconnect'),
  error: el<HTMLParagraphElement>('error'),
  peers: el<HTMLUListElement>('peers'),
  peerCount: el<HTMLSpanElement>('peer-count'),
  messages: el<HTMLElement>('messages'),
  transfers: el<HTMLElement>('transfers'),
  target: el<HTMLSelectElement>('target'),
  text: el<HTMLTextAreaElement>('text'),
  send: el<HTMLButtonElement>('send'),
  pickFile: el<HTMLButtonElement>('pick-file'),
  file: el<HTMLInputElement>('file'),
};

const transferRows = new Map<string, HTMLDivElement>();
let rendered = new Set<string>();

async function toOffscreen<T>(cmd: PopupCommand): Promise<T> {
  const res = (await chrome.runtime.sendMessage({ target: 'offscreen', ...cmd })) as Reply<T> | undefined;
  if (!res?.ok) throw new Error(res?.error ?? '后台无响应');
  return res.data;
}

function showError(text: string): void {
  els.error.textContent = text;
  els.error.hidden = !text;
}

/* ---------- 渲染 ---------- */

const STATUS_TEXT: Record<AppState['status'], string> = {
  disconnected: '未连接',
  connecting: '连接中…',
  connected: '已连接',
};

function renderState(s: AppState): void {
  els.dot.className = `dot ${s.status}`;
  els.me.textContent = s.self.name;
  const ready = s.peers.filter((p) => p.ready).length;
  els.status.textContent = s.status === 'connected' ? `已连接 · ${ready} 人在线` : STATUS_TEXT[s.status];
  els.room.textContent = s.cfg.room ? `· 群组 ${s.cfg.room}` : '· 本网段';
  showError(s.error);

  els.log.textContent = s.logs
    .map((l) => `${new Date(l.ts).toLocaleTimeString()}  ${l.text}`)
    .join('\n');

  // 正在输入的输入框不要被覆盖
  if (document.activeElement !== els.url) els.url.value = s.cfg.url;
  if (document.activeElement !== els.name) els.name.value = s.cfg.name;
  if (document.activeElement !== els.group) els.group.value = s.cfg.room;

  els.peerCount.textContent = String(s.peers.length);
  els.peers.replaceChildren(
    ...s.peers.map((p) => {
      const li = document.createElement('li');
      li.className = p.ready ? 'ready' : '';
      li.textContent = p.ready ? p.name : `${p.name}（连接中）`;
      return li;
    })
  );

  const keep = els.target.value;
  els.target.replaceChildren(new Option('所有人', 'all'), ...s.peers.map((p) => new Option(p.name, p.id)));
  els.target.value = [...els.target.options].some((o) => o.value === keep) ? keep : 'all';

  els.messages.replaceChildren();
  rendered = new Set();
  s.messages.forEach(renderMessage);

  transferRows.clear();
  els.transfers.replaceChildren();
  s.transfers.forEach(renderTransfer);
}

function renderMessage(m: ChatMessage): void {
  if (rendered.has(m.id)) return;
  rendered.add(m.id);

  const div = document.createElement('div');
  div.className = `msg ${m.self ? 'self' : ''}`;

  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = `${m.name} · ${new Date(m.ts).toLocaleTimeString()}`;

  // 只用 textContent / createTextNode —— 对端发来的内容不可信，绝不 innerHTML
  div.append(who, document.createTextNode(m.text));
  els.messages.append(div);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function renderTransfer(t: Transfer): void {
  let row = transferRows.get(t.fid);
  if (!row) {
    row = document.createElement('div');
    row.className = 'xfer';
    row.append(document.createElement('span'), document.createElement('progress'));
    transferRows.set(t.fid, row);
    els.transfers.append(row);
  }

  const label = row.children[0] as HTMLSpanElement;
  const bar = row.children[1] as HTMLProgressElement;
  const pct = t.size ? Math.round((t.received / t.size) * 100) : 100;

  label.textContent = `${t.dir === 'in' ? '⬇' : '⬆'} ${t.name} · ${t.peer} · ${t.done ? '完成' : `${pct}%`}`;
  bar.max = t.size || 1;
  bar.value = t.received;

  if (t.done) {
    const finished = row;
    setTimeout(() => finished.remove(), 4000);
  }
}

function renderDiscovery(d: Discovery): void {
  els.scan.disabled = d.scanning;
  els.scanStatus.hidden = false;

  if (d.scanning) {
    const pct = d.total ? Math.round((d.scanned / d.total) * 100) : 0;
    els.scanStatus.textContent = `正在扫描局域网… ${pct}%`;
  } else if (d.error) {
    els.scanStatus.textContent = `发现失败：${d.error}`;
  } else if (d.found) {
    els.scanStatus.textContent = `已找到 ${d.found}`;
    els.url.value = d.found;
  } else {
    els.scanStatus.textContent = '本网段没找到信令服务，请手动填写地址';
  }
}

/* ---------- 事件 ---------- */

chrome.runtime.onMessage.addListener((raw: unknown) => {
  const msg = raw as PopupMessage;
  if (msg?.target !== 'popup') return;

  if (msg.event === 'state') renderState(msg.payload);
  if (msg.event === 'message') renderMessage(msg.payload);
  if (msg.event === 'transfer') renderTransfer(msg.payload);
  if (msg.event === 'discovery') renderDiscovery(msg.payload);
});

els.scan.onclick = () => {
  els.settings.hidden = false;
  void toOffscreen<AppState>({ t: 'discover' })
    .then(renderState)
    .catch((e: unknown) => showError((e as Error).message));
};

els.toggleSettings.onclick = () => {
  els.settings.hidden = !els.settings.hidden;
};

els.connect.onclick = async () => {
  els.connect.disabled = true;
  try {
    renderState(
      await toOffscreen<AppState>({
        t: 'connect',
        cfg: { url: els.url.value.trim(), name: els.name.value.trim(), room: els.group.value.trim() },
      })
    );
    els.settings.hidden = true;
  } catch (e) {
    showError((e as Error).message);
  } finally {
    els.connect.disabled = false;
  }
};

els.disconnect.onclick = () => {
  void toOffscreen<AppState>({ t: 'disconnect' })
    .then(renderState)
    .catch((e: unknown) => showError((e as Error).message));
};

async function submitText(): Promise<void> {
  if (!els.text.value.trim()) return;
  try {
    await toOffscreen({ t: 'send-text', text: els.text.value, to: els.target.value });
    els.text.value = '';
  } catch (e) {
    showError((e as Error).message);
  }
}

els.send.onclick = () => void submitText();
els.text.onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void submitText();
  }
};

els.pickFile.onclick = () => els.file.click();

els.file.onchange = async () => {
  const files = [...(els.file.files ?? [])];
  els.file.value = '';

  for (const file of files) {
    // 扩展消息只能传 JSON，所以传 blob URL；offscreen 会立刻 fetch 成 ArrayBuffer 再回复
    const url = URL.createObjectURL(file);
    try {
      await toOffscreen({ t: 'send-file', file: { name: file.name, type: file.type, url }, to: els.target.value });
    } catch (e) {
      showError((e as Error).message);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
};

/* ---------- 启动 ---------- */

void (async () => {
  try {
    await chrome.runtime.sendMessage({ target: 'sw', t: 'ensure' });
    renderState(await toOffscreen<AppState>({ t: 'get-state' }));
  } catch (e) {
    showError(`初始化失败：${(e as Error).message}`);
  }
})();
