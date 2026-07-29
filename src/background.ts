// Service worker: 只做两件事 —— 保证 offscreen 文档活着，以及代下载。
// 所有 WebRTC / WebSocket 逻辑都在 offscreen.ts，因为 MV3 service worker 会被回收。

import type { Config, SwMessage } from './protocol.js';

let creating: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;

  creating ??= chrome.offscreen
    .createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.WEB_RTC],
      justification: '保持局域网 WebRTC 连接，即使弹窗已关闭。',
    })
    .finally(() => {
      creating = null;
    });

  await creating;
}

/**
 * 点扩展图标打开独立标签页，而不是弹窗 —— 聊天需要空间。
 * 复用上次那个标签页：tab id 存在 session storage 里，这样不必申请 "tabs" 权限
 * （按 URL 查标签页需要它，而那会给用户看到"读取浏览记录"的警告）。
 */
async function openApp(): Promise<void> {
  await ensureOffscreen();

  const { appTabId } = await chrome.storage.session.get('appTabId');
  if (typeof appTabId === 'number') {
    try {
      const tab = await chrome.tabs.update(appTabId, { active: true });
      if (tab?.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
      return;
    } catch {
      // 标签页已被关掉，往下新建
    }
  }

  const tab = await chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
  if (tab.id != null) await chrome.storage.session.set({ appTabId: tab.id });
}

chrome.action.onClicked.addListener(() => void openApp());
chrome.runtime.onStartup.addListener(ensureOffscreen);
chrome.runtime.onInstalled.addListener(ensureOffscreen);

chrome.runtime.onMessage.addListener((raw: unknown, _sender, reply) => {
  const msg = raw as SwMessage;
  if (msg?.target !== 'sw') return undefined;

  if (msg.t === 'ensure') {
    ensureOffscreen().then(
      () => reply({ ok: true }),
      (e: unknown) => reply({ ok: false, error: String(e) })
    );
    return true; // 异步回复
  }

  // chrome.storage 在 offscreen 文档里是 undefined，只能由这里代读代写
  if (msg.t === 'get-config') {
    chrome.storage.local.get('cfg').then(
      (stored: { cfg?: Partial<Config> }) => reply({ ok: true, data: stored.cfg ?? null }),
      (e: unknown) => reply({ ok: false, error: String(e) })
    );
    return true;
  }

  if (msg.t === 'set-config') {
    chrome.storage.local.set({ cfg: msg.cfg }).then(
      () => reply({ ok: true, data: null }),
      (e: unknown) => reply({ ok: false, error: String(e) })
    );
    return true;
  }

  if (msg.t === 'download') {
    // blob URL 与本扩展同源，downloads 能解析；offscreen 一直存活所以 URL 不会失效。
    chrome.downloads.download({ url: msg.url, filename: msg.filename, saveAs: false }).then(
      () => reply({ ok: true, data: null }),
      (e: unknown) => reply({ ok: false, error: String(e) })
    );
    return true;
  }

  if (msg.t === 'get-identity') {
    chrome.storage.local.get('identity-v1').then(
      (stored: { 'identity-v1'?: string }) => reply({ ok: true, data: stored['identity-v1'] ?? null }),
      (e: unknown) => reply({ ok: false, error: String(e) })
    );
    return true;
  }

  if (msg.t === 'set-identity') {
    chrome.storage.local.set({ 'identity-v1': msg.blob }).then(
      () => reply({ ok: true, data: null }),
      (e: unknown) => reply({ ok: false, error: String(e) })
    );
    return true;
  }

  if (msg.t === 'get-trusted-peer') {
    chrome.storage.local.get(`peer-${msg.peerId}`).then(
      (stored: Record<string, unknown>) => reply({ ok: true, data: stored[`peer-${msg.peerId}`] ?? null }),
      (e: unknown) => reply({ ok: false, error: String(e) })
    );
    return true;
  }

  if (msg.t === 'set-trusted-peer') {
    const record = { pubkey: msg.pubkey, level: msg.level, firstSeen: Date.now() };
    chrome.storage.local.set({ [`peer-${msg.peerId}`]: record }).then(
      () => reply({ ok: true, data: record }),
      (e: unknown) => reply({ ok: false, error: String(e) })
    );
    return true;
  }

  if (msg.t === 'notify') {
    chrome.notifications.create({ type: 'basic', iconUrl: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjNGY0NmU1IiBzdHJva2Utd2lkdGg9IjIiPjxwYXRoIGQ9Ik0xMiAyTDQgNnY2YzAgNSAzLjUgOSA4IDEwIDQuNS0xIDgtNSA4LTEwVjZsLTgtNHoiLz48L3N2Zz4=', title: 'LAN Drop', message: msg.title });
    return false;
  }

  return undefined;
});
