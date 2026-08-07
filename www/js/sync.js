// sync.js — 跨设备数据同步核心（GitHub Gist / 绿联 NAS 双适配器）
//
// 设计要点：
//  - 只同步 7 个「业务 key」（备忘录/学习/计划/灵感/习惯/日程），UI/主题态留本地。
//  - key 级 LWW 合并：每台设备为每个 key 记时间戳 t，取较大者，互不覆盖。
//  - 启动时预热本地缓存（离线可用）；后台聚焦/可见/轮询拉取；写入防抖上传。
//  - 只读模式：未配置可写令牌时仍可拉取（手机查看），不推送。
//  - 任何异常都被吞掉并降级为「离线·仅本地」，绝不白屏或阻断 UI。
//  - 同步方式由浏览器 localStorage 的 pw_sync_cfg 决定（gist | nas），不写进仓库。

import config from './config.js';

const GIST_FILE = 'workbench-data.json';
const POLL_WRITABLE = 60000;   // 有 token：60s
const POLL_READONLY = 120000;  // 只读：120s（规避未认证 60 次/时限额）
const PUSH_DEBOUNCE = 1500;
const PULL_TIMEOUT = 8000;
const SCHEMA = 1;

// 需要跨设备同步的业务 key（其余走纯本地）
export const SYNCED_KEYS = [
  'plan_events', 'plan_tracks', 'plan_unscheduled',
  'rec_notes', 'rec_learning', 'rec_ideas', 'habits',
  'ai_data' // 资产数据（完整 ai-injected 结构），统一走云端，替代 Gist
];

const cache = new Map();           // key -> { t:Number, v:* }
let subscribers = [];
let status = 'init';               // init | syncing | ok | offline | merged | nocfg
let lastRev = 0;
let cfg = { gist: { id: '', token: '', owner: '' } };
let mode = 'gist';                 // 'gist' | 'nas'
let gistId = '', token = '', owner = '';
let nasEndpoint = '', nasToken = '';
let canWrite = false;
let pushTimer = null;
let pollTimer = null;
let lastStatusText = '';

/* ---------------- 合并算法（key 级 LWW） ---------------- */
function mergeDoc(remote, localObj) {
  const merged = {};
  let changed = false;
  for (const k of SYNCED_KEYS) {
    const r = remote.keys && remote.keys[k];
    const l = localObj[k];
    if (r && (!l || r.t >= l.t)) {
      merged[k] = { t: r.t, v: r.v };
      if (!l || r.t !== l.t || JSON.stringify(r.v) !== JSON.stringify(l.v)) changed = true;
    } else if (l) {
      merged[k] = l;
    }
  }
  return { merged, changed, rev: remote.rev || 0 };
}

function time() { return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }

/* ---------------- 状态 / 订阅 ---------------- */
export function getStatus() {
  return { status, text: lastStatusText, canWrite };
}
function setStatus(s, text) {
  status = s;
  lastStatusText = text || s;
  updateBadge();
}
export function subscribe(cb) {
  if (typeof cb === 'function') subscribers.push(cb);
  return () => { subscribers = subscribers.filter(f => f !== cb); };
}
function notify() {
  for (const cb of subscribers) {
    try { cb(); } catch (e) { console.error('[sync] subscriber error', e); }
  }
}
function updateBadge() {
  if (typeof window.__renderSyncBadge === 'function') window.__renderSyncBadge();
}

/* ---------------- 本地缓存接口（供 storage.js 调用） ---------------- */
export function localHas(key) { return cache.has(key); }
export function localGet(key) {
  const e = cache.get(key);
  return e ? structuredClone(e.v) : undefined;
}
export function localSet(key, val) {
  cache.set(key, { t: Date.now(), v: val });
  persistLocal();
  schedulePush();
}
// 首次迁移：把旧 localStorage 数据灌入缓存（仅当缓存缺该 key）
export function hydrateKey(key, entry) {
  if (!cache.has(key)) cache.set(key, entry);
}

function hydrateFromLocal() {
  const obj = {};
  for (const k of SYNCED_KEYS) {
    try {
      const raw = localStorage.getItem('pw_' + k);
      if (raw) { obj[k] = { t: 0, v: JSON.parse(raw) }; cache.set(k, obj[k]); }
    } catch { /* ignore */ }
  }
  return obj;
}
function persistLocal() {
  for (const [k, entry] of cache) {
    try { localStorage.setItem('pw_' + k, JSON.stringify(entry.v)); } catch { /* ignore */ }
  }
}

async function fetchWithTimeout(url, opts = {}, ms = PULL_TIMEOUT) {
  let signal;
  if (typeof AbortController !== 'undefined') {
    const ac = new AbortController();
    signal = ac.signal;
    setTimeout(() => ac.abort(), ms);
  }
  return fetch(url, { ...opts, signal });
}

/* ---------------- GitHub 读取（raw CDN 优先，API 兜底） ---------------- */
function rawUrl() {
  return `https://gist.githubusercontent.com/${owner}/${gistId}/raw/${GIST_FILE}`;
}
async function fetchRemoteGist() {
  if (owner) {
    try {
      const res = await fetchWithTimeout(rawUrl(), { cache: 'no-store' });
      if (res.ok) {
        const text = await res.text();
        if (text && text.trim()) return JSON.parse(text);
      }
    } catch (e) {
      console.warn('[sync] raw CDN 拉取失败，尝试 API 兜底：', e.message || e);
    }
  }
  if (token) {
    const res = await api(`/gists/${gistId}`);
    const data = await res.json();
    const file = data.files && data.files[GIST_FILE];
    const content = file && file.content;
    if (!content) return null;
    return JSON.parse(content);
  }
  throw new Error('无可用数据源（缺 owner 且无 token）');
}

/* ---------------- GitHub API（仅用于写入/兜底） ---------------- */
async function api(path, opts = {}) {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'workbuddy',
    'Content-Type': 'application/json'
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  let signal;
  if (typeof AbortController !== 'undefined') {
    const ac = new AbortController();
    signal = ac.signal;
    setTimeout(() => ac.abort(), PULL_TIMEOUT);
  }
  const res = await fetch('https://api.github.com' + path, { ...opts, headers, signal });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  return res;
}
async function gistPush(doc) {
  await api(`/gists/${gistId}`, {
    method: 'PATCH',
    body: JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify(doc) } } })
  });
}

/* ---------------- 绿联 NAS 读取 / 写入 ---------------- */
async function fetchRemoteNas() {
  const url = nasEndpoint.replace(/\/$/, '') + '/data.json';
  const headers = nasToken ? { 'x-sync-token': nasToken } : {};
  const res = await fetchWithTimeout(url, { headers, cache: 'no-store' });
  if (res.status === 401) throw new Error('令牌不匹配');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const text = await res.text();
  if (!text.trim()) return null;
  return JSON.parse(text);
}
async function nasPush(doc) {
  const url = nasEndpoint.replace(/\/$/, '') + '/data.json';
  const headers = Object.assign({ 'Content-Type': 'application/json' }, nasToken ? { 'x-sync-token': nasToken } : {});
  const res = await fetchWithTimeout(url, { method: 'POST', headers, body: JSON.stringify(doc) }, 10000);
  if (res.status === 401) { setStatus('offline', '令牌不匹配'); throw new Error('unauthorized'); }
  if (!res.ok) throw new Error('HTTP ' + res.status);
}

/* ---------------- 统一 pull / push ---------------- */
async function pull() {
  if (!((mode === 'nas' && nasEndpoint) || (mode === 'gist' && gistId))) return false;
  setStatus('syncing', '同步中…');
  try {
    const remote = mode === 'nas' ? await fetchRemoteNas() : await fetchRemoteGist();
    if (!remote) { setStatus('ok', '已同步'); return true; }
    const localObj = {};
    for (const [k, e] of cache) localObj[k] = e;
    const { merged, changed, rev } = mergeDoc(remote, localObj);
    lastRev = Math.max(lastRev, rev);
    for (const k of SYNCED_KEYS) if (merged[k]) cache.set(k, merged[k]);
    persistLocal();
    if (changed) { setStatus('merged', '冲突已合并'); notify(); }
    else setStatus('ok', '已同步 ' + time());
    return true;
  } catch (e) {
    console.warn('[sync] pull 失败：', e.message || e);
    setStatus('offline', '离线 · 仅本地');
    return false;
  }
}
async function push() {
  if (!canWrite) return;
  try { await pull(); } catch { /* 拉取失败也继续用本地数据推送 */ }
  const doc = buildDoc(lastRev + 1);
  try {
    if (mode === 'nas') await nasPush(doc);
    else await gistPush(doc);
    lastRev = doc.rev;
    setStatus('ok', '已同步 ' + time());
  } catch (e) {
    console.warn('[sync] push 失败：', e.message || e);
    setStatus('offline', '离线 · 仅本地');
  }
}

function buildDoc(rev) {
  const doc = {
    schema: SCHEMA,
    rev,
    updatedAt: new Date().toISOString(),
    updatedBy: location.hostname || 'web',
    keys: {}
  };
  for (const [k, e] of cache) doc.keys[k] = { t: e.t, v: e.v };
  return doc;
}

function schedulePush() {
  if (!canWrite) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => push(), PUSH_DEBOUNCE);
}

// 页面隐藏/卸载时立即 flush（keepalive 保证请求发出）
export function flush() {
  if (mode === 'nas') {
    if (!nasEndpoint) return;
    const doc = buildDoc(lastRev + 1);
    try {
      fetch(nasEndpoint.replace(/\/$/, '') + '/data.json', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, nasToken ? { 'x-sync-token': nasToken } : {}),
        body: JSON.stringify(doc),
        keepalive: true
      });
    } catch { /* ignore */ }
    return;
  }
  if (!canWrite || !gistId) return;
  const doc = buildDoc(lastRev + 1);
  try {
    fetch('https://api.github.com/gists/' + gistId, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'workbuddy'
      },
      body: JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify(doc) } } }),
      keepalive: true
    });
  } catch { /* ignore */ }
}

/* ---------------- 配置合并（忽略空值，避免占位覆盖真实值） ---------------- */
function mergeGist(base, ov) {
  const out = { ...(base || {}) };
  if (ov && ov.gist) {
    out.gist = { ...(base && base.gist) };
    for (const k of Object.keys(ov.gist)) {
      const v = ov.gist[k];
      if (v !== undefined && v !== null && v !== '') out.gist[k] = v; // 跳过空占位
    }
  }
  return out;
}

/* ---------------- 设置界面接口（localStorage 持久化，不入库） ---------------- */
export function getSyncConfig() {
  return { mode, gist: { id: gistId, owner, token }, nas: { endpoint: nasEndpoint, token: nasToken } };
}
// 写入浏览器本地并重载以重新初始化（数据都在 localStorage/cache，重载无损）
export function setSyncConfig(c) {
  localStorage.setItem('pw_sync_cfg', JSON.stringify(c));
  location.reload();
}
// 测试 NAS 连通性（GET /data.json）
export async function testNas(endpoint, tok) {
  const url = (endpoint || '').replace(/\/$/, '') + '/data.json';
  try {
    const res = await fetchWithTimeout(url, { headers: tok ? { 'x-sync-token': tok } : {} }, 6000);
    if (res.ok) return { ok: true, status: res.status };
    if (res.status === 401) return { ok: false, status: 401, message: '令牌不匹配（401）' };
    return { ok: false, status: res.status, message: 'HTTP ' + res.status };
  } catch (e) {
    return { ok: false, message: e.message || '连接失败' };
  }
}
// 从 Gist 迁移现有数据到 NAS（一次性）
export async function migrateToNas() {
  if (gistId || owner) {
    try {
      const remote = await fetchRemoteGist();
      if (remote) {
        const localObj = {};
        for (const [k, e] of cache) localObj[k] = e;
        const { merged } = mergeDoc(remote, localObj);
        for (const k of SYNCED_KEYS) if (merged[k]) cache.set(k, merged[k]);
        persistLocal();
      }
    } catch (e) {
      console.warn('[sync] gist 拉取失败，使用本地数据迁移：', e.message || e);
    }
  }
  const prev = mode; mode = 'nas';
  try { await nasPush(buildDoc(lastRev + 1)); }
  finally { mode = prev; }
  return true;
}

/* ---------------- 初始化 ---------------- */
export async function initSync() {
  try { cfg = mergeGist(cfg, config); } catch { /* ignore */ }
  try {
    const localMod = await import('./config.local.js');
    cfg = mergeGist(cfg, localMod.default);
  } catch { /* 无本地覆盖配置，正常 */ }

  // 本地覆盖（设置界面写入）：localStorage pw_sync_cfg 优先
  let localCfg = null;
  try { const raw = localStorage.getItem('pw_sync_cfg'); if (raw) localCfg = JSON.parse(raw); } catch { /* ignore */ }

  if (localCfg && localCfg.mode === 'nas' && localCfg.nas && localCfg.nas.endpoint) {
    mode = 'nas';
    nasEndpoint = (localCfg.nas.endpoint || '').trim();
    nasToken = (localCfg.nas.token || '').trim();
    gistId = (cfg.gist && cfg.gist.id) || '';
    owner = (cfg.gist && cfg.gist.owner) || '';
    token = (cfg.gist && cfg.gist.token) || '';
    canWrite = !!nasEndpoint; // 令牌可选（若服务端未设 TOKEN）
  } else if (config.sync && config.sync.nasEndpoint) {
    // 构建时注入的云端后端：自动启用，用户零配置
    mode = 'nas';
    nasEndpoint = (config.sync.nasEndpoint || '').trim();
    nasToken = (config.sync.token || '').trim();
    gistId = (cfg.gist && cfg.gist.id) || '';
    owner = (cfg.gist && cfg.gist.owner) || '';
    token = (cfg.gist && cfg.gist.token) || '';
    canWrite = !!nasToken;
  } else {
    mode = 'gist';
    gistId = (cfg.gist && cfg.gist.id) || '';
    token = (cfg.gist && cfg.gist.token) || '';
    owner = (cfg.gist && cfg.gist.owner) || '';
    nasEndpoint = '';
    nasToken = '';
    canWrite = !!gistId && !!token;
  }

  // 先预热本地缓存，保证离线也能用
  hydrateFromLocal();

  if ((mode === 'nas' && !nasEndpoint) || (mode === 'gist' && !gistId)) {
    setStatus('nocfg', '未配置同步');
    return;
  }

  // 启动即拉取（带超时，绝不阻塞 bootstrap）
  await Promise.race([
    pull(),
    new Promise(r => setTimeout(r, PULL_TIMEOUT + 1500))
  ]).catch(() => {});

  // 后台监听
  window.addEventListener('focus', () => pull().catch(() => {}));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pull().catch(() => {}); });
  window.addEventListener('beforeunload', flush);
  const interval = canWrite ? POLL_WRITABLE : POLL_READONLY;
  pollTimer = setInterval(() => pull().catch(() => {}), interval);
}

// 手动触发一次拉取（点顶栏徽章）
export function pullNow() { return pull(); }
