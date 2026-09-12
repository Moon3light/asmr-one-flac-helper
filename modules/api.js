// asmr-200 (Kikoeru) 公开 API 封装
// 站点前端调用 api.asmr-200.com 的 workInfo / tracks / cover / media 端点，均无需登录 token。

export const DEFAULT_API_BASE = "https://api.asmr-200.com";

/** "RJ01522889" -> "01522889"；非法输入返回 null */
export function rjToNumeric(rj) {
  const m = /RJ(\d+)/i.exec(String(rj || ""));
  return m ? m[1] : null;
}

/** 从 /work/RJ01522889 形式的 URL 提取 RJ 号 */
export function rjFromUrl(url) {
  const m = /\/work\/(RJ\d+)/i.exec(String(url || ""));
  return m ? m[1].toUpperCase() : null;
}

async function fetchWithRetry(url, { signal, retries = 2, headers } = {}) {
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    if (signal && signal.aborted) throw new DOMException("aborted", "AbortError");
    try {
      const r = await fetch(url, { signal, headers: headers || { Accept: "application/json" } });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
      return r;
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      lastErr = e;
      if (i < retries) await new Promise((res) => setTimeout(res, 800 * (i + 1)));
    }
  }
  throw lastErr;
}

/** 作品元数据：标题 / 社团 / 声优 / 日期 / 封面地址 */
export async function getWorkInfo(rj, { base = DEFAULT_API_BASE, signal } = {}) {
  const id = rjToNumeric(rj);
  const r = await fetchWithRetry(`${base}/api/workInfo/${id}`, { signal });
  return r.json();
}

/** 完整文件树：节点 { type: folder|audio|text, title, size, hash, children } */
export async function getTracks(rj, { base = DEFAULT_API_BASE, signal } = {}) {
  const id = rjToNumeric(rj);
  // 服务端偶发返回空数组，这里把“空结果”也纳入重试
  let lastErr = null;
  for (let i = 0; i <= 3; i++) {
    if (signal && signal.aborted) throw new DOMException("aborted", "AbortError");
    try {
      const r = await fetch(`${base}/api/tracks/${id}?v=2`, { signal, headers: { Accept: "application/json" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const arr = Array.isArray(j) ? j : [j];
      if (arr.length && arr.some((n) => n && (n.children || n.hash))) return arr;
      throw new Error("tracks 为空，重试");
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      lastErr = e;
      await new Promise((res) => setTimeout(res, 800 * (i + 1)));
    }
  }
  throw lastErr;
}

export function coverUrl(rj, { base = DEFAULT_API_BASE, type = "main" } = {}) {
  return `${base}/api/cover/${rjToNumeric(rj)}.jpg?type=${type}`;
}

export async function fetchCover(rj, { base = DEFAULT_API_BASE, signal } = {}) {
  const r = await fetchWithRetry(coverUrl(rj, { base }), { signal, headers: {} });
  return new Uint8Array(await r.arrayBuffer());
}

export function mediaUrl(hash, { base = DEFAULT_API_BASE } = {}) {
  return `${base}/api/media/download/${hash}`;
}

/**
 * 流式下载一个媒体文件，依次产出 Uint8Array 分块。
 * onProgress(receivedBytes, totalBytes) 在每块后回调。
 */
export async function* downloadMedia(hash, { base = DEFAULT_API_BASE, signal, onProgress, expectedSize = 0 } = {}) {
  const r = await fetch(mediaUrl(hash, { base }), { signal });
  if (!r.ok) throw new Error(`HTTP ${r.status} 下载失败: ${hash}`);
  const total = Number(r.headers.get("content-length")) || expectedSize || 0;
  if (!r.body) {
    const buf = new Uint8Array(await r.arrayBuffer());
    if (onProgress) onProgress(buf.length, total || buf.length);
    yield buf;
    return;
  }
  const reader = r.body.getReader();
  let received = 0;
  for (;;) {
    if (signal && signal.aborted) throw new DOMException("aborted", "AbortError");
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (onProgress) onProgress(received, total);
    yield value;
  }
}

/** 下载整个小文件（vtt / 封面等）为文本或字节 */
export async function downloadText(hash, opts = {}) {
  let text = "";
  for await (const chunk of downloadMedia(hash, opts)) text += new TextDecoder("utf-8").decode(chunk);
  return text;
}
