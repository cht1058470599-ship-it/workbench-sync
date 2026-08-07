// 个人工作台 · NAS 同步后端
// 零依赖 Node 服务：GET/POST /data.json，x-sync-token 鉴权 + CORS，数据落盘 /data/data.json
// 设计为「哑存储」：只保存工作台推送过来的整份文档（schema 与 Gist 一致），冲突合并交给前端做。
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const TOKEN = (process.env.SYNC_TOKEN || '').trim();
const DATA_FILE = process.env.DATA_FILE || '/data/data.json';

function allowOrigin(req) { return req.headers.origin || '*'; }

function send(res, code, body, req, extra = {}) {
  const headers = Object.assign({
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowOrigin(req),
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'x-sync-token,content-type',
    'Cache-Control': 'no-store',
  }, extra);
  res.writeHead(code, headers);
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function checkToken(req) {
  if (!TOKEN) return true; // 未设令牌则开放（仅首次部署方便，生产务必设置 SYNC_TOKEN）
  const h = req.headers['x-sync-token'] ||
    new URL(req.url, 'http://x').searchParams.get('token') || '';
  return h === TOKEN;
}

function ensureDir() { try { fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true }); } catch {} }
function readData() { try { return fs.readFileSync(DATA_FILE, 'utf8'); } catch { return null; } }
function writeData(str) {
  ensureDir();
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, str);
  fs.renameSync(tmp, DATA_FILE); // 原子写，避免半截文件被读到
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { send(res, 204, '', req); return; }
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/data.json') {
    if (!checkToken(req)) { send(res, 401, { error: 'unauthorized' }, req); return; }
    if (req.method === 'GET') {
      const data = readData();
      if (data == null) {
        send(res, 200, { schema: 1, rev: 0, updatedAt: new Date().toISOString(), updatedBy: 'server', keys: {} }, req);
      } else { send(res, 200, data, req); }
    } else if (req.method === 'POST') {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (typeof parsed !== 'object' || parsed === null) throw new Error('bad');
          writeData(JSON.stringify({ ...parsed, serverSavedAt: new Date().toISOString() }, null, 2));
          send(res, 200, { ok: true, rev: parsed.rev || 0 }, req);
        } catch (e) { send(res, 400, { error: 'bad json' }, req); }
      });
    } else { send(res, 405, { error: 'method not allowed' }, req); }
  } else if (p === '/health') {
    send(res, 200, { ok: true }, req);
  } else {
    send(res, 404, { error: 'not found' }, req);
  }
});

server.listen(PORT, () => console.log('workbench-sync listening on :' + PORT));
