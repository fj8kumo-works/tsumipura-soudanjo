// 取り込み・確認スクリプト共通: .env の読み込み、CSV の読み込み、Supabase REST の呼び出し
//
// .env(リポジトリのルート。.gitignore 済み。絶対にコミットしない)
//   SUPABASE_URL=https://xxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY=...   取り込み用(RLS を通らない。ブラウザに出さない)
//   SUPABASE_ANON_KEY=...           確認用(公開画面と同じ権限で検索できるか見る)

import fs from 'node:fs';

export function loadEnv(file = '.env') {
  if (!fs.existsSync(file)) {
    throw new Error(`${file} がありません。.env.example をコピーして値を入れてください`);
  }
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
    if (!env[k]) throw new Error(`.env に ${k} がありません`);
  }
  return env;
}

export function readCsv(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows.filter((r) => r.some((v) => v.trim()));
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

export function client(url, key) {
  const base = `${url.replace(/\/$/, '')}/rest/v1`;
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

  async function request(method, path, { body, prefer } = {}) {
    const res = await fetch(`${base}/${path}`, {
      method,
      headers: { ...headers, ...(prefer ? { Prefer: prefer } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
    return { data: text ? JSON.parse(text) : null, headers: res.headers };
  }

  return {
    // 1000件ずつ全件取る
    async selectAll(table, query) {
      const out = [];
      for (let from = 0; ; from += 1000) {
        const sep = query ? '&' : '';
        const { data } = await request('GET', `${table}?${query}${sep}order=id&offset=${from}&limit=1000`);
        out.push(...data);
        if (data.length < 1000) return out;
      }
    },
    async count(table, query = '') {
      const { headers: h } = await request('HEAD', `${table}?${query}`, { prefer: 'count=exact' });
      return Number(h.get('content-range').split('/')[1]);
    },
    async get(table, query) {
      return (await request('GET', `${table}?${query}`)).data;
    },
    // 既にある行は変更しない(ON CONFLICT DO NOTHING)
    async insertIgnore(table, rows, onConflict) {
      for (let i = 0; i < rows.length; i += 500) {
        await request('POST', `${table}?on_conflict=${onConflict}`, {
          body: rows.slice(i, i + 500),
          prefer: 'resolution=ignore-duplicates,return=minimal',
        });
      }
    },
  };
}
