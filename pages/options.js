// 设置页：白名单 + 翻译引擎（含本地 LM Studio 支持）

import { makeCustomTranslator, CUSTOM_BASE_DEFAULT } from "../modules/translate.js";

const DEFAULT_HOST = "asmr-200.com";
const $ = (id) => document.getElementById(id);

let whitelist = [DEFAULT_HOST];

function originFor(host) {
  return `https://${host}/*`;
}
function apiOriginFor(host) {
  return `https://api.${host}/*`;
}

function renderList() {
  const ul = $("whitelist");
  ul.innerHTML = "";
  whitelist.forEach((host, i) => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = host + (host === DEFAULT_HOST ? "（默认）" : "");
    const btn = document.createElement("button");
    btn.textContent = "移除";
    btn.disabled = host === DEFAULT_HOST;
    btn.addEventListener("click", () => {
      whitelist.splice(i, 1);
      renderList();
    });
    li.append(name, btn);
    ul.appendChild(li);
  });
}

async function init() {
  const s = await chrome.storage.sync.get({
    whitelist: [DEFAULT_HOST],
    translator: "custom",
    customBaseUrl: CUSTOM_BASE_DEFAULT,
    customApiKey: "",
    customModel: "qwen3-8b",
  });
  whitelist = s.whitelist && s.whitelist.length ? s.whitelist : [DEFAULT_HOST];
  if (!whitelist.includes(DEFAULT_HOST)) whitelist.unshift(DEFAULT_HOST);
  renderList();
  $("translator").value = s.translator;
  $("custom-base").value = s.customBaseUrl;
  $("custom-key").value = s.customApiKey;
  $("custom-model").value = s.customModel;
  $("custom-box").style.display = s.translator === "custom" ? "block" : "none";
}

$("translator").addEventListener("change", () => {
  $("custom-box").style.display = $("translator").value === "custom" ? "block" : "none";
});

$("btn-add").addEventListener("click", () => {
  let host = $("new-host").value.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) {
    alert("请输入合法域名，例如 asmr.one");
    return;
  }
  if (whitelist.includes(host)) return;
  whitelist.push(host);
  $("new-host").value = "";
  renderList();
});

$("btn-perm").addEventListener("click", async () => {
  const extra = whitelist.filter((h) => h !== DEFAULT_HOST);
  if (!extra.length) {
    $("perm-status").textContent = "白名单只有默认站点，无需额外权限。";
    return;
  }
  const origins = extra.flatMap((h) => [originFor(h), apiOriginFor(h)]);
  try {
    const granted = await chrome.permissions.request({ origins });
    $("perm-status").textContent = granted ? "权限已授予 ✅" : "未授予权限，扩展将无法在这些站点工作。";
  } catch (e) {
    $("perm-status").textContent = "授权失败：" + (e && e.message || e);
  }
});

$("btn-save").addEventListener("click", async () => {
  await chrome.storage.sync.set({
    whitelist,
    translator: $("translator").value,
    customBaseUrl: $("custom-base").value.trim(),
    customApiKey: $("custom-key").value.trim(),
    customModel: $("custom-model").value.trim(),
  });
  $("saved-tip").textContent = "已保存 ✓";
  setTimeout(() => { $("saved-tip").textContent = ""; }, 2000);
});

// ---- LM Studio / 本地模型 ----

$("btn-lmstudio").addEventListener("click", () => {
  $("custom-base").value = CUSTOM_BASE_DEFAULT;
  $("custom-key").value = "";
  $("custom-base").dispatchEvent(new Event("input"));
});

function currentCustom() {
  return {
    baseUrl: $("custom-base").value.trim(),
    apiKey: $("custom-key").value.trim(),
    model: $("custom-model").value.trim(),
  };
}

$("btn-models").addEventListener("click", async () => {
  const st = $("test-status");
  st.textContent = "检测中…";
  try {
    const tr = makeCustomTranslator(currentCustom());
    const models = await tr.listModels();
    const dl = $("model-list");
    dl.innerHTML = models.map((m) => `<option value=""></option>`).join("");
    dl.querySelectorAll("option").forEach((o, i) => { o.value = models[i]; });
    if (models.length && !$("custom-model").value) $("custom-model").value = models[0];
    st.textContent = models.length ? `发现 ${models.length} 个模型：${models.slice(0, 3).join("、")}${models.length > 3 ? "…" : ""}` : "服务已连接，但未发现可用的对话模型";
  } catch (e) {
    st.textContent = "检测失败：" + (e && e.message || e) + "（请确认 LM Studio 已启动并开启本地服务）";
  }
});

$("btn-test").addEventListener("click", async () => {
  const st = $("test-status");
  st.textContent = "测试中…（首次可能需要加载模型）";
  const t0 = Date.now();
  try {
    const tr = makeCustomTranslator(currentCustom());
    const lines = ["こんばんは、桃の郷へようこそ", "そして、すべてが終わる場所へ……"];
    const out = await tr.translateLines(lines);
    const allSame = out.every((t, i) => t === lines[i]);
    st.textContent = allSame
      ? "失败：模型未返回译文（检查模型是否支持中文）"
      : `✓ ${((Date.now() - t0) / 1000).toFixed(1)}s：${out.join(" / ")}`;
  } catch (e) {
    st.textContent = "失败：" + (e && e.message || e);
  }
});

init();
