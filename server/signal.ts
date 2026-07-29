// 局域网信令中转：只转发 SDP/ICE，不碰聊天内容，不落盘。
// 靠 Node 原生 type stripping 直接运行 —— 没有构建步骤。

import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { ClientFrame, PeerInfo, ServerFrame } from '../src/protocol.ts';

const MAX_PAYLOAD = 1 << 16; // 信令帧最大 64 KiB，媒体不走这里
const HEX64 = /^[0-9a-f]{64}$/;
const LOBBY_ROOM = 'lobby';

interface Member {
  ws: WebSocket;
  name: string;
  pubkey: string;
}

/** 一条连接的会话状态；join 之前 id 为 null。 */
interface Session {
  room: string | null;
  id: string | null;
  ip: string;
}

function ts(): string {
  return new Date().toISOString();
}

function log(level: 'INFO' | 'WARN' | 'ERROR', msg: string): void {
  console.log(`[${ts()}] ${level.padEnd(5)} ${msg}`);
}

function clientIp(req: IncomingMessage): string {
  return (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
}

function send(ws: WebSocket, frame: ServerFrame): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
}

export function createSignalServer({ port = 8787 } = {}): WebSocketServer {
  // 几十人以内没问题，真要上百人得把客户端换成 SFU 或星型转发。
  const rooms = new Map<string, Map<string, Member>>();

  const wss = new WebSocketServer({ port, maxPayload: MAX_PAYLOAD });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const session: Session = { room: null, id: null, ip: clientIp(req) };
    log('INFO', `连接 ${session.ip}`);

    ws.on('message', (raw: Buffer) => {
      let frame: ClientFrame;
      try {
        frame = JSON.parse(raw.toString()) as ClientFrame;
      } catch {
        return; // 非 JSON 直接丢弃
      }

      if (frame.t === 'join') join(ws, session, frame, req);
      else if (frame.t === 'signal') relay(session, frame);
    });

    ws.on('close', () => {
      log('INFO', `断开 ${session.ip}`);
      leave(session);
    });
    ws.on('error', () => {
      log('WARN', `连接错误 ${session.ip}`);
      leave(session);
    });
  });

  function join(
    ws: WebSocket,
    session: Session,
    frame: Extract<ClientFrame, { t: 'join' }>,
    req: IncomingMessage
  ): void {
    if (session.id) return send(ws, { t: 'error', message: '重复加入' }), log('WARN', `拒绝：重复加入 ip=${session.ip}`);

    const id = String(frame.id ?? '').slice(0, 64);
    if (!id) return send(ws, { t: 'error', message: '缺少 id' }), log('WARN', `拒绝：缺少 id ip=${session.ip}`);

    // 有群组码就用群组码（SHA-256 后的 hex64），没有就进公共大厅
    const roomKey = HEX64.test(frame.room ?? '') ? (frame.room as string) : LOBBY_ROOM;

    let room = rooms.get(roomKey);
    if (!room) {
      room = new Map<string, Member>();
      rooms.set(roomKey, room);
      log('INFO', `新建房间 ${roomKey.slice(0, 8)}`);
    }
    if (room.has(id)) return send(ws, { t: 'error', message: 'id 冲突' }), log('WARN', `拒绝：id 冲突 ip=${session.ip}`);

    const name = String(frame.name ?? '').slice(0, 32) || '匿名';
    const pubkey = String(frame.pubkey ?? '').slice(0, 200); // base64 公钥，长度限制防爆
    const peers: PeerInfo[] = [...room].map(([pid, m]) => ({ id: pid, name: m.name, pubkey: m.pubkey }));

    room.set(id, { ws, name, pubkey });
    session.room = roomKey;
    session.id = id;

    log('INFO', `join id=${id} 房间=${roomKey.slice(0, 8)} 人数=${room.size} 昵称=${name}`);

    send(ws, { t: 'joined', room: roomKey, peers });
    for (const [pid, m] of room) {
      if (pid !== id) send(m.ws, { t: 'peer-join', id, name, pubkey });
    }
  }

  function relay(session: Session, frame: Extract<ClientFrame, { t: 'signal' }>): void {
    if (!session.id || !session.room) return;
    const target = rooms.get(session.room)?.get(String(frame.to ?? ''));
    if (!target) return; // 只能转给同房间的人
    send(target.ws, { t: 'signal', from: session.id, data: frame.data });
    log('INFO', `relay ${'sdp' in frame.data ? 'SDP' : 'ICE'} ${session.id} -> ${frame.to}`);
  }

  function leave(session: Session): void {
    if (!session.id || !session.room) return;
    const room = rooms.get(session.room);
    if (!room) return;

    room.delete(session.id);
    for (const m of room.values()) send(m.ws, { t: 'peer-leave', id: session.id });

    log('INFO', `leave id=${session.id} 房间=${session.room.slice(0, 8)} 人数=${room.size}`);
    if (room.size === 0) {
      rooms.delete(session.room);
      log('INFO', `空房间销毁 ${session.room.slice(0, 8)}`);
    }
    session.id = null;
  }

  return wss;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env['PORT'] ?? 8787);
  createSignalServer({ port }).on('listening', () => {
    log('INFO', `监听 ws://0.0.0.0:${port}`);
  });
}
