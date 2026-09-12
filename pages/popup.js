// 工具栏弹窗：检查当前标签页是否为白名单作品页，提供入口

const $ = (id) => document.getElementById(id);

async function getWhitelist() {
  const { whitelist } = await chrome.storage.sync.get({ whitelist: ["asmr-200.com"] });
  return whitelist && whitelist.length ? whitelist : ["asmr-200.com"];
}

async function init() {
  const status = $("status");
  const btn = $("btn-open");
  let tab = null;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (e) { /* ignore */ }
  if (!tab || !tab.url) {
    status.textContent = "无法读取当前标签页。请刷新页面后重试。";
    return;
  }
  let url;
  try { url = new URL(tab.url); } catch (e) { url = null; }
  if (!url || !/^https?:$/.test(url.protocol)) {
    status.textContent = "当前标签页不是网页。";
    return;
  }
  const whitelist = await getWhitelist();
  if (!whitelist.includes(url.hostname)) {
    status.innerHTML = `<b>${url.hostname}</b> 不在白名单中。可在设置里添加域名（需授权站点权限）。`;
    $("lnk-options").click();
    return;
  }
  const m = /\/work\/(RJ\d+)/i.exec(url.pathname);
  if (!m) {
    status.textContent = "请打开作品页（路径 /work/RJxxxxxx）后使用。";
    return;
  }
  const rj = m[1].toUpperCase();
  status.innerHTML = `已识别作品 <b>${rj}</b><br>任务页会先确认页面存在“下载”按钮。`;
  btn.disabled = false;
  btn.dataset.rj = rj;
  btn.dataset.tabId = String(tab.id);
  btn.dataset.href = tab.url;
}

$("btn-open").addEventListener("click", (e) => {
  const b = e.target;
  chrome.runtime.sendMessage({
    type: "openTask",
    rj: b.dataset.rj,
    href: b.dataset.href,
    srcTabId: Number(b.dataset.tabId),
  });
  window.close();
});
$("lnk-options").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

init();
