// WAV(PCM) 流式 → FLAC 编码（libflac.js WASM）。
// 设计要点：
//  - 边下载边编码：调用方持续喂入 Uint8Array 分块（无需整块载入内存）
//  - 自动解析 RIFF/fmt 头（支持 PCM / WAVE_FORMAT_EXTENSIBLE，16/24/32 位整型与 8 位无符号）
//  - 输出为 Uint8Array 分块数组，随后由 flacmeta.injectTags 注入歌词/封面/标签
//  - 环境无关：通过 setFlacInstance() 注入 libflac 实例（浏览器为 window.Flac，Node 为 require 的 UMD 导出）

import { StreamingMD5 } from "./md5.js";

let FlacInstance = null;
export function setFlacInstance(f) {
  FlacInstance = f;
}
export function getFlacInstance() {
  return FlacInstance;
}

/** 等待 libflac WASM 就绪 */
export function flacReady() {
  if (!FlacInstance) throw new Error("尚未注入 libflac 实例（setFlacInstance）");
  if (FlacInstance.isReady && FlacInstance.isReady()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("libflac 初始化超时")), 30000);
    FlacInstance.onready = () => { clearTimeout(t); resolve(); };
  });
}

/** 解析 RIFF 头，返回 { sampleRate, channels, bits, dataOffset, dataSize, format } */
export function parseWavHeader(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12) throw new Error("WAV 头不完整");
  if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== "RIFF" ||
      String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) !== "WAVE") {
    throw new Error("不是 RIFF/WAVE 文件");
  }
  let pos = 12;
  let fmt = null;
  while (pos + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
    const size = dv.getUint32(pos + 4, true);
    if (id === "fmt ") {
      const audioFormat = dv.getUint16(pos + 8, true);
      const channels = dv.getUint16(pos + 10, true);
      const sampleRate = dv.getUint32(pos + 12, true);
      const blockAlign = dv.getUint16(pos + 20, true);
      const bits = dv.getUint16(pos + 22, true);
      let format = audioFormat;
      if (audioFormat === 0xfffe && size >= 40) {
        // WAVE_FORMAT_EXTENSIBLE：末尾 GUID 前 16 字节标识子格式
        const sub = bytes.subarray(pos + 8 + 24, pos + 8 + 40);
        const isPcm = sub[0] === 0x01 && sub[1] === 0x00 && sub[2] === 0x00 && sub[3] === 0x00 &&
          sub[4] === 0x00 && sub[5] === 0x00 && sub[6] === 0x10 && sub[7] === 0x00 &&
          sub[8] === 0x80 && sub[9] === 0x00 && sub[10] === 0x00 && sub[11] === 0xaa &&
          sub[12] === 0x00 && sub[13] === 0x38 && sub[14] === 0x9b && sub[15] === 0x71;
        if (!isPcm) throw new Error("仅支持 PCM WAV（子格式非 PCM）");
        format = 1;
      }
      fmt = { format, channels, sampleRate, blockAlign, bits };
    } else if (id === "data") {
      if (!fmt) throw new Error("data 块出现在 fmt 之前");
      return { ...fmt, dataOffset: pos + 8, dataSize: size };
    }
    pos += 8 + size + (size % 2);
  }
  throw new Error("WAV 头中缺少 data 块");
}

/**
 * 流式编码。
 * @param readChunk async () => Uint8Array|null  逐块读取源 WAV（null 表示结束）
 * @param opts { expectedSize, compressionLevel, onProgress(received,total), signal, onHeader(info) }
 * @returns { chunks: Uint8Array[], info: {sampleRate, channels, bits, totalSamples}, pcmMd5: string }
 */
export async function encodeWavToFlacChunks(readChunk, opts = {}) {
  const { expectedSize = 0, compressionLevel = 5, onProgress, signal, onHeader } = opts;
  await flacReady();
  const Flac = FlacInstance;
  const md5er = new StreamingMD5(); // 始终计算 PCM MD5（用于补写 STREAMINFO）

  // 1. 聚合头部字节直到解析出 fmt + data
  let header = new Uint8Array(0);
  let headerInfo = null;
  for (;;) {
    const chunk = await readChunk();
    if (!chunk) throw new Error("WAV 数据在头部就结束了");
    const merged = new Uint8Array(header.length + chunk.length);
    merged.set(header);
    merged.set(chunk, header.length);
    header = merged;
    try {
      headerInfo = parseWavHeader(header);
      break;
    } catch (e) {
      if (/data 块/.test(e.message) && header.length > 4 * 1024 * 1024) throw e;
      continue;
    }
  }
  const { sampleRate, channels, bits, dataOffset, dataSize } = headerInfo;
  const totalSamples = dataSize > 0 ? Math.floor(dataSize / (channels * ((bits + 7) >> 3))) : 0;
  if (onHeader) onHeader({ sampleRate, channels, bits, totalSamples });

  if (![8, 16, 24, 32].includes(bits)) throw new Error(`不支持的位深: ${bits}`);

  // 2. 建立编码器
  const encoder = Flac.create_libflac_encoder(sampleRate, channels, bits, compressionLevel, totalSamples, 0, 0);
  if (!encoder) throw new Error("创建 FLAC 编码器失败");
  // 让 libFLAC 计算未编码 PCM 的 MD5（写入 STREAMINFO，便于校验）
  if (Flac.FLAC__stream_encoder_set_md5_checking) Flac.FLAC__stream_encoder_set_md5_checking(encoder, 1);
  const chunks = [];
  let writeError = null;
  const status = Flac.init_encoder_stream(encoder, (data, bytes) => {
    if (writeError) return;
    try {
      // wrapper 已从 WASM 堆复制到独立 Uint8Array，直接持有
      chunks.push(data);
    } catch (e) {
      writeError = e;
    }
  });
  if (status !== 0) throw new Error(`初始化 FLAC 编码流失败: ${status}`);

  // 3. 逐块转换 PCM 并喂入编码器
  const bytesPerSample = bits >> 3 || 1;
  const blockAlign = channels * bytesPerSample;
  const FRAME_SAMPLES = 4096;
  const pcmBuf = new Int32Array(FRAME_SAMPLES * channels);

  // 处理 data 偏移前的残余头部数据
  let pending = header.subarray(dataOffset);
  let received = header.length;
  let processedBytes = 0;
  let dataRemaining = dataSize;

  const feed = (bytes) => {
    // bytes: 采样数据（按块对齐截断），转 Int32 交错并写编码器
    const usable = bytes.length - (bytes.length % blockAlign);
    if (usable <= 0) return bytes.length;
    md5er.update(bytes.subarray(0, usable));
    const framesTotal = usable / blockAlign;
    let off = 0;
    while (off < framesTotal) {
      const n = Math.min(FRAME_SAMPLES, framesTotal - off);
      const start = off * blockAlign;
      for (let i = 0; i < n * channels; i++) {
        const p = start + i * bytesPerSample;
        switch (bits) {
          case 8: pcmBuf[i] = bytes[p] - 128; break;
          case 16: pcmBuf[i] = (bytes[p] | (bytes[p + 1] << 8)) << 16 >> 16; break;
          case 24: pcmBuf[i] = ((bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16)) << 8) >> 8; break;
          case 32: pcmBuf[i] = bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24); break;
        }
      }
      if (!Flac.FLAC__stream_encoder_process_interleaved(encoder, pcmBuf.subarray(0, n * channels), n)) {
        throw new Error("FLAC 编码失败（process_interleaved）");
      }
      if (writeError) throw writeError;
      off += n;
    }
    return usable;
  };

  const consume = (chunkBytes) => {
    if (dataRemaining <= 0) return;
    let buf = pending.length ? concat(pending, chunkBytes) : chunkBytes;
    // 只编码 WAV data 块，避免把 data 后面的 LIST/JUNK 等元数据当成 PCM。
    const dataBuf = buf.subarray(0, Math.min(buf.length, dataRemaining));
    const used = feed(dataBuf);
    pending = dataBuf.subarray(used);
    dataRemaining -= used;
    processedBytes += used;
  };

  for (;;) {
    if (signal && signal.aborted) {
      Flac.FLAC__stream_encoder_delete(encoder);
      throw new DOMException("aborted", "AbortError");
    }
    const chunk = await readChunk();
    if (!chunk) break;
    received += chunk.length;
    consume(chunk);
    if (onProgress) onProgress(received, expectedSize);
  }
  // 丢弃不足一帧的残余（<1 样本时无需处理；此处按字节四舍五入丢弃）
  if (onProgress) onProgress(received, expectedSize || received);

  // 4. 结束
  const ok = Flac.FLAC__stream_encoder_finish(encoder);
  Flac.FLAC__stream_encoder_delete(encoder);
  if (!ok && !chunks.length) throw new Error("FLAC finish 失败");

  // STREAMINFO 的 MD5 由 libFLAC 的 md5_checking 写出，但 min 构建未导出该开关，
  // 这里用自己的流式 MD5 结果，由 injectTags 补写进 STREAMINFO
  const pcmMd5 = md5er.hex();

  return {
    chunks,
    info: { sampleRate, channels, bits, totalSamples: Math.floor(processedBytes / blockAlign) },
    pcmMd5,
  };
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
