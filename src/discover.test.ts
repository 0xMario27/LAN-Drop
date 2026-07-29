// 自动发现的非平凡部分：网段推导与"这个地址上到底有没有信令服务"的判定。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSignalServer } from '../server/signal.ts';
import { COMMON_SUBNETS, candidates, discover, isPrivateIPv4, portFrom, probe, subnetsToScan } from './discover.ts';

test('只认 RFC1918 私有地址', () => {
  for (const ok of ['10.0.0.3', '172.16.5.1', '172.31.255.254', '192.168.1.105']) {
    assert.equal(isPrivateIPv4(ok), true, ok);
  }
  for (const no of ['8.8.8.8', '127.0.0.1', '172.15.0.1', '172.32.0.1', '::1', '192.168.1', '999.1.1.1']) {
    assert.equal(isPrivateIPv4(no), false, no);
  }
});

test('已配置地址所在网段排在最前，且不重复出现', () => {
  // 192.168.31 本来就在常见列表里，提到最前之后不能出现两次
  const bumped = subnetsToScan('ws://192.168.31.7:8787');
  assert.equal(bumped[0], '192.168.31');
  assert.equal(bumped.filter((s) => s === '192.168.31').length, 1);
  assert.equal(bumped.length, COMMON_SUBNETS.length);

  // 列表里没有的网段应当被插到最前，总数加一
  const added = subnetsToScan('ws://10.44.9.2:8787');
  assert.equal(added[0], '10.44.9');
  assert.equal(added.length, COMMON_SUBNETS.length + 1);

  // 公网域名（部署到公网的场景）不参与网段推导
  assert.deepEqual(subnetsToScan('wss://signal.example.com'), [...COMMON_SUBNETS]);
  assert.deepEqual(subnetsToScan(''), [...COMMON_SUBNETS]);
});

test('端口从已配置地址里取，取不到用默认值', () => {
  assert.equal(portFrom('ws://192.168.1.10:9000'), 9000);
  assert.equal(portFrom('wss://signal.example.com'), 8787); // 没写端口
  assert.equal(portFrom('乱填的'), 8787);
});

test('每个网段展开成 254 个候选地址', () => {
  const urls = candidates(['192.168.1'], 8787);
  assert.equal(urls.length, 254);
  assert.equal(urls[0], 'ws://192.168.1.1:8787');
  assert.equal(urls.at(-1), 'ws://192.168.1.254:8787');
});

test('探测：有信令服务的地址为真，空端口为假', async (t) => {
  const wss = createSignalServer({ port: 0 });
  await new Promise((r) => wss.once('listening', r));
  t.after(() => wss.close());

  const address = wss.address();
  if (!address || typeof address === 'string') throw new Error('预期是 TCP 端口');

  assert.equal(await probe(`ws://127.0.0.1:${address.port}`), true);
  assert.equal(await probe('ws://127.0.0.1:1', 500), false);
});

test('扫描命中即返回，全部落空返回 null', async (t) => {
  const wss = createSignalServer({ port: 0 });
  await new Promise((r) => wss.once('listening', r));
  t.after(() => wss.close());

  const address = wss.address();
  if (!address || typeof address === 'string') throw new Error('预期是 TCP 端口');

  const hit = `ws://127.0.0.1:${address.port}`;
  assert.equal(await discover(['ws://127.0.0.1:1', hit]), hit);
  assert.equal(await discover(['ws://127.0.0.1:1', 'ws://127.0.0.1:2']), null);
});
