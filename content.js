// 内容脚本：作品页注入
//  - 提取 RJ 号
//  - 确认页面存在站方“下载”按钮（需求：执行功能前先确认）
//  - 注入浮动按钮，点击后经 background 打开任务页
// 本文件为经典脚本（无 ES module），保持自包含。

(() => {
  // 防止重复注入（动态 executeScript 可能多次执行）
  if (window.__asmrFlacLoaded) return;
  window.__asmrFlacLoaded = true;

  const RJ_RE = /\/work\/(RJ\d+)/i;

  function getRj() {
    const m = RJ_RE.exec(location.pathname);
    return m ? m[1].toUpperCase() : null;
  }

  // 站方下载按钮检测：Quasar 按钮内含 material 图标 download 或文字 下载/Download
  function findDownloadButton() {
    const buttons = document.querySelectorAll('button, .q-btn, [role="button"]');
    for (const b of buttons) {
      if (b.closest('[role="dialog"]')) continue;
      const icon = b.querySelector(".q-icon, .material-icons");
      const iconText = icon ? icon.textContent.trim() : "";
      const text = (b.textContent || "").trim();
      if (iconText === "download" || /^(下载|Download)$/i.test(text)) return b;
    }
    return null;
  }

  function injectFloatingButton() {
    if (document.getElementById("asmr-flac-fab")) return;
    const fab = document.createElement("button");
    fab.id = "asmr-flac-fab";
    fab.textContent = "FLAC";
    fab.title = "ASMR-200 FLAC 助手：下载根目录 wav+vtt 并打包为内嵌歌词的 FLAC";
    Object.assign(fab.style, {
      position: "fixed",
      right: "18px",
      bottom: "18px",
      zIndex: "99999",
      padding: "10px 16px",
      borderRadius: "24px",
      border: "none",
      background: "linear-gradient(135deg,#2176da,#1a4ea6)",
      color: "#fff",
      fontSize: "14px",
      fontWeight: "700",
      letterSpacing: "1px",
      boxShadow: "0 4px 14px rgba(0,0,0,.35)",
      cursor: "pointer",
    });
    fab.addEventListener("mouseenter", () => { fab.style.filter = "brightness(1.1)"; });
    fab.addEventListener("mouseleave", () => { fab.style.filter = ""; });
    fab.addEventListener("click", () => {
      const rj = getRj();
      if (!rj) {
        alert("未能从当前页面识别 RJ 号");
        return;
      }
      if (!findDownloadButton()) {
        alert("未在页面上找到“下载”按钮，无法执行。\n请确认当前是有效的作品页（存在下载功能）。");
        return;
      }
      // 点击时已完成下载按钮检查，随任务单带给任务页（verified）
      chrome.runtime.sendMessage({
        type: "openTask",
        rj,
        href: location.href,
        verified: true,
        meta: extractMeta(),
      });
    });
    document.body.appendChild(fab);
  }

  // 从页面 DOM 提取作品元数据（workInfo API 失败时的兜底）
  function extractMeta() {
    const h1 = document.querySelector("h1");
    const title = h1 ? h1.textContent.trim() : "";
    const circleEl = h1 && h1.nextElementSibling;
    const circle = circleEl ? circleEl.textContent.trim() : "";
    const vas = [...document.querySelectorAll(".q-chip.bg-teal")]
      .map((c) => c.textContent.trim())
      .filter(Boolean);
    return { title, circle, vas };
  }

  // background / 任务页的探测消息
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === "probe") {
      sendResponse({
        ok: true,
        rj: getRj(),
        url: location.href,
        hasDownloadButton: !!findDownloadButton(),
        meta: extractMeta(),
      });
    }
    return false;
  });

  function init() {
    if (!getRj()) return;
    // SPA 渲染轮询：等下载按钮出现后再注入浮动按钮
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      if (findDownloadButton()) {
        clearInterval(timer);
        injectFloatingButton();
      } else if (tries > 20) {
        clearInterval(timer);
      }
    }, 500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
