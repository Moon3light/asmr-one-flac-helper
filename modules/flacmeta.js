// FLAC 容器元数据注入（纯 JS，无需 libflac C API）：
//   FLAC 文件 = "fLaC" + 若干 METADATA_BLOCK + 音频帧
//   block header: 1 字节 [is_last<<7 | type] + 3 字节大端长度
//   STREAMINFO(type=0, 34 字节) 是第一个块；编码器输出中其 is_last=1
//   VORBIS_COMMENT(type=4)：内部整数小端；LYRICS/标题/作者等标签写在这里
//   PICTURE(type=6)：内部整数大端；封面写在这里（picture 内部 type=3 前封面）
//
// 本模块把编码器输出的分块数组（第一个块中必含 "fLaC"+STREAMINFO）
// 原地清掉 STREAMINFO 的 is_last，再插入 VORBIS_COMMENT 与 PICTURE 两个新块，
// 不复制大块音频数据，内存开销近乎为零。

export const FLAC_STREAMINFO = 0;
export const FLAC_VORBIS_COMMENT = 4;
export const FLAC_PICTURE = 6; // FLAC 块类型：5=CUESHEET，6=PICTURE（勿改，曾误改为 5 导致 foobar2000 拒开）

/** 从分块数组中读取指定绝对偏移处的字节（用于跨块解析，仅小块使用） */
function readAt(chunks, offset) {
  for (const c of chunks) {
    if (offset < c.length) return c[offset];
    offset -= c.length;
  }
  return undefined;
}

/** 解析 metadata block 头部列表，返回 [{type, isLast, bodyOffset, bodyLen}]（bodyOffset 为文件绝对偏移） */
export function parseBlockHeaders(chunks, maxBlocks = 64) {
  if (readAt(chunks, 0) !== 0x66 || readAt(chunks, 1) !== 0x4c ||
      readAt(chunks, 2) !== 0x61 || readAt(chunks, 3) !== 0x43) {
    throw new Error("不是 FLAC 文件（缺少 fLaC 魔数）");
  }
  const blocks = [];
  let pos = 4;
  for (let i = 0; i < maxBlocks; i++) {
    const head = readAt(chunks, pos);
    if (head === undefined) throw new Error("FLAC 块头越界");
    const isLast = (head & 0x80) !== 0;
    const type = head & 0x7f;
    const len = (readAt(chunks, pos + 1) << 16) | (readAt(chunks, pos + 2) << 8) | readAt(chunks, pos + 3);
    blocks.push({ type, isLast, bodyOffset: pos + 4, bodyLen: len });
    pos += 4 + len;
    if (isLast) break;
  }
  return blocks;
}

function utf8Bytes(str) {
  return new TextEncoder().encode(str);
}

/** 构造 VORBIS_COMMENT 块（header + body）。tags: Record<string, string|string[]>（空值跳过） */
export function buildVorbisCommentBlock(tags, isLast) {
  const entries = [];
  for (const [key, value] of Object.entries(tags)) {
    for (const v of Array.isArray(value) ? value : [value]) {
      if (v === undefined || v === null || v === "") continue;
      entries.push(`${key}=${v}`);
    }
  }
  const vendor = utf8Bytes("asmr200-flac-helper");
  const parts = [];
  const le = (n) => new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]);
  parts.push(le(vendor.length), vendor, le(entries.length));
  for (const e of entries) {
    const b = utf8Bytes(e);
    parts.push(le(b.length), b);
  }
  const body = concatBytes(parts);
  return buildBlock(FLAC_VORBIS_COMMENT, body, isLast);
}

/** 构造 PICTURE 块。pic: {mime, description, width, height, depth, colors, data: Uint8Array} */
export function buildPictureBlock(pic, isLast) {
  const be = (n) => new Uint8Array([(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
  const mime = utf8Bytes(pic.mime || "image/jpeg");
  const desc = utf8Bytes(pic.description || "");
  const body = concatBytes([
    be(pic.type ?? 3),            // 3 = front cover
    be(mime.length), mime,
    be(desc.length), desc,
    be(pic.width || 0), be(pic.height || 0), be(pic.depth || 0), be(pic.colors || 0),
    be(pic.data.length), pic.data,
  ]);
  return buildBlock(FLAC_PICTURE, body, isLast);
}

function buildBlock(type, body, isLast) {
  const head = new Uint8Array(4);
  head[0] = (isLast ? 0x80 : 0) | (type & 0x7f);
  head[1] = (body.length >> 16) & 0xff;
  head[2] = (body.length >> 8) & 0xff;
  head[3] = body.length & 0xff;
  return concatBytes([head, body]);
}

function concatBytes(arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const a of arrays) {
    out.set(a, pos);
    pos += a.length;
  }
  return out;
}

/**
 * 把标签/封面注入编码器输出的分块数组，返回新的分块数组（不改动原有块）。
 * 注意：编码器的写回调可能任意切分数据（例如 "fLaC" 魔数单独一块，
 * STREAMINFO 横跨前几个分块），因此必须跨块定位 STREAMINFO 边界。
 * @param chunks Uint8Array[]（编码器输出，从文件头开始）
 * @param opts { tags, picture?, pcmMd5? } pcmMd5 用于补写 STREAMINFO 的 MD5 字段
 */
export function injectTags(chunks, { tags = {}, picture = null, pcmMd5 = null } = {}) {
  if (!chunks.length) throw new Error("空分块数组");
  const magic = (readAt(chunks, 0) === 0x66 && readAt(chunks, 1) === 0x4c &&
    readAt(chunks, 2) === 0x61 && readAt(chunks, 3) === 0x43);
  if (!magic) throw new Error("不是 FLAC 文件（缺少 fLaC 魔数）");

  // 第一个块必须是 STREAMINFO；读出头部长度，得到其结束偏移（通常为 42）
  const head = readAt(chunks, 4);
  if (head === undefined || (head & 0x7f) !== FLAC_STREAMINFO) {
    throw new Error("第一个块不是 STREAMINFO");
  }
  const siLen = (readAt(chunks, 5) << 16) | (readAt(chunks, 6) << 8) | readAt(chunks, 7);
  const siEnd = 4 + 4 + siLen;

  // 找到覆盖 siEnd 的前缀分块
  let acc = 0, idx = 0;
  while (idx < chunks.length && acc + chunks[idx].length < siEnd) {
    acc += chunks[idx].length;
    idx++;
  }
  if (idx >= chunks.length) throw new Error("FLAC 头不完整（分块数据不足）");
  const prefix = concatBytes(chunks.slice(0, idx + 1));
  const patchedPrefix = prefix.slice(0, siEnd);
  patchedPrefix[4] = prefix[4] & 0x7f; // 清除 STREAMINFO 的 is_last
  if (pcmMd5 && siLen >= 34) {
    // STREAMINFO 体第 18..34 字节为未编码音频的 MD5（libFLAC min 构建不写，这里补上）
    const md5Off = 4 + 4 + 18;
    for (let i = 0; i < 16; i++) {
      patchedPrefix[md5Off + i] = parseInt(pcmMd5.substr(i * 2, 2), 16);
    }
  }
  const rest0start = siEnd; // 前缀中超出头的部分从音频帧开头计算，见下
  // 原始块链中 STREAMINFO 之后可能还有编码器自带的 vendor VORBIS_COMMENT 等块。
  // 这些块整体被新注入的块替换，必须剥掉，否则它们会残留在新链的 is_last
  // 块之后，成为非法的「孤儿块」，导致严格播放器（foobar2000 等）拒开文件。
  let audioStart = rest0start;
  for (let pos = siEnd, i = 0; i < 64; i++) {
    const head = readAt(chunks, pos);
    if (head === undefined) break; // 分块边界数据不足，保守地按音频紧跟 STREAMINFO 处理
    const isLast = (head & 0x80) !== 0;
    const len = (readAt(chunks, pos + 1) << 16) | (readAt(chunks, pos + 2) << 8) | readAt(chunks, pos + 3);
    pos += 4 + len;
    if (isLast) { audioStart = pos; break; }
  }
  const rest0 = prefix.slice(siEnd);   // 保守回退路径：音频帧开头（含未被识别的原始块残余）

  const picBlock = picture ? buildPictureBlock(picture, true) : null;
  const vorbis = buildVorbisCommentBlock(tags, !picBlock); // 无封面时 vorbis 是最后一块

  const out = [patchedPrefix, vorbis];
  if (picBlock) out.push(picBlock);
  if (audioStart > rest0start) {
    // 跳过被替换的原始元数据残余，从真正的音频帧起点继续
    let acc2 = 0, j = 0;
    while (j < chunks.length && acc2 + chunks[j].length <= audioStart) {
      acc2 += chunks[j].length;
      j++;
    }
    if (j < chunks.length) {
      out.push(chunks[j].subarray(audioStart - acc2));
      for (let k = j + 1; k < chunks.length; k++) out.push(chunks[k]);
      return out;
    }
  }
  if (rest0.length) out.push(rest0);
  for (let i = idx + 1; i < chunks.length; i++) out.push(chunks[i]);
  return out;
}

/** 解析完整 FLAC 文件（小文件，测试用）：返回块列表与解析出的 vorbis 条目/图片 */
export function parseFlac(bytes) {
  const chunks = [bytes];
  const blocks = parseBlockHeaders(chunks);
  const result = { blocks: [], vorbis: {}, picture: null, streamInfo: null };
  for (const b of blocks) {
    const body = bytes.subarray(b.bodyOffset, b.bodyOffset + b.bodyLen);
    result.blocks.push({ type: b.type, isLast: b.isLast, len: b.bodyLen });
    if (b.type === FLAC_STREAMINFO && body.length >= 34) {
      const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
      const sampleRate = (body[10] << 12) | (body[11] << 4) | (body[12] >> 4);
      const channels = ((body[12] >> 1) & 0x7) + 1;
      const bps = (((body[12] & 1) << 4) | (body[13] >> 4)) + 1;
      const totalSamples = ((body[13] & 0xf) * 2 ** 32) + view.getUint32(14);
      const md5 = Array.from(body.subarray(18, 34)).map((x) => x.toString(16).padStart(2, "0")).join("");
      result.streamInfo = { sampleRate, channels, bps, totalSamples, md5 };
    } else if (b.type === FLAC_VORBIS_COMMENT) {
      const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
      let pos = 0;
      const vlen = view.getUint32(pos, true); pos += 4 + vlen;
      const count = view.getUint32(pos, true); pos += 4;
      for (let i = 0; i < count; i++) {
        const elen = view.getUint32(pos, true); pos += 4;
        const entry = new TextDecoder().decode(body.subarray(pos, pos + elen)); pos += elen;
        const eq = entry.indexOf("=");
        if (eq > 0) {
          const k = entry.slice(0, eq).toUpperCase();
          const v = entry.slice(eq + 1);
          result.vorbis[k] = k in result.vorbis ? [].concat(result.vorbis[k], v) : v;
        }
      }
    } else if (b.type === FLAC_PICTURE) {
      const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
      let pos = 0;
      const picType = view.getUint32(pos); pos += 4;
      const mimeLen = view.getUint32(pos); pos += 4;
      const mime = new TextDecoder().decode(body.subarray(pos, pos + mimeLen)); pos += mimeLen;
      const descLen = view.getUint32(pos); pos += 4 + descLen;
      const w = view.getUint32(pos); pos += 4;
      const h = view.getUint32(pos); pos += 4;
      pos += 8; // depth, colors
      const dataLen = view.getUint32(pos); pos += 4;
      result.picture = { type: picType, mime, width: w, height: h, descLen, dataLen, data: body.slice(pos, pos + dataLen) };
    }
  }
  return result;
}
