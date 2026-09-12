// 紧凑流式 MD5（用于计算原始 PCM 校验和；libflac.js 的 min 构建未导出
// set_md5_checking，STREAMINFO 的 MD5 字段由 flacmeta.injectTags 用本结果补写）

const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const K = new Int32Array(64);
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0;

export class StreamingMD5 {
  constructor() {
    this.a0 = 0x67452301 | 0; this.b0 = 0xefcdab89 | 0;
    this.c0 = 0x98badcfe | 0; this.d0 = 0x10325476 | 0;
    this.buf = new Uint8Array(64);
    this.bufLen = 0;
    this.totalLen = 0;
    this._M = new Int32Array(16);
  }

  update(bytes) {
    this.totalLen += bytes.length;
    let pos = 0;
    if (this.bufLen > 0) {
      const take = Math.min(64 - this.bufLen, bytes.length);
      this.buf.set(bytes.subarray(0, take), this.bufLen);
      this.bufLen += take;
      pos = take;
      if (this.bufLen === 64) {
        this._block(this.buf, 0);
        this.bufLen = 0;
      }
    }
    while (pos + 64 <= bytes.length) {
      this._block(bytes, pos);
      pos += 64;
    }
    if (pos < bytes.length) {
      const rest = bytes.length - pos;
      this.buf.set(bytes.subarray(pos, pos + rest), 0);
      this.bufLen = rest;
    }
  }

  _block(bytes, off) {
    const M = this._M;
    const dv = bytes.buffer && bytes.byteOffset !== undefined
      ? new DataView(bytes.buffer, bytes.byteOffset + off, 64)
      : new DataView(bytes.buffer, off, 64);
    for (let i = 0; i < 16; i++) M[i] = dv.getInt32(i * 4, true);
    let A = this.a0, B = this.b0, C = this.c0, D = this.d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) | 0;
      A = D; D = C; C = B;
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) | 0;
    }
    this.a0 = (this.a0 + A) | 0; this.b0 = (this.b0 + B) | 0;
    this.c0 = (this.c0 + C) | 0; this.d0 = (this.d0 + D) | 0;
  }

  hex() {
    // 填充：0x80 + 0 + 64 位小端长度
    const bitLen = this.totalLen * 8;
    const padLen = this.bufLen < 56 ? 56 - this.bufLen : 120 - this.bufLen;
    const tail = new Uint8Array(this.bufLen + padLen + 8);
    tail.set(this.buf.subarray(0, this.bufLen));
    tail[this.bufLen] = 0x80;
    const dv = new DataView(tail.buffer);
    dv.setUint32(tail.length - 8, bitLen >>> 0, true);
    dv.setUint32(tail.length - 4, Math.floor(bitLen / 2 ** 32), true);
    // 处理尾部块
    let pos = 0;
    while (pos < tail.length) {
      // 最后一块可能包含完整长度；直接逐块处理
      this._block(tail, pos);
      pos += 64;
    }
    const out = new Uint8Array(16);
    const odv = new DataView(out.buffer);
    odv.setInt32(0, this.a0, true); odv.setInt32(4, this.b0, true);
    odv.setInt32(8, this.c0, true); odv.setInt32(12, this.d0, true);
    return Array.from(out).map((x) => x.toString(16).padStart(2, "0")).join("");
  }
}

/** 一次性计算（小数据，测试用） */
export function md5(bytes) {
  const m = new StreamingMD5();
  m.update(bytes);
  return m.hex();
}

export function md5Chunks(chunks, totalLength) {
  const m = new StreamingMD5();
  for (const c of chunks) m.update(c);
  return m.hex();
}
