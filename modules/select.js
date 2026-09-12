// 文件树预选规则：
// 1. 音频按“父文件夹”分组；
// 2. 优先选择包含 WAV 的组，避免浅层 MP3 版本遮蔽更深层的 WAV；
// 3. 再按版本名称和目录深度择优，选中组内全部音频 + 同组的 .vtt 字幕。

const RE_OTHER_VERSION = /無音效|无音效|音效なし|効果音なし|off.?vocal|without.?sfx|純人聲|纯人声| instrumental |本篇mp3|本篇mp3|mp3|mp3バージョン|flac版|简易版|簡易版|低音质|低音質/i;
const RE_MAIN_VERSION = /有音效|wav|効果音あり|本篇|本編|主线|主線|高音质|高音質|ハイレゾ|hi.?res/i;

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
  const groups = new Map(); // path -> { audio, levelIndex, order }
  let order = 0;

  // 收集整棵树的音频组，不在遇到第一层音频时提前返回。
  for (let i = 0; i < levels.length; i++) {
    for (const entry of levels[i].nodes) {
      if (entry.node.type !== "audio") continue;
      let group = groups.get(entry.path);
      if (!group) {
        group = { audio: [], levelIndex: i, order: order++ };
        groups.set(entry.path, group);
      }
      group.audio.push(entry);
      group.levelIndex = Math.min(group.levelIndex, i);
    }
  }
  if (!groups.size) return { levelIndex: -1, items: [] };

  let best = null;
  for (const [path, group] of groups) {
    const leaf = path.split("/").pop() || "";
    let versionScore = 0;
    if (RE_OTHER_VERSION.test(leaf)) versionScore -= 10;
    if (RE_MAIN_VERSION.test(leaf)) versionScore += 5;
    const hasWav = group.audio.some((a) => /\.wav$/i.test(a.node.title || ""));
    const candidate = { path, ...group, hasWav, versionScore };

    // WAV 优先；同格式时优先主版本、较浅目录，最后保持站点返回顺序。
    if (!best ||
        Number(candidate.hasWav) > Number(best.hasWav) ||
        (candidate.hasWav === best.hasWav && candidate.versionScore > best.versionScore) ||
        (candidate.hasWav === best.hasWav && candidate.versionScore === best.versionScore && candidate.levelIndex < best.levelIndex) ||
        (candidate.hasWav === best.hasWav && candidate.versionScore === best.versionScore && candidate.levelIndex === best.levelIndex && candidate.order < best.order)) {
      best = candidate;
    }
  }

  const chosenVtts = levels[best.levelIndex].nodes.filter(
    (n) => n.node.type === "text" && /\.vtt$/i.test(n.node.title || "") && n.path === best.path
  );
  return {
    levelIndex: best.levelIndex,
    items: [...best.audio, ...chosenVtts],
  };
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
