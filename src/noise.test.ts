import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initiatorHandshake, responderHandshake } from './noise.js';
import { generateIdentity } from './identity.js';
import { equalBytes } from './crypto-primitives.js';

function channel() {
  const queue: Uint8Array[] = [];
  const waiters: Array<(v: Uint8Array) => void> = [];
  return {
    send(msg: Uint8Array) {
      const w = waiters.shift();
      if (w) w(msg);
      else queue.push(msg);
    },
    recv: () => new Promise<Uint8Array>((resolve) => {
      const m = queue.shift();
      if (m) resolve(m);
      else waiters.push(resolve);
    }),
  };
}

test('Noise IK: 双方最终 RootKey 一致', async () => {
  const initiator = generateIdentity();
  const responder = generateIdentity();
  const i2r = channel();
  const r2i = channel();

  const [initResult, respResult] = await Promise.all([
    initiatorHandshake(initiator, responder.publicKey, (m) => i2r.send(m), r2i.recv),
    responderHandshake(responder, (m) => r2i.send(m), i2r.recv),
  ]);

  assert.ok(equalBytes(initResult.rootKey, respResult.rootKey), 'RootKey 应一致');
  assert.ok(equalBytes(initResult.remoteStaticPubkey, responder.publicKey));
  assert.ok(equalBytes(respResult.remoteStaticPubkey, initiator.publicKey));
});

test('Noise IK: MITM -> 握手失败', async () => {
  const initiator = generateIdentity();
  const responder = generateIdentity();
  const attacker = generateIdentity();
  const i2a = channel();
  const a2i = channel();

  const initPromise = initiatorHandshake(initiator, responder.publicKey, (m) => i2a.send(m), a2i.recv);
  const attackerPromise = responderHandshake(attacker, (m) => a2i.send(m), i2a.recv);

  // attacker 解密消息 1 会失败（DH 不匹配），不会发消息 2
  // 发起方会一直等消息 2 -> 用超时检测
  const attackerOk = await attackerPromise.then(() => true).catch(() => false);
  assert.equal(attackerOk, false, 'MITM 响应方握手应失败');

  // 发起方超时（10s 太长，用 1s）
  const initTimeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), 1000));
  const initResult = await Promise.race([initPromise.then(() => 'ok').catch(() => 'fail'), initTimeout]);
  assert.notEqual(initResult, 'ok', '发起方不应握手成功');

  // 清理
  initPromise.catch(() => {});
});
