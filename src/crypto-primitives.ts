// 统一封装 noble 的密码学原语。所有编码/哈希/加密都从这里走，便于测试与替换。

import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';

/* ---------- base64 ---------- */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += B64[b0 >> 2]!;
    out += B64[((b0 & 0x03) << 4) | (b1 >> 4)]!;
    out += i + 1 < bytes.length ? B64[((b1 & 0x0f) << 2) | (b2 >> 6)]! : '=';
    out += i + 2 < bytes.length ? B64[b2 & 0x3f]! : '=';
  }
  return out;
}

export function fromBase64(str: string): Uint8Array {
  const clean = str.replace(/[^A-Za-z0-9+/]/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64.indexOf(clean[i]!);
    const c1 = B64.indexOf(clean[i + 1]!);
    const c2 = B64.indexOf(clean[i + 2]!);
    const c3 = B64.indexOf(clean[i + 3]!);
    bytes.push((c0 << 2) | (c1 >> 4));
    if (c2 >= 0 && clean[i + 2] !== '=') bytes.push(((c1 & 0x0f) << 4) | (c2 >> 2));
    if (c3 >= 0 && clean[i + 3] !== '=') bytes.push(((c2 & 0x03) << 6) | c3);
  }
  return new Uint8Array(bytes);
}

/* ---------- base32 (RFC 4648, 大写, 无填充) ---------- */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32encode(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let val = 0;
  for (const b of bytes) {
    val = (val << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(val >> (bits - 5)) & 0x1f]!;
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 0x1f]!;
  return out;
}

/* ---------- hex ---------- */

export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------- 哈希 / KDF ---------- */

export { sha256 };

export function hkdfDerive(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Uint8Array {
  return hkdf(sha256, ikm, salt, info, length);
}

/* ---------- AEAD (ChaCha20-Poly1305) ---------- */

export function aeadEncrypt(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array {
  // noble chacha20poly1305 在创建时绑定 nonce；AAD 通过第二个参数传入
  const aead = chacha20poly1305(key, nonce, aad);
  return aead.encrypt(plaintext);
}

export function aeadDecrypt(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, aad: Uint8Array): Uint8Array {
  const aead = chacha20poly1305(key, nonce, aad);
  return aead.decrypt(ciphertext);
}

/* ---------- X25519 DH ---------- */

export function generateX25519Keypair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

export function x25519DH(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(privateKey, publicKey);
}

/* ---------- 工具 ---------- */

export function concatBytes(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
