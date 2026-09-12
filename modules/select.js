// 文件树预选规则：
// 1. BFS 按深度分层，找到最浅的含音频(audio)层；
// 2. 该层的音频按“父文件夹”分组——同一层可能同时出现“有音效版 / 無音效版”
//    这类平行版本文件夹，需要择优一组（排除“其他版本”）；
// 3. 选中组内全部音频 + 同组的 .vtt 字幕。

const RE_OTHER_VERSION = /無音效|无音效|音效なし|効果音なし|off.?vocal|without.?sfx|純人聲|纯人声| instrumental |本篇mp3|本篇mp3|mp3版|mp3バージョン|flac版|简易版|簡易版|低音质|低音質/i;
const RE_MAIN_VERSION = /有音效|効果音あり|本篇|本編|主线|主線|高音质|高音質|ハイレゾ|hi.?res/i;

export function stripExt(title) {
  return String(title || "").replace(/\.[a-z0-9]+$/i, "");
}

/** 把 "xxx.wav.vtt" / "xxx.vtt" 一类的字幕名还原到与音频名可比的基名 */
function vttBaseName(vttTitle) {
  let t = String(vttTitle || "");
  if (/\.vtt$/i.test(t)) t = t.slice(0, -4);
  return stripExt(t);
}

/** 音频标题的基名（去扩展名） */
function audioBaseName(audioTitle) {
  return stripExt(audioTitle);
}

/** 按深度分层（BFS）。返回 [{ depth, nodes: [{node, path}] }] */
export function flattenByLevel(tree) {
  const levels = [];
  let current = (Array.isArray(tree) ? tree : [tree]).map((node) => ({ node, path: "" }));
  let depth = 0;
  while (current.length) {
    levels.push({ depth, nodes: current });
    const next = [];
    for (const { node, path } of current) {
      if (node.type === "folder" && Array.isArray(node.children)) {
        for (const child of node.children) {
          next.push({ node: child, path: path ? `${path}/${node.title}` : node.title });
        }
      }
    }
    current = next;
    depth++;
  }
  return levels;
}

/**
 * 返回预选结果：
 * { levelIndex, items: [{ node, path, kind: 'audio'|'text' }] }
 * 找不到音频时 levelIndex = -1。
 */
export function preselect(tree) {
  const levels = flattenByLevel(tree);
  for (let i = 0; i < levels.length; i++) {
    const { nodes } = levels[i];
    const audio = nodes.filter((n) => n.node.type === "audio");
    if (!audio.length) continue;

    // 按父路径分组（根层的 path 为 ""）
    const groups = new Map(); // path -> [{node, path}]
    for (const a of audio) {
      if (!groups.has(a.path)) groups.set(a.path, []);
      groups.get(a.path).push(a);
    }
    let bestPath = null, bestScore = -Infinity;
    for (const path of groups.keys()) {
      const leaf = path.split("/").pop() || "";
      let score = 0;
      if (RE_OTHER_VERSION.test(leaf)) score -= 10;
      if (RE_MAIN_VERSION.test(leaf)) score += 5;
      // 平分时偏向先出现的组（站点通常把主版本放前面）
      if (score > bestScore) { bestScore = score; bestPath = path; }
    }
    const chosen = groups.get(bestPath) || audio;

    // 同组的 vtt（与选中音频同层、同路径的文本节点）
    const chosenVtts = nodes.filter(
      (n) => n.node.type === "text" && /\.vtt$/i.test(n.node.title || "") && n.path === bestPath
    );
    return {
      levelIndex: i,
      items: [...chosen, ...chosenVtts],
    };
  }
  return { levelIndex: -1, items: [] };
}

/** 为音频文件寻找同组的配对 vtt（"1.xxx.wav" ↔ "1.xxx.wav.vtt" 或 "1.xxx.vtt"） */
export function findVttForAudio(audioTitle, vtts) {
  const base = audioBaseName(audioTitle).toLowerCase();
  for (const v of vtts) {
    if (vttBaseName(v.node.title).toLowerCase() === base) return v;
  }
  return null;
}

/** Windows 非法文件名字符清洗 */
export function safeFilename(name, fallback = "untitled") {
  const cleaned = String(name || "")
    .replace(/[\\/:*?"<>|\r\n]+/g, "_")
    .replace(/\.+$/g, "")
    .trim();
  return cleaned || fallback;
}
