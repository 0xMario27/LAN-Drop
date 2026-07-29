// 对称加密通道：从 Noise RootKey 派生收发密钥，每帧 ChaCha20-Poly1305 + 递增 nonce。
// 替代 Double Ratchet：DataChannel 走 SCTP 有序可靠，无需 skipped map / DH 轮换。

import { hkdfDerive, aeadEncrypt, aeadDecrypt } from './crypto-primitives.js';

const NONCE_PREFIX = new Uint8Array(4); // nonce 前 4 字节固定 0

export class SecureChannel {
  private readonly sendKey: Uint8Array;
  private readonly recvKey: Uint8Array;
  private sendCounter = 0;
  private recvCounter = 0;

  constructor(rootKey: Uint8Array, isInitiator: boolean) {
    // 用方向标签派生：i2r = 发起方→响应方，r2i = 响应方→发起方
    // 发起方 sendKey = 响应方 recvKey = i2r；发起方 recvKey = 响应方 sendKey = r2i
    const i2r = hkdfDerive(rootKey, new Uint8Array(0), new TextEncoder().encode('lan-drop-i2r'), 32);
    const r2i = hkdfDerive(rootKey, new Uint8Array(0), new TextEncoder().encode('lan-drop-r2i'), 32);
    this.sendKey = isInitiator ? i2r : r2i;
    this.recvKey = isInitiator ? r2i : i2r;
  }

  private nonce(counter: number): Uint8Array {
    const nonce = new Uint8Array(12);
    nonce.set(NONCE_PREFIX, 0);
    const view = new DataView(nonce.buffer);
    view.setUint32(4, Math.floor(counter / 0x100000000));
    view.setUint32(8, counter >>> 0);
    return nonce;
  }

  encrypt(plaintext: Uint8Array): { nonce: Uint8Array; ciphertext: Uint8Array } {
    const nonce = this.nonce(this.sendCounter);
    const ciphertext = aeadEncrypt(this.sendKey, nonce, plaintext, new Uint8Array(0));
    this.sendCounter++;
    return { nonce, ciphertext };
  }

  decrypt(nonce: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    const plaintext = aeadDecrypt(this.recvKey, nonce, ciphertext, new Uint8Array(0));
    this.recvCounter++;
    return plaintext;
  }
}

/** 控制帧前缀：区分 JSON 控制帧（0x01）与文件分片（0x02） */
export const CTRL_PREFIX = 0x01;
export const DATA_PREFIX = 0x02;

/** 拼接 nonce + ciphertext 为一个 ArrayBuffer 发送 */
export function packFrame(nonce: Uint8Array, ciphertext: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(12 + ciphertext.length);
  out.set(nonce, 0);
  out.set(ciphertext, 12);
  return out.buffer;
}

/** 拆分接收到的 ArrayBuffer 为 nonce + ciphertext */
export function unpackFrame(buf: ArrayBuffer): { nonce: Uint8Array; ciphertext: Uint8Array } {
  const all = new Uint8Array(buf);
  return { nonce: all.slice(0, 12), ciphertext: all.slice(12) };
}
