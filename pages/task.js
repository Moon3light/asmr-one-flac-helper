// 任务页主逻辑：验证下载按钮 → 获取作品/文件树 → 确认清单 → 下载+转换+写标签 → 摘要

import * as api from "../modules/api.js";
import { preselect, findVttForAudio, stripExt, safeFilename } from "../modules/select.js";
import { parseVtt, buildLrc, detectLang, needsTranslation } from "../modules/vtt.js";
import { createTranslator } from "../modules/translate.js";
import { setFlacInstance, flacReady, encodeWavToFlacChunks } from "../modules/flac.js";
import { injectTags } from "../modules/flacmeta.js";
import { pickRootDir, loadRootDir, ensureGrant, ensureSubDir, writeFile, deleteFile } from "../modules/fsout.js";

const $ = (id) => document.getElementById(id);

const state = {
  rj: null,
  srcTab: null,
  settings: {},
  work: null,        // 归一化元数据 { title, circle, vas, date }
  tree: null,
  items: [],            // [{node, path, kind, selected}]
  rootDir: null,        // FileSystemDirectoryHandle
  coverBytes: null,     // Uint8Array | false(false=获取失败)
  coverDims: { w: 0, h: 0 },
  running: false,
  cancelFlag: false,
  abortCtrl: null,
};

// ---------------- 小工具 ----------------

function show(id) { $(id).classList.remove("hidden"); }
function hide(id) { $(id).classList.add("hidden"); }
function errBanner(msg) { $("err-banner").textContent = msg; show("err-banner"); }
function clearBanner() { hide("err-banner"); }

function fmtSize(n) {
  if (!n && n !== 0) return "?";
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
  return (n / 1073741824).toFixed(2) + " GB";
}

function log(msg) {
  const el = $("log");
  el.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

/** 任务页顶部黄色提示（降级/警告信息） */
function logWarn(msg) {
  let el = $("fallback-tip");
  if (!el) {
    el = document.createElement("div");
    el.id = "fallback-tip";
    el.className = "banner";
    el.style.cssText = "background:rgba(217,140,31,.12);color:var(--warn,#b26a00);border:1px solid rgba(217,140,31,.4);margin-bottom:14px;";
    $("err-banner").parentNode.insertBefore(el, $("err-banner"));
  }
  el.textContent = "⚠ " + msg;
  el.classList.remove("hidden");
}

async function saveSettings(patch) {
  Object.assign(state.settings, patch);
  await chrome.storage.sync.set(patch);
}

/** 解析 JPEG 宽高（用于 PICTURE 块元数据，失败不影响功能） */
function jpegSize(bytes) {
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const m = bytes[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: (bytes[i + 5] << 8) | bytes[i + 6], w: (bytes[i + 7] << 8) | bytes[i + 8] };
    }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd9)) { i += 2; continue; }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    i += 2 + len;
  }
  return null;
}

function trackNumber(title, fallbackIdx) {
  const m = /【Track(\d+)】/i.exec(title) || /Track\s*(\d+)/i.exec(title);
  if (m) return String(parseInt(m[1], 10)).padStart(2, "0");
  return String(fallbackIdx + 1).padStart(2, "0");
}

// ---------------- 启动 ----------------

async function loadLibflac() {
  if (typeof window.Flac === "undefined") throw new Error("libflac 脚本未加载");
  setFlacInstance(window.Flac);
  await flacReady();
}

async function init() {
  const params = new URLSearchParams(location.search);
  state.rj = params.get("rj");
  const srcTabRaw = params.get("srcTab");
  const srcTabId = srcTabRaw && srcTabRaw !== "none" ? Number(srcTabRaw) : null;

  state.settings = await chrome.storage.sync.get({});
  $("opt-lyrics").value = state.settings.bilingual ? "bilingual" : "zh-only";
  $("opt-translator").value = state.settings.translator || "google";
  $("opt-comp").value = String(state.settings.compressionLevel ?? 5);
  $("opt-side").checked = !!state.settings.saveSideFiles;
  $("opt-keepwav").checked = !!state.settings.keepWav;

  if (!state.rj) {
    hide("sec-verify");
    errBanner("缺少 RJ 号参数。请从作品页的 FLAC 浮动按钮或工具栏图标进入。");
    return;
  }

  // 1. 需求③：执行前先确认来源页面存在“下载”按钮。
  //    优先级：浮动按钮点击时已完成检查（session 中的 verified 标记）
  //    > background 代探（缺内容脚本会自动注入重试） > 下载 API 兜底验证。
  let verified = false, sessMeta = null;
  if (params.get("v") === "1") {
    try {
      const s = await chrome.storage.session.get("probe:" + state.rj);
      const rec = s && s["probe:" + state.rj];
      if (rec && rec.verified && Date.now() - (rec.at || 0) < 10 * 60 * 1000) {
        verified = true;
        sessMeta = rec.meta || null;
        chrome.storage.session.remove("probe:" + state.rj).catch(() => {});
      }
    } catch (e) { /* ignore */ }
  }

  let probeResult = null;
  if (!verified && srcTabId !== null) {
    try {
      probeResult = await chrome.runtime.sendMessage({ type: "probeTab", tabId: srcTabId });
    } catch (e) {
      probeResult = null;
    }
  }
  const probe = probeResult && probeResult.ok ? probeResult.probe : null;
  state.probe = probe;
  hide("sec-verify");
  if (probe && probe.rj && !probe.hasDownloadButton) {
    // 页面能连上但确实没有下载按钮 → 硬性拒绝（需求③）
    errBanner(
      "来源页面已响应，但未检测到“下载”按钮。" +
      "请确认该作品页带有下载功能；若刚打开页面请稍候几秒再从 FLAC 按钮进入。"
    );
    return;
  }
  if (!verified && (!probe || !probe.rj)) {
    // 消息通道不可用 → 改用下载 API 验证下载能力作为兜底
    try {
      state.tree = await api.getTracks(state.rj);
      const pre = preselect(state.tree);
      const nAudio = pre.items.filter((i) => i.node.type === "audio").length;
      if (nAudio > 0) {
        logWarn(`页面消息通道不可用（${(probeResult && probeResult.error) || "未知原因"}），已改用下载 API 验证：作品含 ${nAudio} 个音频。`);
      } else {
        errBanner("来源页面无法连接，且下载 API 未发现可下载音频（作品可能加载失败或不可下载）。");
        return;
      }
    } catch (e) {
      errBanner(
        "无法连接来源页面，下载 API 也失败（" + (e && e.message || e) + "）。" +
        "请刷新作品页后从 FLAC 按钮重试。"
      );
      return;
    }
  }

  // 2. 拉取文件树 + 作品元数据（workInfo 对部分作品可能失效，DOM 元数据兜底）
  show("sec-loading");
  try {
    await loadLibflac();
    if (!state.tree) state.tree = await api.getTracks(state.rj);
  } catch (e) {
    hide("sec-loading");
    errBanner("获取文件树失败：" + (e && e.message || e));
    return;
  }
  let workInfo = null;
  try {
    workInfo = await api.getWorkInfo(state.rj);
  } catch (e) {
    log(`workInfo API 不可用（${e && e.message || e}），使用页面元数据`);
  }
  // 从文件树节点取标题兜底
  let treeTitle = "";
  (function findTitle(nodes) {
    for (const n of nodes || []) {
      if (n.workTitle) { treeTitle = n.workTitle; return true; }
      if (n.children && findTitle(n.children)) return true;
    }
    return false;
  })(state.tree);
  const dm = (probe && probe.meta) || sessMeta || {};
  state.work = {
    title: (workInfo && (workInfo.title || workInfo.name)) || dm.title || treeTitle || state.rj,
    circle: (workInfo && workInfo.circle && (workInfo.circle.name || workInfo.circle)) || dm.circle || "",
    vas: (workInfo && Array.isArray(workInfo.vas) && workInfo.vas.map((v) => v.name).filter(Boolean))
      || (dm.vas && dm.vas.length ? dm.vas : []),
    date: (workInfo && workInfo.release) || "",
  };
  hide("sec-loading");
  renderWork();
  renderFiles();
  await refreshFolder();
  show("sec-main");
}

// ---------------- 渲染 ----------------

function renderWork() {
  const w = state.work;
  $("w-title").textContent = w.title;
  $("w-circle").textContent = w.circle;
  $("w-vas").textContent = w.vas.length ? "演者: " + w.vas.join("、") : "";
  $("w-date").textContent = w.date;
  $("w-link").href = `https://asmr-200.com/work/${state.rj}`;
  const tagBox = $("w-tags");
  tagBox.innerHTML = "";
  if (!(w.circle || w.vas.length)) tagBox.innerHTML = '<span class="tag">元数据来自页面兜底</span>';
  $("cover").src = api.coverUrl(state.rj);
  if (!$("opt-subdir").value) $("opt-subdir").value = safeFilename(`${state.rj} ${w.title}`);
}

function collectItems() {
  const { items } = preselect(state.tree);
  state.items = items.map((it) => ({
    ...it,
    kind: it.node.type === "audio" ? "audio" : "text",
    selected: it.node.type === "audio" || /\.vtt$/i.test(it.node.title || ""),
  }));
}

function renderFiles() {
  collectItems();
  const box = $("filelist");
  box.innerHTML = "";
  for (const it of state.items) {
    const row = document.createElement("div");
    row.className = "file-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = it.selected;
    cb.addEventListener("change", () => { it.selected = cb.checked; updateTotal(); });
    const ico = document.createElement("span");
    ico.className = "file-ico";
    ico.textContent = it.kind === "audio" ? "🎵" : "📄";
    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = it.node.title;
    const path = document.createElement("span");
    path.className = "file-path";
    path.textContent = it.path || "ROOT";
    path.title = it.path || "ROOT";
    const size = document.createElement("span");
    size.className = "file-size";
    size.textContent = fmtSize(it.node.size);
    row.append(cb, ico, name, path, size);
    box.appendChild(row);
  }
  updateTotal();
}

function selectedAudio() { return state.items.filter((i) => i.kind === "audio" && i.selected); }
function selectedVtts() { return state.items.filter((i) => i.kind === "text" && i.selected); }

function updateTotal() {
  const a = selectedAudio(), v = selectedVtts();
  const bytes = [...a, ...v].reduce((s, i) => s + (i.node.size || 0), 0);
  $("total-line").textContent = `已选 ${a.length} 个音频 + ${v.length} 个字幕，共 ${fmtSize(bytes)}`;
  $("btn-start").disabled = a.length === 0;
  $("start-note").textContent = a.length === 0 ? "请至少勾选一个音频文件" : "";
}

// ---------------- 输出文件夹 ----------------

async function refreshFolder() {
  const loaded = await loadRootDir();
  if (loaded) {
    state.rootDir = loaded.handle;
    $("folder-name").textContent = loaded.handle.name;
    $("btn-grant").classList.toggle("hidden", !loaded.needGrant);
    $("btn-pick").textContent = "重新选择";
  } else {
    state.rootDir = null;
    $("folder-name").textContent = "（未选择）";
    $("btn-grant").classList.add("hidden");
  }
}

// ---------------- 歌词处理 ----------------

/** 展平 cue 行 → 翻译（保持对齐）→ 按行合并回每条 cue 的译文 */
async function translateCueLines(cues) {
  const flat = [];
  const spans = [];
  for (const cue of cues) {
    const lines = cue.text.split("\n");
    spans.push([flat.length, flat.length + lines.length]);
    for (const line of lines) flat.push(line);
  }
  const translator = createTranslator(state.settings);
  let flatTr = [];
  try {
    flatTr = await translator.translateLines(flat, {
      onProgress: (done, total) => setTrackStatus(`翻译中 ${done}/${total}`),
    });
  } catch (e) {
    log(`翻译失败（${e && e.message || e}），歌词保留原文`);
    return null;
  }
  // 翻译接口整体失败时会回退原文——检测并提示
  if (flatTr.every((t, i) => t === flat[i])) {
    log("翻译引擎未返回译文（接口不可达或被限流），歌词保留原文");
    return null;
  }
  return spans.map(([a, b]) => flatTr.slice(a, b).join("\n"));
}

/** 仅中文模式：译文替换原文 */
function buildZhOnlyLrc(cues, translations) {
  return buildLrc(cues.map((c, i) => ({ ...c, text: translations[i] || c.text })), null);
}

/**
 * 下载并处理一个 vtt：
 *  mode: bilingual 双语 | zh-only 仅中文 | orig 仅原文 | none 不嵌入
 *  返回 { lrc, lang }；lrc 为空表示不嵌歌词
 */
async function makeLyrics(vttItem, dirHandle) {
  const raw = await api.downloadText(vttItem.node.hash);
  const cues = parseVtt(raw);
  if (!cues.length) return { lrc: "", lang: "-" };
  const lang = detectLang(cues.map((c) => c.text).join(" "));
  const mode = $("opt-lyrics").value;
  if (mode === "none") return { lrc: "", lang };

  const needTr = needsTranslation(lang) && mode !== "orig";
  const translations = needTr ? await translateCueLines(cues) : null;
  const lrc = (mode === "zh-only" && needTr)
    ? buildZhOnlyLrc(cues, translations)
    : buildLrc(cues, translations);

  if (dirHandle && $("opt-side").checked) {
    const lrcName = safeFilename(stripExt(vttItem.node.title)) + ".lrc";
    await writeFile(dirHandle, lrcName, new Blob([lrc], { type: "text/plain" }));
  }
  return { lrc, lang };
}

// ---------------- 进度 UI ----------------

function setTrackStatus(text) {
  if (state._currentRow) {
    const st = state._currentRow.querySelector(".st");
    st.textContent = text;
    st.className = "st";
  }
}

function setTrackBar(pct) {
  if (state._currentRow) {
    state._currentRow.querySelector(".bar > div").style.width = pct + "%";
  }
}

function addProgressRow(name) {
  const row = document.createElement("div");
  row.className = "prog-row";
  row.innerHTML = `
    <div class="prog-name"><span class="nm"></span><span class="st">等待</span></div>
    <div class="bar"><div></div></div>`;
  row.querySelector(".nm").textContent = name;
  $("prog-list").appendChild(row);
  return row;
}

// ---------------- 标签 ----------------

function buildTagsForTrack(base, trackIdx, lrcText) {
  const w = state.work;
  const tags = {
    TITLE: base,
    ALBUM: w.title,
    TRACKNUMBER: trackNumber(base, trackIdx),
    ORGANIZATION: w.circle,
    DATE: w.date,
    GENRE: "ASMR",
    COMMENT: `来源: https://asmr-200.com/work/${state.rj} (${state.rj})`,
  };
  if (w.vas.length) tags.ARTIST = w.vas.join("、");
  if (w.circle) tags.ALBUMARTIST = w.circle;
  if (lrcText) tags.LYRICS = lrcText;
  return tags;
}

// ---------------- 主流程 ----------------

async function runJobs() {
  clearBanner();
  const audios = selectedAudio();
  const vtts = selectedVtts();
  const subDirName = safeFilename($("opt-subdir").value || state.rj);
  const comp = parseInt($("opt-comp").value, 10);
  const keepWav = $("opt-keepwav").checked;

  await saveSettings({
    bilingual: $("opt-lyrics").value === "bilingual",
    translator: $("opt-translator").value,
    compressionLevel: comp,
    saveSideFiles: $("opt-side").checked,
    keepWav,
  });

  hide("sec-main");
  show("sec-progress");
  $("prog-list").innerHTML = "";
  $("log").textContent = "";
  $("overall-label").textContent = "进行中…";
  $("overall-bar").style.width = "0%";
  $("overall-pct").textContent = "0%";
  hide("sec-done");
  state.running = true;
  state.cancelFlag = false;
  state.abortCtrl = new AbortController();
  const signal = state.abortCtrl.signal;

  let dirHandle;
  try {
    dirHandle = await ensureSubDir(state.rootDir, subDirName);
  } catch (e) {
    errBanner("创建输出子目录失败：" + (e && e.message || e));
    show("sec-main");
    hide("sec-progress");
    state.running = false;
    return;
  }
  log(`输出目录: ${state.rootDir.name}/${subDirName}`);

  // 封面只取一次
  if (state.coverBytes === null) {
    try {
      state.coverBytes = await api.fetchCover(state.rj, { signal });
      state.coverDims = jpegSize(state.coverBytes) || { w: 0, h: 0 };
      log(`封面已获取 ${fmtSize(state.coverBytes.length)}`);
    } catch (e) {
      state.coverBytes = false;
      log("封面获取失败（将继续，但 FLAC 不含内嵌封面）");
    }
  }
  if ($("opt-side").checked && state.coverBytes) {
    try { await writeFile(dirHandle, "cover.jpg", new Blob([state.coverBytes])); } catch (e) { log("cover.jpg 写入失败: " + (e && e.message || e)); }
  }

  const results = [];
  let doneCount = 0;

  for (let idx = 0; idx < audios.length; idx++) {
    if (state.cancelFlag) break;
    const item = audios[idx];
    const base = stripExt(item.node.title);
    const wavName = safeFilename(base) + ".wav";
    const flacName = safeFilename(base) + ".flac";
    const row = addProgressRow(item.node.title);
    state._currentRow = row;
    const setSt = (t, cls) => {
      const st = row.querySelector(".st");
      st.textContent = t;
      st.className = "st" + (cls ? " " + cls : "");
    };

    let wavWritable = null;
    try {
      // 1) 字幕 → 歌词
      const vttItem = findVttForAudio(item.node.title, vtts);
      let lrc = "";
      if (vttItem) {
        setSt("处理字幕");
        const r = await makeLyrics(vttItem, dirHandle);
        lrc = r.lrc;
        log(`${base}: 字幕语言=${r.lang}${r.lrc ? "" : "（不嵌入歌词）"}`);
      } else {
        log(`${base}: 未找到配对 vtt，跳过歌词`);
      }
      if (state.cancelFlag) throw new DOMException("aborted", "AbortError");

      // 2) 下载 wav（流式，可选同步写 wav）→ FLAC 编码
      if (keepWav) {
        const fh = await dirHandle.getFileHandle(wavName, { create: true });
        wavWritable = await fh.createWritable();
      }
      const iter = api.downloadMedia(item.node.hash, {
        signal,
        onProgress: (rec, tot) => {
          const pct = tot ? Math.min(100, Math.round((rec / tot) * 100)) : 0;
          setSt(`下载中 ${pct}%`);
          setTrackBar(Math.round(pct * 0.7));
        },
        expectedSize: item.node.size,
      });
      const readChunk = async () => {
        const { done, value } = await iter.next();
        if (done) return null;
        if (wavWritable) await wavWritable.write(value);
        return value;
      };

      setSt("下载+编码");
      let info = null;
      const { chunks, pcmMd5 } = await encodeWavToFlacChunks(readChunk, {
        expectedSize: item.node.size,
        compressionLevel: comp,
        signal,
        onHeader: (h) => { info = h; log(`${base}: ${h.sampleRate}Hz / ${h.bits}bit / ${h.channels}ch`); },
      });

      // 3) 注入标签/歌词/封面 → 写入
      setSt("写入标签");
      const tags = buildTagsForTrack(base, idx, lrc);
      const picture = state.coverBytes ? {
        mime: "image/jpeg",
        description: "cover",
        width: state.coverDims.w,
        height: state.coverDims.h,
        data: state.coverBytes,
      } : null;
      const finalChunks = injectTags(chunks, { tags, picture, pcmMd5 });
      const blob = new Blob(finalChunks, { type: "audio/flac" });
      await writeFile(dirHandle, flacName, blob);
      if (wavWritable) { await wavWritable.close(); wavWritable = null; }
      log(`${base}: FLAC 完成 ${fmtSize(blob.size)}${pcmMd5 ? ` (PCM MD5 ${pcmMd5})` : ""}`);

      // 4) 清理原始 wav
      if (keepWav) {
        await deleteFile(dirHandle, wavName);
        log(`${base}: 已删除原始 wav`);
      }

      setSt("完成 ✓", "ok");
      setTrackBar(100);
      results.push({ name: item.node.title, ok: true });
    } catch (e) {
      if (wavWritable) { try { await wavWritable.abort(); } catch (_) { /* ignore */ } }
      const aborted = e && e.name === "AbortError";
      setSt(aborted ? "已取消" : "失败: " + (e && e.message || e), aborted ? "" : "err");
      results.push({ name: item.node.title, ok: false, err: aborted ? "已取消" : (e && e.message || String(e)) });
      log(`${base}: ${aborted ? "已取消" : "失败 " + (e && e.message || e)}`);
      if (aborted) break;
    }
    state._currentRow = null;
    doneCount++;
    const pct = Math.round((doneCount / audios.length) * 100);
    $("overall-bar").style.width = pct + "%";
    $("overall-pct").textContent = pct + "%";
  }

  state.running = false;
  const okN = results.filter((r) => r.ok).length;
  $("overall-label").textContent = state.cancelFlag ? "已取消" : "完成";
  if (results.length) {
    $("overall-bar").style.width = "100%";
    $("overall-pct").textContent = `${okN}/${results.length}`;
  }
  show("sec-done");
  $("done-banner").textContent = state.cancelFlag
    ? `已取消（成功 ${okN} / 共 ${results.length}）`
    : okN === results.length ? `全部完成！成功 ${okN} 个` : `完成：成功 ${okN} / ${results.length}（存在失败项）`;
  $("done-list").innerHTML = results.map((r) =>
    `<li>${r.ok ? "✅" : "❌"} ${r.name}${r.err ? " — " + r.err : ""}</li>`).join("");
  log(`输出: ${state.rootDir.name}/${subDirName}（成功 ${okN}/${results.length}）`);
}

// ---------------- 事件绑定 ----------------

$("btn-all").addEventListener("click", () => {
  state.items.forEach((i) => { i.selected = true; });
  renderFilesSelection();
});
$("btn-none").addEventListener("click", () => {
  state.items.forEach((i) => { i.selected = false; });
  renderFilesSelection();
});
$("btn-recommend").addEventListener("click", () => renderFiles());
function renderFilesSelection() {
  const rows = $("filelist").querySelectorAll("input[type=checkbox]");
  state.items.forEach((it, i) => { rows[i].checked = it.selected; });
  updateTotal();
}

$("btn-pick").addEventListener("click", async () => {
  try {
    await pickRootDir();
    await refreshFolder();
  } catch (e) {
    if (e && e.name !== "AbortError") alert("选择文件夹失败: " + (e && e.message || e));
  }
});
$("btn-grant").addEventListener("click", async () => {
  if (state.rootDir) {
    const ok = await ensureGrant(state.rootDir);
    if (ok) await refreshFolder();
    else alert("未授予写入权限，无法保存文件");
  }
});
$("btn-start").addEventListener("click", async () => {
  const loaded = await loadRootDir();
  if (loaded && loaded.needGrant) {
    const ok = await ensureGrant(loaded.handle);
    if (!ok) { alert("需要写入权限才能保存文件"); return; }
  } else if (!loaded) {
    try { await pickRootDir(); } catch (e) { return; }
  }
  await refreshFolder();
  if (!state.rootDir) { alert("请先选择保存文件夹"); return; }
  await runJobs();
});
$("btn-cancel").addEventListener("click", () => {
  state.cancelFlag = true;
  if (state.abortCtrl) state.abortCtrl.abort();
});
$("btn-again").addEventListener("click", () => {
  hide("sec-done");
  hide("sec-progress");
  show("sec-main");
});

init();
