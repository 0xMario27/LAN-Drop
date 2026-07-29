// 唯一一个自动化检查：信令的房间隔离、转发与无人数上限。这是服务端全部的非平凡逻辑。
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import type { ServerFrame } from '../src/protocol.ts';
import { createSignalServer, subnetKey } from './signal.ts';

const nextFrame = (ws: WebSocket): Promise<ServerFrame> =>
  new Promise((resolve) => ws.once('message', (raw: Buffer) => resolve(JSON.parse(raw.toString()) as ServerFrame)));

function client(port: number, join: unknown): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  return new Promise((resolve) =>
    ws.once('open', () => {
      ws.send(JSON.stringify(join));
      resolve(ws);
    })
  );
}

async function listen(): Promise<{ wss: ReturnType<typeof createSignalServer>; port: number }> {
  const wss = createSignalServer({ port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const address = wss.address();
  if (!address || typeof address === 'string') throw new Error('预期是 TCP 端口');
  return { wss, port: address.port };
}

test('同房间互相发现并能转发信令，跨房间不可见', async (t) => {
  const { wss, port } = await listen();
  t.after(() => wss.close());

  const room = 'a'.repeat(64);
  const a = await client(port, { t: 'join', room, id: 'a', name: '甲', pubkey: '' });
  assert.deepEqual(await nextFrame(a), { t: 'joined', room, peers: [] });

  const b = await client(port, { t: 'join', room, id: 'b', name: '乙', pubkey: '' });
  const [joinedB, notifiedA] = await Promise.all([nextFrame(b), nextFrame(a)]);
  assert.deepEqual(joinedB, { t: 'joined', room, peers: [{ id: 'a', name: '甲', pubkey: '' }] });
  assert.deepEqual(notifiedA, { t: 'peer-join', id: 'b', name: '乙', pubkey: '' });

  // 后进者向先到者发 offer
  const data = { sdp: { type: 'offer', sdp: 'x' } };
  b.send(JSON.stringify({ t: 'signal', to: 'a', data }));
  assert.deepEqual(await nextFrame(a), { t: 'signal', from: 'b', data });

  // 另一个房间的人既看不到成员，也发不进来
  const other = 'b'.repeat(64);
  const c = await client(port, { t: 'join', room: other, id: 'c', name: '丙', pubkey: '' });
  assert.deepEqual(await nextFrame(c), { t: 'joined', room: other, peers: [] });
  c.send(JSON.stringify({ t: 'signal', to: 'a', data: { sdp: { type: 'offer', sdp: 'leak' } } }));

  b.close();
  // a 的下一帧必须是 b 的离开，而不是 c 的越权转发
  assert.deepEqual(await nextFrame(a), { t: 'peer-leave', id: 'b' });

  a.close();
  c.close();
});

test('房间没有人数上限', async (t) => {
  const { wss, port } = await listen();
  t.after(() => wss.close());

  const room = 'c'.repeat(64);
  const size = 40; // 远超过旧版 16 人的上限
  const sockets: WebSocket[] = [];

  for (let i = 0; i < size; i++) {
    const ws = await client(port, { t: 'join', room, id: `p${i}`, name: `第${i}位`, pubkey: '' });
    const frame = await nextFrame(ws);
    assert.equal(frame.t, 'joined', `第 ${i} 位应当成功加入，实际收到 ${JSON.stringify(frame)}`);
    if (frame.t === 'joined') assert.equal(frame.peers.length, i);
    sockets.push(ws);
  }

  for (const ws of sockets) ws.close();
});

test('未指定房间时按 /24 网段归组', () => {
  assert.equal(subnetKey('192.168.1.7'), subnetKey('::ffff:192.168.1.200'));
  assert.notEqual(subnetKey('192.168.1.7'), subnetKey('192.168.2.7'));
});
