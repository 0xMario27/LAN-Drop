import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SecureChannel } from './secure-channel.js';

test('SecureChannel: 发起方加密 -> 响应方解密', () => {
  const rootKey = new Uint8Array(32).fill(42);
  const initiator = new SecureChannel(rootKey, true);
  const responder = new SecureChannel(rootKey, false);

  const plaintext = new TextEncoder().encode('hello world');
  const { nonce, ciphertext } = initiator.encrypt(plaintext);
  const decrypted = responder.decrypt(nonce, ciphertext);

  assert.deepEqual([...decrypted], [...plaintext]);
});

test('SecureChannel: 响应方加密 -> 发起方解密', () => {
  const rootKey = new Uint8Array(32).fill(42);
  const initiator = new SecureChannel(rootKey, true);
  const responder = new SecureChannel(rootKey, false);

  const plaintext = new TextEncoder().encode('reply message');
  const { nonce, ciphertext } = responder.encrypt(plaintext);
  const decrypted = initiator.decrypt(nonce, ciphertext);

  assert.deepEqual([...decrypted], [...plaintext]);
});

test('SecureChannel: 连续 100 帧双向收发', () => {
  const rootKey = new Uint8Array(32).fill(7);
  const a = new SecureChannel(rootKey, true);
  const b = new SecureChannel(rootKey, false);

  for (let i = 0; i < 100; i++) {
    const msg = new TextEncoder().encode(`msg-${i}`);
    const enc = a.encrypt(msg);
    const dec = b.decrypt(enc.nonce, enc.ciphertext);
    assert.equal(new TextDecoder().decode(dec), `msg-${i}`);

    const reply = new TextEncoder().encode(`reply-${i}`);
    const enc2 = b.encrypt(reply);
    const dec2 = a.decrypt(enc2.nonce, enc2.ciphertext);
    assert.equal(new TextDecoder().decode(dec2), `reply-${i}`);
  }
});

test('SecureChannel: 错误密钥 -> 解密失败', () => {
  const rootKey = new Uint8Array(32).fill(1);
  const initiator = new SecureChannel(rootKey, true);
  // 用不同 rootKey 的响应方
  const wrongResponder = new SecureChannel(new Uint8Array(32).fill(2), false);

  const { nonce, ciphertext } = initiator.encrypt(new TextEncoder().encode('secret'));
  assert.throws(() => wrongResponder.decrypt(nonce, ciphertext));
});
