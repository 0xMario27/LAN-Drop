// Noise IK 握手（Noise_IK_25519_ChaChaPoly_SHA256）。
// 发起方预知对端 static public key（从信令帧拿到），2 条消息完成握手。
// 握手后双方得到同一 RootKey + 对端真实 static pubkey。
// 参考 noiseprotocol.org/noise.html 第 7.2 节 IK 模式。

import {
  generateX25519Keypair,
  x25519DH,
  sha256,
  hkdfDerive,
  aeadEncrypt,
  aeadDecrypt,
  concatBytes,
  equalBytes,
} from './crypto-primitives.js';
import type { Identity } from './identity.js';

const PROTOCOL = 'Noise_IK_25519_ChaChaPoly_SHA256';
const EMPTY_KEY = new Uint8Array(32);

interface NoiseState {
  ck: Uint8Array;
  h: Uint8Array;
  k: Uint8Array;
  n: number;
}

export interface HandshakeResult {
  rootKey: Uint8Array;
  remoteStaticPubkey: Uint8Array;
}

function initNoiseState(): NoiseState {
  const nameBytes = new TextEncoder().encode(PROTOCOL);
  const h = nameBytes.length <= 32
    ? concatBytes(nameBytes, new Uint8Array(32 - nameBytes.length))
    : sha256(nameBytes);
  return { ck: h, h, k: EMPTY_KEY, n: 0 };
}

function mixHash(s: NoiseState, data: Uint8Array): void {
  s.h = sha256(concatBytes(s.h, data));
}

function mixKey(s: NoiseState, ikm: Uint8Array): void {
  const out = hkdfDerive(ikm, s.ck, new Uint8Array(0), 64);
  s.ck = out.slice(0, 32);
  s.k = out.slice(32, 64);
  s.n = 0;
}

function nonceFromCounter(n: number): Uint8Array {
  const nonce = new Uint8Array(12);
  const view = new DataView(nonce.buffer);
  view.setUint32(4, Math.floor(n / 0x100000000));
  view.setUint32(8, n >>> 0);
  return nonce;
}

function encryptAndHash(s: NoiseState, plaintext: Uint8Array): Uint8Array {
  let ct: Uint8Array;
  if (equalBytes(s.k, EMPTY_KEY)) {
    ct = plaintext;
  } else {
    ct = aeadEncrypt(s.k, nonceFromCounter(s.n), plaintext, s.h);
  }
  s.n++;
  mixHash(s, ct);
  return ct;
}

function decryptAndHash(s: NoiseState, ciphertext: Uint8Array): Uint8Array {
  let pt: Uint8Array;
  if (equalBytes(s.k, EMPTY_KEY)) {
    pt = ciphertext;
  } else {
    pt = aeadDecrypt(s.k, nonceFromCounter(s.n), ciphertext, s.h);
  }
  s.n++;
  mixHash(s, ciphertext);
  return pt;
}

export type SendFn = (msg: Uint8Array) => void;
export type RecvFn = () => Promise<Uint8Array>;

/**
 * 发起方握手。预知 responder 的 static pubkey。
 * IK 模式 2 条消息：
 *   -> e, es, s, ss  （发 ephemeral + DH + 加密 static + DH + 加密 payload）
 *   <- e, ee, se     （收 ephemeral + DH + DH + 解密 payload）
 */
export async function initiatorHandshake(
  identity: Identity,
  responderStaticPubkey: Uint8Array,
  send: SendFn,
  recv: RecvFn,
): Promise<HandshakeResult> {
  const s = initNoiseState();
  const eph = generateX25519Keypair();

  // 消息 1: -> e, es, s, ss
  mixHash(s, eph.publicKey);
  mixKey(s, x25519DH(eph.privateKey, responderStaticPubkey)); // es
  const encStatic = encryptAndHash(s, identity.publicKey); // s（加密）
  mixKey(s, x25519DH(identity.privateKey, responderStaticPubkey)); // ss
  const encPayload = encryptAndHash(s, new Uint8Array([1])); // payload: 版本 1
  send(concatBytes(eph.publicKey, encStatic, encPayload));

  // 消息 2: <- e, ee, se
  const msg2 = await recv();
  const re = msg2.slice(0, 32); // e
  mixHash(s, re);
  mixKey(s, x25519DH(eph.privateKey, re)); // ee = DH(init_e, resp_e)
  mixKey(s, x25519DH(eph.privateKey, responderStaticPubkey)); // se = DH(init_e, resp_s)（与 es 同原语，但 ck 状态不同）
  decryptAndHash(s, msg2.slice(32)); // payload（解密验证）

  return { rootKey: s.ck, remoteStaticPubkey: responderStaticPubkey };
}

/**
 * 响应方握手。
 * IK 模式 2 条消息：
 *   <- e, es, s, ss  （收 ephemeral + DH + 解密 static + DH + 解密 payload）
 *   -> e, ee, se     （发 ephemeral + DH + DH + 加密 payload）
 */
export async function responderHandshake(
  identity: Identity,
  send: SendFn,
  recv: RecvFn,
): Promise<HandshakeResult> {
  const s = initNoiseState();
  const eph = generateX25519Keypair();

  // 消息 1: <- e, es, s, ss
  const msg1 = await recv();
  const re = msg1.slice(0, 32); // e
  mixHash(s, re);
  mixKey(s, x25519DH(identity.privateKey, re)); // es = DH(resp_s, init_e)
  const remoteStatic = decryptAndHash(s, msg1.slice(32, 32 + 48)); // s（解密）
  mixKey(s, x25519DH(identity.privateKey, remoteStatic)); // ss = DH(resp_s, init_s)
  decryptAndHash(s, msg1.slice(32 + 48)); // payload（解密验证）

  // 消息 2: -> e, ee, se
  mixHash(s, eph.publicKey);
  mixKey(s, x25519DH(eph.privateKey, re)); // ee = DH(resp_e, init_e)
  mixKey(s, x25519DH(identity.privateKey, re)); // se = DH(resp_s, init_e)
  const encPayload = encryptAndHash(s, new Uint8Array([1])); // payload: 版本 1
  send(concatBytes(eph.publicKey, encPayload));

  return { rootKey: s.ck, remoteStaticPubkey: remoteStatic };
}
