// 输出目录管理：File System Access API（用户授权文件夹直写）
// 句柄持久化到 IndexedDB，之后无需重复选择。
// 仅在扩展页面（secure context）中可用。

const DB_NAME = "asmr-flac-helper";
const STORE = "handles";
const KEY = "rootDir";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 弹出系统文件夹选择器（需要用户手势），成功后持久化句柄 */
export async function pickRootDir() {
  if (typeof showDirectoryPicker !== "function") {
    throw new Error("当前浏览器不支持文件夹直写（需要 Chrome 86+）");
  }
  const handle = await showDirectoryPicker({ id: "asmr-flac-out", mode: "readwrite", startIn: "downloads" });
  await idbSet(KEY, handle);
  return handle;
}

/** 读取已保存的目录句柄；权限为 prompt 时返回 { handle, needGrant: true } */
export async function loadRootDir() {
  try {
    const handle = await idbGet(KEY);
    if (!handle) return null;
    const perm = await handle.queryPermission({ mode: "readwrite" });
    return { handle, needGrant: perm !== "granted" };
  } catch (e) {
    return null;
  }
}

export async function ensureGrant(handle) {
  const perm = await handle.requestPermission({ mode: "readwrite" });
  return perm === "granted";
}

export async function clearRootDir() {
  await idbSet(KEY, undefined);
}

/** 在 root 下建立（或获取）子目录 */
export async function ensureSubDir(root, name) {
  return root.getDirectoryHandle(name, { create: true });
}

/** 写入文件（覆盖） */
export async function writeFile(dirHandle, name, blob) {
  const fh = await dirHandle.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
}

export async function fileExists(dirHandle, name) {
  try {
    await dirHandle.getFileHandle(name);
    return true;
  } catch (e) {
    return false;
  }
}

export async function deleteFile(dirHandle, name) {
  try {
    await dirHandle.removeEntry(name);
    return true;
  } catch (e) {
    return false;
  }
}
