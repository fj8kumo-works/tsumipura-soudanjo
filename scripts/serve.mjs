// 自分のパソコンだけで画面を確認するための簡易サーバー
//
// 使い方(リポジトリのルートで): node scripts/serve.mjs
//   → ブラウザで http://localhost:8000 を開く。止めるときは Ctrl + C
//
// 公開する画面のファイル(html / css / js / 画像)だけを返す。
// .env・data/・scripts/ など、公開しないものは返さない。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};
const BLOCKED_DIRS = new Set(['data', 'scripts', 'supabase', 'node_modules']);

function resolve(urlPath) {
  const rel = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const parts = rel.split('/');
  if (parts.some((p) => p.startsWith('.') || p === '')) return null; // .env・.git など
  if (BLOCKED_DIRS.has(parts[0])) return null;
  const file = path.join(ROOT, ...parts);
  if (!file.startsWith(ROOT + path.sep)) return null;
  if (!TYPES[path.extname(file).toLowerCase()]) return null;
  return file;
}

http.createServer((req, res) => {
  let file = null;
  try { file = resolve(req.url); } catch { /* 不正な URL */ }
  if (file && fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!file || !fs.existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('見つかりません');
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)], 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`http://localhost:${PORT} で確認できます(止めるときは Ctrl + C)`);
});
