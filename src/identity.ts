// 长期身份密钥：每个扩展实例一对 X25519 密钥，peerID = base32(SHA-256(pubkey))。
// 存取经 service worker 代办（offscreen 无 chrome.storage）。

import { generateX25519Keypair, sha256, base32encode, toBase64, fromBase64 } from './crypto-primitives.js';

export interface Identity {
  privateKey: Uint8Array; // 32 bytes
  publicKey: Uint8Array; // 32 bytes
  peerId: string; // "12D3Koo" + base32(SHA-256(pubkey)).slice(0,36)
}

/** libp2p 风格 peerID：12D3Koo 前缀 + base32(SHA-256(pubkey)).slice(0,36) */
export function derivePeerId(publicKey: Uint8Array): string {
  const hash = sha256(publicKey);
  return '12D3Koo' + base32encode(hash).slice(0, 36);
}

/** UI 显示用的短指纹：SHA-256 前 8 字节的 hex 大写 */
export function fingerprint(pubkey: Uint8Array): string {
  const hash = sha256(pubkey);
  const hex = [...hash.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return hex.toUpperCase();
}

export function generateIdentity(): Identity {
  const { privateKey, publicKey } = generateX25519Keypair();
  return { privateKey, publicKey, peerId: derivePeerId(publicKey) };
}

/** 序列化为 base64 JSON 字符串用于 storage */
export function serializeIdentity(id: Identity): string {
  return JSON.stringify({
    privateKey: toBase64(id.privateKey),
    publicKey: toBase64(id.publicKey),
    peerId: id.peerId,
  });
}

export function deserializeIdentity(blob: string): Identity {
  const obj = JSON.parse(blob) as { privateKey: string; publicKey: string; peerId: string };
  return {
    privateKey: fromBase64(obj.privateKey),
    publicKey: fromBase64(obj.publicKey),
    peerId: obj.peerId,
  };
}
