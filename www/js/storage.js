// localStorage 封装（含跨设备同步钩子）
// 注意：loadData / saveData 的「同步」签名保持不变，app.js 的 58 处调用点无需改动。
// 同步逻辑由 sync.js 接管：被同步的 key 走内存缓存+远端，其余 key 走纯本地。
import { SYNCED_KEYS, localGet, localHas, localSet } from './sync.js';

const PREFIX = 'pw_';

export function loadData(key, fallback) {
  if (SYNCED_KEYS.includes(key)) {
    if (localHas(key)) return localGet(key);
    // 兜底：极端情况下缓存未预热，回退 localStorage
    try {
      const v = localStorage.getItem(PREFIX + key);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  }
  try {
    const v = localStorage.getItem(PREFIX + key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}

// 存储失败（隐私模式、配额满、iframe 沙箱限制）不应中断整个应用
export function saveData(key, val) {
  if (SYNCED_KEYS.includes(key)) {
    localSet(key, val); // 写缓存 + 本地镜像 + 触发防抖上传
    return true;
  }
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(val));
    return true;
  } catch (err) {
    console.warn('[工作台] 本地存储写入失败，本次改动不会被记住：', err);
    return false;
  }
}

export function removeData(key) {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch (err) {
    console.warn('[工作台] 本地存储删除失败：', err);
  }
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
