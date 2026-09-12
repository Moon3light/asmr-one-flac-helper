// WEBVTT 解析 → 带时间轴的 LRC 歌词（支持原文/中文双语两行式）

function parseTimestamp(s) {
  // 形如 00:00:01.643 / 00:01:03.215 / 01:03.215
  const m = /^\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})\s*$/.exec(s);
  if (!m) return null;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  return h * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseInt(m[4].padEnd(3, "0"), 10) / 1000;
}

/** 解析 WEBVTT 文本 → [{ start, end, text }]（时间单位秒，text 内部换行保留 \n） */
export function parseVtt(text) {
  const cues = [];
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  let currentTextLines = null;
  let currentTiming = null;

  const flush = () => {
    if (currentTiming && currentTextLines && currentTextLines.length) {
      const joined = currentTextLines.join("\n").trim();
      if (joined) cues.push({ start: currentTiming.start, end: currentTiming.end, text: joined });
    }
    currentTextLines = null;
    currentTiming = null;
  };

  while (i < lines.length) {
    const line = lines[i];
    const m = /((?:(\d+):)?\d{1,2}:\d{1,2}[.,]\d{1,3})\s*-->\s*((?:(\d+):)?\d{1,2}:\d{1,2}[.,]\d{1,3})/.exec(line);
    if (m) {
      flush();
      const start = parseTimestamp(m[1]);
      const end = parseTimestamp(m[3]);
      if (start != null && end != null) currentTiming = { start, end };
      i++;
      continue;
    }
    if (/^\s*$/.test(line) || /^(WEBVTT|NOTE|STYLE|REGION)\b/i.test(line)) {
      flush();
      i++;
      continue;
    }
    if (currentTiming) {
      if (!currentTextLines) currentTextLines = [];
      currentTextLines.push(line);
    }
    i++;
  }
  flush();
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

export function fmtLrcTime(sec) {
  const s = Math.max(0, sec);
  const mm = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  const xx = Math.floor((s - Math.floor(s)) * 100);
  return `[${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(xx).padStart(2, "0")}]`;
}

/**
 * 生成 LRC 文本。
 * @param cues parseVtt 的结果
 * @param translations 与 cues 对齐的译文数组（每项对应一条 cue，可为 null）
 *                    双语模式：时间轴行 = 原文，下一行 = 同时间轴译文
 */
export function buildLrc(cues, translations = null) {
  const out = [];
  cues.forEach((cue, idx) => {
    const tr = translations ? translations[idx] : null;
    const lines = cue.text.split("\n");
    for (const line of lines) {
      out.push(`${fmtLrcTime(cue.start)}${line}`);
    }
    if (tr) {
      const trLines = String(tr).split("\n");
      for (const line of trLines) {
        out.push(`${fmtLrcTime(cue.start)}${line}`);
      }
    }
  });
  return out.join("\n");
}

// ---- 语言检测 ----
const RE_KANA = /[\u3041-\u3096\u30A1-\u30FA\u30FC]/;
const RE_HANGUL = /[\uAC00-\uD7AF]/;
const RE_HAN = /[\u3400-\u4DBF\u4E00-\u9FFF]/;

// 繁体特有（简化字中不存在的常用字形，采样）
const TRAD_CHARS = "們來時後會開關門問間電車馬鳥語藥點網資訊體聽寫愛寶島聲濕為經這沒讓說對難邊內雙處觸轉還覺靈實歲豐麼舉餘婦臟髮萬與專業叢兩嚴喪廳齊償億憶貨負財貢榮廟慶積識議縣離親餓饅饋駐歡殘軀襯褲覽覺證譯議軌輛輪醫鏡鐘鋼錄餅養額顏風飛餵龍龜齲";
// 简体特有（繁体中不存在的常用字形，采样）
const SIMP_CHARS = "们来时后会开关门问间电车马鸟语药点网资讯体听写爱宝岛声湿为经这没让说对难边内双处触转还觉灵实岁丰么举余妇脏发万与专业丛两严丧厅齐偿亿忆货负财贡庙庆积识议县离亲饿馒馈驻欢残躯衬裤览觉证译议轨辆轮医镜钟钢录饼养额颜风飞喂龙龟"

/**
 * 粗略语言检测：
 * ja（含假名）/ ko（谚文）/ zh-Hant / zh-Hans / other（拉丁等）
 */
export function detectLang(text) {
  const t = String(text || "");
  if (RE_KANA.test(t)) return "ja";
  if (RE_HANGUL.test(t)) return "ko";
  if (RE_HAN.test(t)) {
    let trad = 0, simp = 0;
    for (const ch of t) {
      if (TRAD_CHARS.includes(ch)) trad++;
      else if (SIMP_CHARS.includes(ch)) simp++;
    }
    if (trad > simp) return "zh-Hant";
    if (simp > trad) return "zh-Hans";
    return "zh";
  }
  return "other";
}

/** 是否需要翻译（目标始终是中文；繁体按需求保留不翻） */
export function needsTranslation(lang) {
  return lang !== "zh-Hans" && lang !== "zh-Hant" && lang !== "zh";
}
