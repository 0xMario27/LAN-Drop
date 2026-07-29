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
  settingsOverlay: el<HTMLElement>('settings-overlay'),
  toggleSettings: el<HTMLButtonElement>('toggle-settings'),
  closeSettings: el<HTMLButtonElement>('close-settings'),
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
  xferTitle: el<HTMLElement>('xfer-title'),
  target: el<HTMLSelectElement>('target'),
  text: el<HTMLTextAreaElement>('text'),
  send: el<HTMLButtonElement>('send'),
  pickFile: el<HTMLButtonElement>('pick-file'),
  file: el<HTMLInputElement>('file'),
};

const ARROW_DOWN = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>';
const ARROW_UP = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>';
const SHIELD_TOFU = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L4 6v6c0 5 3.5 9 8 10 4.5-1 8-5 8-10V6l-8-4z"/></svg>';
const SHIELD_OK = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L4 6v6c0 5 3.5 9 8 10 4.5-1 8-5 8-10V6l-8-4z"/><polyline points="9 12 11 14 15 10"/></svg>';
const SHIELD_WARN = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
const FILE_ICON = '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

function svgIcon(markup: string): ChildNode {
  const tpl = document.createElement('template');
  tpl.innerHTML = markup;
  return tpl.content.firstChild as ChildNode;
}

const transferRows = new Map<string, HTMLDivElement>();
let rendered = new Set<string>();
const downloaded = new Set<string>();

function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

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
  const currentTarget = els.target.value;
  els.peers.replaceChildren(
    ...s.peers.map((p) => {
      const li = document.createElement('li');
      li.className = p.ready ? 'ready' : '';
      if (p.trust?.changed) li.classList.add('trust-warn');
      else if (p.trust?.level === 'verified') li.classList.add('trust-ok');
      if (currentTarget === p.id) li.classList.add('selected');
      li.onclick = () => {
        els.target.value = els.target.value === p.id ? 'all' : p.id;
        els.target.dispatchEvent(new Event('change'));
        renderPeerSelection();
      };
      li.style.cursor = 'pointer';
      li.setAttribute('data-peer-id', p.id);

      const avatar = document.createElement('span');
      avatar.className = 'avatar';
      avatar.textContent = p.name ? p.name.charAt(0) : '?';

      const name = document.createElement('span');
      name.className = 'peer-name';
      name.textContent = p.name;

      // 信任盾牌
      let shield: ChildNode | null = null;
      if (p.trust?.changed) {
        shield = svgIcon(SHIELD_WARN);
        (shield as HTMLElement).classList.add('trust-icon', 'warn');
        (shield as HTMLElement).title = `指纹变更！原 ${p.trust.fingerprint}`;
      } else if (p.trust?.level === 'verified') {
        shield = svgIcon(SHIELD_OK);
        (shield as HTMLElement).classList.add('trust-icon', 'ok');
        (shield as HTMLElement).title = `已信任 ${p.trust.fingerprint}`;
      } else if (p.trust) {
        shield = svgIcon(SHIELD_TOFU);
        (shield as HTMLElement).classList.add('trust-icon', 'tofu');
        (shield as HTMLElement).title = `首次信任 ${p.trust.fingerprint}`;
      }

      const state = document.createElement('span');
      state.className = 'peer-state';
      state.textContent = p.ready ? '' : '连接中';

      if (shield) li.append(avatar, name, shield, state);
      else li.append(avatar, name, state);
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
  els.transfers.replaceChildren(els.xferTitle);
  els.transfers.hidden = s.transfers.length === 0;
  s.transfers.forEach(renderTransfer);
}

function renderPeerSelection(): void {
  const selected = els.target.value;
  for (const li of els.peers.children) {
    const id = li.getAttribute('data-peer-id');
    li.classList.toggle('selected', id === selected);
  }
}

els.target.onchange = () => renderPeerSelection();

function renderMessage(m: ChatMessage): void {
  if (rendered.has(m.id)) return;
  rendered.add(m.id);

  if (m.file) {
    renderFileCard(m);
    return;
  }

  const div = document.createElement('div');
  div.className = `msg ${m.self ? 'self' : ''} ${m.system ? 'system' : ''} ${m.to ? 'dm' : ''}`;

  const who = document.createElement('span');
  who.className = 'who';
  let whoText = `${m.name} · ${new Date(m.ts).toLocaleTimeString()}`;
  if (m.self && m.to) whoText += ` → ${m.to}`;
  else if (!m.self && m.to === 'dm') whoText += ' · 私信';
  who.textContent = whoText;

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

  label.replaceChildren(
    svgIcon(t.dir === 'in' ? ARROW_DOWN : ARROW_UP),
    document.createTextNode(` ${t.name} · ${t.peer} · ${t.done ? '完成' : `${pct}%`}`)
  );
  bar.max = t.size || 1;
  bar.value = t.received;

  if (t.done) {
    const finished = row;
    setTimeout(() => finished.remove(), 4000);
  }
}

function renderFileCard(m: ChatMessage): void {
  const f = m.file!;
  const div = document.createElement('div');
  div.className = `msg file ${m.self ? 'self' : ''}`;

  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = `${m.name} · ${new Date(m.ts).toLocaleTimeString()}`;

  const card = document.createElement('div');
  card.className = 'file-card';
  card.append(svgIcon(FILE_ICON));

  const info = document.createElement('div');
  info.className = 'file-info';

  const nameEl = document.createElement('span');
  nameEl.className = 'file-name';
  nameEl.textContent = f.name;

  const meta = document.createElement('span');
  meta.className = 'file-meta';
  meta.textContent = formatBytes(f.size);

  info.append(nameEl, meta);
  card.append(info);

  if (f.dir === 'in' && !downloaded.has(f.fid)) {
    const btn = document.createElement('button');
    btn.className = 'file-dl';
    btn.textContent = '下载';
    btn.onclick = () => {
      btn.disabled = true;
      void toOffscreen({ t: 'download-received', fid: f.fid }).then(() => {
        downloaded.add(f.fid);
        btn.replaceChildren(svgIcon(CHECK_ICON), document.createTextNode(' 已下载'));
      }).catch((e: unknown) => {
        btn.disabled = false;
        showError((e as Error).message);
      });
    };
    card.append(btn);
  } else if (f.dir === 'in') {
    const done = document.createElement('span');
    done.className = 'file-done';
    done.textContent = '已下载';
    card.append(done);
  } else {
    const sent = document.createElement('span');
    sent.className = 'file-done';
    sent.textContent = '已发送';
    card.append(sent);
  }

  div.append(who, card);
  els.messages.append(div);
  els.messages.scrollTop = els.messages.scrollHeight;
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
  void toOffscreen<AppState>({ t: 'discover' })
    .then(renderState)
    .catch((e: unknown) => showError((e as Error).message));
};

els.toggleSettings.onclick = () => {
  els.settingsOverlay.hidden = false;
};

els.closeSettings.onclick = () => {
  els.settingsOverlay.hidden = true;
};

els.settingsOverlay.onclick = (e) => {
  if (e.target === els.settingsOverlay) els.settingsOverlay.hidden = true;
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
    els.settingsOverlay.hidden = true;
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

function setVisible(visible: boolean): void {
  void toOffscreen({ t: 'set-visible', visible }).catch(() => {});
}

document.addEventListener('visibilitychange', () => setVisible(!document.hidden));
window.addEventListener('pageshow', () => setVisible(true));
window.addEventListener('pagehide', () => setVisible(false));

void (async () => {
  try {
    await chrome.runtime.sendMessage({ target: 'sw', t: 'ensure' });
    setVisible(true);
    renderState(await toOffscreen<AppState>({ t: 'get-state' }));
  } catch (e) {
    showError(`初始化失败：${(e as Error).message}`);
  }
})();
