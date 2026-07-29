// 自动发现局域网里的信令服务。
//
// MV3 扩展拿不到本机 IP：chrome.system.network 是已下线的 Chrome Apps 专有 API，
// 而 WebRTC 的 host candidate 会被 mDNS 混淆成 *.local。所以只能按常见私有网段
// 逐个探测 —— 能握手成功的 WebSocket 就是信令服务。
//
// 已配置过的地址所在网段永远排第一，所以配过一次之后再发现基本是秒中。

export interface DiscoveryProgress {
  scanned: number;
  total: number;
}

const BATCH = 96; // 并发探测数；Chrome 每个渲染进程约 255 条 WebSocket 上限
const PROBE_TIMEOUT_MS = 2000; // 只在"扫不到"时才吃满，命中是立刻返回的，宁可给宽一点
const DEFAULT_PORT = 8787;

/** 覆盖绝大多数家用/办公路由器与手机热点的默认网段，按命中概率排序。 */
export const COMMON_SUBNETS = [
  '192.168.1',
  '192.168.0',
  '10.0.0',
  '192.168.31', // 小米/Redmi 路由器
  '192.168.2',
  '172.20.10', // iPhone 个人热点
] as const;

/** RFC1918 私有地址；公网和回环都不扫。 */
export function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;

  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/**
 * 待扫网段：当前已配置地址所在的那个排最前，其余按常见程度补齐。
 * ponytail: 一律按 /24 扫 —— /16 是 65536 个地址，不可能挨个试。
 */
export function subnetsToScan(currentUrl: string): string[] {
  const known = hostOf(currentUrl);
  const first = known && isPrivateIPv4(known) ? [known.split('.').slice(0, 3).join('.')] : [];
  return [...new Set([...first, ...COMMON_SUBNETS])];
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** 从已配置的地址里取端口，取不到就用默认端口。 */
export function portFrom(url: string): number {
  try {
    const port = Number(new URL(url).port);
    return Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

export function candidates(prefixes: readonly string[], port: number): string[] {
  const urls: string[] = [];
  for (const prefix of prefixes) {
    for (let host = 1; host <= 254; host++) urls.push(`ws://${prefix}.${host}:${port}`);
  }
  return urls;
}

/** 握手成功即认定是信令服务。失败、超时、被拒都算否。 */
export function probe(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      resolve(false);
      return;
    }

    const finish = (ok: boolean): void => {
      clearTimeout(timer);
      ws.onopen = null;
      ws.onerror = null;
      ws.onclose = null;
      ws.close();
      resolve(ok);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);
    ws.onopen = () => finish(true);
    ws.onerror = () => finish(false);
    ws.onclose = () => finish(false);
  });
}

/**
 * 按批并发探测，命中即停。
 * ponytail: 分批而不是真正的连接池 —— 少十几行代码，一个 /24 也就多花一两秒。
 */
export async function discover(
  urls: readonly string[],
  onProgress?: (p: DiscoveryProgress) => void
): Promise<string | null> {
  for (let i = 0; i < urls.length; i += BATCH) {
    const batch = urls.slice(i, i + BATCH);
    const hits = await Promise.all(batch.map((url) => probe(url)));

    const index = hits.indexOf(true);
    if (index >= 0) return batch[index] as string;

    onProgress?.({ scanned: i + batch.length, total: urls.length });
  }
  return null;
}
