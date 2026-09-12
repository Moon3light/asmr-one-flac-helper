// 可插拔翻译模块。
// 内置三个实现：
//  - google:  Google 翻译网页免费接口（translate.googleapis.com，无需 key，默认）
//  - edge:    微软 Edge 免费翻译（edge.microsoft.com 认证 + cognitive translator，实验性）
//  - custom:  自定义 OpenAI 兼容 chat/completions 接口（baseUrl + apiKey + model）
// 统一接口： translator.translateLines(lines: string[], {signal, onProgress}) => Promise<string[]>
// 返回数组与输入按索引一一对应（保持时间轴对齐）。

const TARGET = "zh-CN";

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

/** 将行列表打包成不超过 maxChars/最大行数限制的批 */
function packBatches(lines, maxChars, maxLines) {
  const batches = [];
  let cur = [], chars = 0;
  for (const line of lines) {
    const len = line.length + 1;
    if (cur.length && (chars + len > maxChars || cur.length >= maxLines)) {
      batches.push(cur);
      cur = []; chars = 0;
    }
    cur.push(line);
    chars += len;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

async function runWithConcurrency(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

// ---------------- Google (gtx) ----------------

async function googleSingle(line, signal) {
  const url =
    "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=" +
    TARGET +
    "&dt=t&q=" +
    encodeURIComponent(line);
  const r = await fetch(url, { signal, headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`google HTTP ${r.status}`);
  const j = await r.json();
  return (j[0] || []).map((seg) => (seg && seg[0]) || "").join("");
}

async function googleBatch(lines, signal) {
  try {
    const q = lines.join("\n");
    const url =
      "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=" +
      TARGET +
      "&dt=t&q=" +
      encodeURIComponent(q);
    const r = await fetch(url, { signal, headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(`google HTTP ${r.status}`);
    const j = await r.json();
    const full = (j[0] || []).map((seg) => (seg && seg[0]) || "").join("");
    const parts = full.split("\n");
    if (parts.length === lines.length) return parts.map((s) => s.trim());
    throw new Error("line count mismatch");
  } catch (e) {
    // 批量失败（含行数不齐）→ 逐行兜底
    const out = [];
    for (const line of lines) {
      out.push((await googleSingle(line, signal)).trim());
      await sleep(80);
    }
    return out;
  }
}

export function makeGoogleTranslator() {
  return {
    name: "google",
    async translateLines(lines, { signal, onProgress } = {}) {
      const unique = [...new Set(lines)];
      const batches = packBatches(unique, 900, 40);
      let done = 0;
      // runWithConcurrency 保持 results 与 batches 同序
      const results = await runWithConcurrency(
        batches.map((b) => async () => {
          let out = null;
          for (let attempt = 0; attempt < 3 && out === null; attempt++) {
            try {
              out = await googleBatch(b, signal);
            } catch (e) {
              if (e && e.name === "AbortError") throw e;
              await sleep(600 * (attempt + 1));
            }
          }
          if (out === null) out = b; // 彻底失败时保留原文
          done += b.length;
          if (onProgress) onProgress(done, unique.length);
          return out;
        }),
        3
      );
      // 批与批之间按顺序拼接，即可与 unique 一一对应
      const map = new Map();
      let idx = 0;
      for (const res of results) {
        for (let i = 0; i < res.length; i++, idx++) map.set(unique[idx], res[i]);
      }
      return lines.map((l) => map.get(l) ?? l);
    },
  };
}

// ---------------- Edge (Microsoft) ----------------

export function makeEdgeTranslator() {
  let token = null;
  async function ensureToken(signal) {
    if (token) return token;
    const r = await fetch("https://edge.microsoft.com/translate/auth", { method: "POST", signal });
    if (!r.ok) throw new Error(`edge auth HTTP ${r.status}`);
    token = (await r.text()).trim();
    return token;
  }
  return {
    name: "edge",
    async translateLines(lines, { signal, onProgress } = {}) {
      const unique = [...new Set(lines)];
      const out = [];
      for (let i = 0; i < unique.length; i += 100) {
        const part = unique.slice(i, i + 100);
        let ok = false;
        for (let attempt = 0; attempt < 3 && !ok; attempt++) {
          try {
            const tk = await ensureToken(signal);
            const r = await fetch(
              "https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=zh-Hans",
              {
                method: "POST",
                signal,
                headers: { Authorization: "Bearer " + tk, "Content-Type": "application/json" },
                body: JSON.stringify(part.map((Text) => ({ Text }))),
              }
            );
            if (!r.ok) throw new Error(`edge HTTP ${r.status}`);
            const j = await r.json();
            for (let k = 0; k < part.length; k++) {
              out[i + k] = j[k] && j[k].translations && j[k].translations[0] ? j[k].translations[0].text : part[k];
            }
            ok = true;
          } catch (e) {
            if (e && e.name === "AbortError") throw e;
            token = null;
            if (attempt === 2) {
              for (let k = 0; k < part.length; k++) out[i + k] = part[k];
            } else await sleep(600 * (attempt + 1));
          }
        }
        if (onProgress) onProgress(Math.min(unique.length, i + 100), unique.length);
      }
      const map = new Map(unique.map((l, idx) => [l, out[idx]]));
      return lines.map((l) => map.get(l) ?? l);
    },
  };
}

// ---------------- 自定义 OpenAI 兼容接口（LM Studio / Ollama / 各类本地或在线服务） ----------------

// LM Studio 默认地址；模型需在设置中选择（如 qwen3-8b）
export const CUSTOM_BASE_DEFAULT = "http://localhost:1234/v1";

function stripThinking(text) {
  // 剥离思考型模型（qwen3 / deepseek-r1 等）的 <think>...</think> 块
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^<think>[\s\S]*/i, (m) => (m.includes("</think>") ? m.replace(/<think>[\s\S]*?<\/think>/gi, "") : ""))
    .trim();
}

/** 解析编号行输出："1.译文\n2.译文"，容错全角标点/项目符号 */
function parseNumberedLines(content, expected) {
  const map = new Map();
  const re = /^\s*(\d{1,3})\s*[.、:：)）]\s*(.+)$/gm;
  let m;
  while ((m = re.exec(content)) !== null) {
    const idx = parseInt(m[1], 10) - 1;
    if (idx >= 0 && idx < expected && !map.has(idx)) map.set(idx, m[2].trim());
  }
  if (map.size < expected) return null;
  return Array.from({ length: expected }, (_, i) => map.get(i));
}

function parseJsonArray(content, expected) {
  const m = /\[[\s\S]*\]/.exec(content);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[0]);
    if (Array.isArray(arr) && arr.length === expected) {
      const strs = arr.map((x) => (x == null ? "" : String(x).trim()));
      if (strs.every((s) => s.length > 0)) return strs;
    }
  } catch (e) { /* ignore */ }
  return null;
}

export function makeCustomTranslator({ baseUrl, apiKey, model }) {
  const url = (baseUrl || CUSTOM_BASE_DEFAULT).replace(/\/+$/, "") + "/chat/completions";
  const SYSTEM_PROMPT =
    "你是歌词字幕翻译器。用户会给出编号的歌词行。把每一行翻译成简体中文，" +
    "保持语气、省略号等标点与换行风格。只输出编号行，格式严格为：数字.译文，" +
    "每行一条，不要输出任何其他内容。/no_think";

  async function chat(messages, signal) {
    const r = await fetch(url, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: "Bearer " + apiKey } : {}),
      },
      body: JSON.stringify({ model: model || "", temperature: 0, messages, max_tokens: -1 }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`custom HTTP ${r.status} ${body.slice(0, 120)}`);
    }
    const j = await r.json();
    return j.choices && j.choices[0] && j.choices[0].message ? (j.choices[0].message.content || "") : "";
  }

  async function batchTranslate(batch, signal, attempt) {
    const user = batch.map((l, i) => `${i + 1}.${l}`).join("\n");
    const content = await chat([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: user },
    ], signal);
    const cleaned = stripThinking(content);
    // 第一次尝试编号行；重试时给更强的格式约束并改用 JSON
    if (attempt === 0) {
      return parseNumberedLines(cleaned, batch.length) || parseJsonArray(cleaned, batch.length);
    }
    const content2 = await chat([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: user + "\n\n请改用 JSON 字符串数组输出，数组长度必须为 " + batch.length + "，与输入顺序对应。" },
      { role: "assistant", content: cleaned.slice(0, 500) },
      { role: "user", content: "输出 JSON 数组：" },
    ], signal);
    return parseJsonArray(stripThinking(content2), batch.length);
  }

  return {
    name: "custom",
    async translateLines(lines, { signal, onProgress } = {}) {
      const unique = [...new Set(lines)];
      const batches = packBatches(unique, 1500, 20);
      let done = 0;
      // 本地推理服务串行处理请求，并发保持 1
      const results = [];
      for (const b of batches) {
        let out = null;
        for (let attempt = 0; attempt < 3 && out === null; attempt++) {
          try {
            out = await batchTranslate(b, signal, attempt >= 1 ? 1 : 0);
          } catch (e) {
            if (e && e.name === "AbortError") throw e;
            if (attempt === 2) break;
          }
        }
        results.push(out || b);
        done += b.length;
        if (onProgress) onProgress(Math.min(done, unique.length), unique.length);
      }
      const map = new Map();
      let idx = 0;
      for (const res of results) {
        for (let i = 0; i < res.length; i++, idx++) map.set(unique[idx], res[i]);
      }
      return lines.map((l) => map.get(l) ?? l);
    },
    /** 探测可用模型（LM Studio /v1/models） */
    async listModels() {
      const base = (baseUrl || CUSTOM_BASE_DEFAULT).replace(/\/+$/, "");
      const r = await fetch(base + "/models", { headers: apiKey ? { Authorization: "Bearer " + apiKey } : {} });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      return (j.data || []).map((m) => m.id).filter((id) => id && !/embed/i.test(id));
    },
  };
}

export function createTranslator(settings = {}) {
  const kind = settings.translator || "google";
  if (kind === "edge") return makeEdgeTranslator();
  if (kind === "custom")
    return makeCustomTranslator({
      baseUrl: settings.customBaseUrl,
      apiKey: settings.customApiKey,
      model: settings.customModel,
    });
  return makeGoogleTranslator();
}
