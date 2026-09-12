// 后台 service worker：默认设置、打开任务页、白名单站点动态注入

const DEFAULT_SETTINGS = {
  whitelist: ["asmr-200.com"],   // 默认白名单（域名）
  translator: "custom",          // google | edge | custom（默认走本地 LM Studio）
  customBaseUrl: "http://localhost:1234/v1",
  customApiKey: "",
  customModel: "qwen3-8b",
  bilingual: true,               // 双语歌词（原文+中文）
  keepWav: false,                // 转换后是否保留原始 wav（默认不保留、不落盘）
  saveSideFiles: true,           // 同时保存 .lrc 与 cover.jpg
  compressionLevel: 5,
};

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS));
  const patch = {};
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    if (!(k in cur)) patch[k] = v;
  }
  if (Object.keys(patch).length) await chrome.storage.sync.set(patch);

  // 安装/更新时，向所有已打开的白名单作品页补注入内容脚本
  // （此时这些页面不会触发 manifest 的静态注入）
  try {
    const tabs = await chrome.tabs.query({});
    const list = await getWhitelist();
    for (const tab of tabs) {
      if (!tab.url || !tab.id) continue;
      let host;
      try { host = new URL(tab.url).hostname; } catch (e) { continue; }
      if (!list.includes(host) || !/\/work\//.test(tab.url)) continue;
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }).catch(() => {});
    }
  } catch (e) { /* ignore */ }
});

  // 打开任务页（带来源 tabId，供任务页回探“下载按钮是否存在”）
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "openTask") {
    const tabId = (typeof msg.srcTabId === "number")
      ? msg.srcTabId
      : (sender.tab ? sender.tab.id : chrome.tabs.TAB_ID_NONE);
    const url = chrome.runtime.getURL("pages/task.html") +
      `?rj=${encodeURIComponent(msg.rj)}&src=${encodeURIComponent(msg.href || "")}&srcTab=${tabId}&v=${msg.verified ? 1 : 0}`;
    // 浮动按钮路径：内容脚本已完成下载按钮检查，把验证状态与页面元数据暂存给任务页
    if (msg.verified) {
      chrome.storage.session.set({
        ["probe:" + msg.rj]: { verified: true, meta: msg.meta || null, at: Date.now() },
      }).catch(() => {});
    }
    chrome.tabs.create({ url });
    sendResponse({ ok: true });
    return false;
  }

  // 任务页代探：确保来源标签页里有内容脚本（必要时注入），再执行 probe
  if (msg && msg.type === "probeTab") {
    (async () => {
      const tabId = msg.tabId;
      if (typeof tabId !== "number" || tabId === chrome.tabs.TAB_ID_NONE || tabId < 0) {
        sendResponse({ ok: false, reason: "gone" });
        return;
      }
      let tab = null;
      try {
        tab = await chrome.tabs.get(tabId);
      } catch (e) {
        sendResponse({ ok: false, reason: "gone" });
        return;
      }
      if (!tab.url || !/^https?:/.test(tab.url) || !/\/work\//.test(tab.url)) {
        sendResponse({ ok: false, reason: "notwork" });
        return;
      }
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      let lastErrText = "";
      const tryProbe = async () => {
        try {
          const p = await chrome.tabs.sendMessage(tabId, { type: "probe" });
          return p || null;
        } catch (e) {
          lastErrText = (e && e.message) || String(e);
          return null;
        }
      };
      let probe = await tryProbe();
      if (!probe) {
        // 标签页里可能没有内容脚本（例如扩展在页面打开之后才安装/启用）→ 注入后重试
        try {
          await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
        } catch (e) {
          lastErrText = "注入失败: " + ((e && e.message) || String(e));
        }
        // 注入/渲染需要时间，多重试几轮
        for (let i = 0; i < 5 && !probe; i++) {
          await sleep(500);
          probe = await tryProbe();
        }
      }
      // SPA 渲染：下载按钮尚未出现时再等几轮
      for (let i = 0; i < 6 && probe && !probe.hasDownloadButton; i++) {
        await sleep(500);
        try {
          const p = await chrome.tabs.sendMessage(tabId, { type: "probe" });
          if (p) probe = p;
        } catch (e) { break; }
      }
      if (!probe) {
        sendResponse({ ok: false, reason: "unreachable", error: lastErrText });
        return;
      }
      sendResponse({ ok: true, probe });
    })();
    return true; // 异步 sendResponse
  }
  return false;
});

// 白名单扩展域名（非 asmr-200.com）需动态注入 content script
async function getWhitelist() {
  const { whitelist } = await chrome.storage.sync.get("whitelist");
  return whitelist && whitelist.length ? whitelist : DEFAULT_SETTINGS.whitelist;
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url) return;
  let host;
  try { host = new URL(tab.url).hostname; } catch (e) { return; }
  if (!/\/work\//.test(tab.url)) return;
  const list = await getWhitelist();
  if (!list.includes(host)) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch (e) {
    // 已有内容脚本（content.js 有防重复注入守卫）或权限不足等情况，静默忽略
  }
});
