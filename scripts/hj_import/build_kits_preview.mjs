// HJ作例インデックス → kits / kit_aliases の取り込みプレビューを作る
//
// 使い方(リポジトリのルートで):
//   node scripts/hj_import/build_kits_preview.mjs [入力CSV] [出力フォルダ]
//   既定: data/hj_index_2022-2026.csv → data/
//
// 出力(UTF-8 BOM付き。Excelでそのまま開ける):
//   kits_preview.csv     キット単位(1行=1キット)
//   aliases_preview.csv  キットの別名(表記ゆれ)
//   excluded_rows.csv    キット名が空で取り込めない作例
//
// Supabase には一切書き込まない。何度実行しても同じ入力なら同じ結果になる
// (id はキーから作る UUID v5 なので、再実行しても変わらない)。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const INPUT = process.argv[2] ?? 'data/hj_index_2022-2026.csv';
const OUT_DIR = process.argv[3] ?? 'data';

const TARGET_TYPES = new Set(['作例', '連載作例', 'ジオラマ作例']);

// kits テーブルの列の上限(supabase/migrations/001_init.sql)
const LIMIT = { name: 100, maker: 50, scale: 20, source_ref: 200, alias: 100 };

// id 用の固定名前空間(変えると全キットの id が変わるので変更しないこと)
const ID_NAMESPACE = '3b0f7c1e-6a52-4c1e-9d0e-5f2a7c4b8e11';

// メーカー表記の統一(照合用。表示は元の表記の最頻値を使う)
const MAKER_CANON = new Map([
  ['バンダイ', 'BANDAI SPIRITS'],
  ['アオシマ', '青島文化教材社'],
  ['アオシマ文化教材社', '青島文化教材社'],
  ['フジミ', 'フジミ模型'],
  ['ゲッコーモデル', 'ゲッコー・モデル'],
  ['コータリ', 'コータリモデルス'],
  ['コータリモデル', 'コータリモデルス'],
  ['ドイツレベル', 'レベル'],
  ['プラッツ/BEEMAX', 'プラッツ/BEEMAX'],
  ['BEEMAX', 'プラッツ/BEEMAX'],
]);

// キットではない(作品名・自作)可能性が高いメーカー欄
const SCRATCH_MAKER = /スクラッチ/;
// 模型メーカーではなく版元・権利元と思われるもの
const NON_KIT_MAKER = new Set(['小学館', 'KADOKAWA', '東宝', 'スクウェア・エニックス',
  'バンダイナムコフィルムワークス', 'Kishikawa Edit Office,Inc.', 'マテル']);

// ---------------------------------------------------------------- CSV

function parseCsv(text) {
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
  return rows;
}

function toCsv(header, records) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.map(esc).join(',')];
  for (const r of records) lines.push(header.map((h) => esc(r[h])).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- 正規化

// 表記ゆれを吸収した照合用の文字列。表示には使わない。
function normName(s) {
  return s.normalize('NFKC')
    .toLowerCase()
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/[【\[]/g, '(').replace(/[】\]]/g, ')')
    .replace(/[〜~]/g, '~')
    .replace(/["'“”‘’「」『』]/g, '')
    .replace(/[\s・=.]/g, '');
}

function normMaker(s) {
  const m = s.normalize('NFKC').replace(/\s*[／/]\s*/g, '/').trim();
  return MAKER_CANON.get(m) ?? m;
}

function normScale(s) {
  return s.normalize('NFKC').replace(/\s/g, '');
}

// 先頭の型式番号(例: "RX-78-2 ", "MS-06S ", "GAT-X105+AQM/E-X01 ")
const MODEL_CODE = /^[A-Za-z][A-Za-z0-9]*(?:[-/+][A-Za-z0-9()\[\]]+)+\s+|^[A-Za-z]{1,4}\d+[A-Za-z0-9]*\s+/;

function stripModelCode(name) {
  const n = name.normalize('NFKC').trim();
  const stripped = n.replace(MODEL_CODE, '');
  return stripped.length > 0 ? stripped : n;
}

function modelCode(name) {
  const m = name.normalize('NFKC').trim().match(MODEL_CODE);
  return m ? normName(m[0]) : '';
}

// 同じスケールに複数グレード(HG/RG/EG、MGの各Ver.など)が出るガンプラのスケール
const GUNPLA_MULTI_GRADE_SCALES = new Set(['1/144', '1/100', '1/60']);

// 記事タイトル・備考・キット名から分かるガンプラのグレード
const GRADE_RE = /(PG UNLEASHED|PG|MGSD|MGEX|MG|RG|HGUC|HG|EG|ENTRY GRADE|RE\/100|FULL MECHANICS|SDCS|SD)(?![A-Za-z])/;
function detectGrade(...texts) {
  for (const t of texts) {
    const m = t.normalize('NFKC').match(GRADE_RE);
    if (m) {
      const g = m[1];
      if (g === 'HGUC') return 'HG';
      if (g === 'ENTRY GRADE') return 'EG';
      if (g === 'SDCS') return 'SD';
      return g;
    }
  }
  return '';
}

// 1作例に複数キットが入っていそうか
function looksMulti(r) {
  return /[／、]/.test(r.name) || /[／、]/.test(r.scale) || /[、]/.test(r.maker)
    || /[2-9２-９]\s*(キット|種|機|隻|アイテム)|複数/.test(r.note);
}

function uuidV5(name, namespace) {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = crypto.createHash('sha1').update(Buffer.concat([ns, Buffer.from(name, 'utf8')])).digest();
  const b = hash.subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function mostFrequent(values) {
  // 最頻値。同数なら最初に出てきたもの
  const count = new Map();
  for (const v of values) count.set(v, (count.get(v) ?? 0) + 1);
  let best = values[0], bestN = 0;
  for (const [v, n] of count) if (n > bestN) { best = v; bestN = n; }
  return best;
}

// ---------------------------------------------------------------- 読み込み

const [header, ...body] = parseCsv(fs.readFileSync(INPUT, 'utf8').replace(/^﻿/, ''));
const col = (name) => {
  const i = header.indexOf(name);
  if (i < 0) throw new Error(`列「${name}」がありません: ${header.join(',')}`);
  return i;
};
const C = {
  issue: col('号'), page: col('ページ'), corner: col('コーナー'), title: col('記事タイトル'),
  name: col('キット名'), maker: col('メーカー'), scale: col('スケール'),
  builder: col('制作者'), type: col('種別'), note: col('備考'),
};

const all = body.filter((r) => r.length > 1).map((r) => ({
  issue: r[C.issue].trim(), page: r[C.page].trim(), corner: r[C.corner].trim(),
  title: r[C.title].trim(), name: r[C.name].trim(), maker: r[C.maker].trim(),
  scale: r[C.scale].trim(), builder: r[C.builder].trim(), type: r[C.type].trim(),
  note: r[C.note].trim(),
}));
const works = all.filter((r) => TARGET_TYPES.has(r.type));
const excluded = works.filter((r) => !r.name);
const usable = works.filter((r) => r.name);

// ---------------------------------------------------------------- まとめる

// 同じキットとみなす条件: 正規化した名前・メーカー・スケールがすべて一致
// ただし「確認が必要な作例」(複数キット・メーカー不明・スクラッチ等)は他とまとめない
function rowReasons(r) {
  const reasons = [];
  if (looksMulti(r)) reasons.push('1作例に複数キットの可能性');
  if (r.type === 'ジオラマ作例') reasons.push('ジオラマ作例(キット名が作品名の可能性)');
  else if (/[!！]|^[「『]/.test(r.name)) reasons.push('キット名が作品タイトルの可能性');
  if (!r.maker) reasons.push('メーカー不明');
  else if (SCRATCH_MAKER.test(r.maker)) reasons.push('スクラッチビルド(市販キットでない可能性)');
  else if (NON_KIT_MAKER.has(r.maker)) reasons.push('メーカー欄が版元・権利元の可能性');
  if (r.name.length > LIMIT.name) reasons.push(`名前が${LIMIT.name}文字超`);
  if (r.maker.length > LIMIT.maker) reasons.push(`メーカーが${LIMIT.maker}文字超`);
  if (r.scale.length > LIMIT.scale) reasons.push(`スケールが${LIMIT.scale}文字超`);
  return reasons;
}

const groups = new Map();
for (const r of usable) {
  r.grade = detectGrade(r.name, r.note, r.title);
  r.reasons = rowReasons(r);
  const key = [normName(r.name), normMaker(r.maker), normScale(r.scale)].join('|');
  // 要確認の作例は単独のキットにする(ページで区別)
  const gkey = r.reasons.length ? `${key}|#${r.issue}-${r.page}-${r.name}` : key;
  if (!groups.has(gkey)) groups.set(gkey, { key: gkey, rows: [] });
  groups.get(gkey).rows.push(r);
}

// ガンプラの 1/144・1/100・1/60 は、グレードが全作例で同じと分かる場合だけまとめる。
// 分からなければ作例ごとに分けて要確認(後で kits.merged_into で統合できる)
const GRADE_UNKNOWN = 'ガンプラのグレード・版を判別できない(HG/RG/EG、MGのVer.違い等)';
for (const [gkey, g] of [...groups]) {
  const [, maker, scale] = gkey.split('|');
  if (g.rows.length < 2 || maker !== 'BANDAI SPIRITS' || !GUNPLA_MULTI_GRADE_SCALES.has(scale)) continue;
  const grades = new Set(g.rows.map((r) => r.grade));
  if (grades.size === 1 && !grades.has('')) continue;
  groups.delete(gkey);
  for (const r of g.rows) {
    r.reasons.push(GRADE_UNKNOWN);
    const k = `${gkey}|#${r.issue}-${r.page}-${r.name}`;
    groups.set(k, { key: k, rows: [r] });
  }
}

const sortRef = (a, b) => (a.issue + a.page).localeCompare(b.issue + b.page);
const kits = [...groups.values()].map((g) => {
  g.rows.sort(sortRef);
  const names = g.rows.map((r) => r.name);
  const first = g.rows[0];
  const reasons = new Set(g.rows.flatMap((r) => r.reasons));
  const grades = [...new Set(g.rows.map((r) => r.grade).filter(Boolean))];
  if (grades.length > 1) reasons.add(`グレード違いの可能性(${grades.join('/')})`);
  return {
    key: g.key,
    rows: g.rows,
    first,
    name: mostFrequent(names),
    names: [...new Set(names)],
    maker: mostFrequent(g.rows.map((r) => r.maker)),
    scale: mostFrequent(g.rows.map((r) => r.scale)),
    grades,
    reasons,
    similar: new Set(),
  };
});
kits.sort((a, b) => sortRef(a.first, b.first) || a.name.localeCompare(b.name));
kits.forEach((k, i) => {
  k.no = `HJ-${String(i + 1).padStart(4, '0')}`;
  k.id = uuidV5(`hj:${k.key}`, ID_NAMESPACE);
});

// 似ているが自動ではまとめなかったもの → 双方に要確認
//   型式番号の有無・メーカー不明・スケール不明の違いだけで名前が同じもの、
//   グレード不明で作例ごとに分けた同名キット
const byLoose = new Map();
for (const k of kits) {
  for (const n of k.names) {
    const lk = normName(stripModelCode(n));
    if (!byLoose.has(lk)) byLoose.set(lk, new Set());
    byLoose.get(lk).add(k);
  }
}
const compatible = (a, b) => !a || !b || a === b;
for (const set of byLoose.values()) {
  const list = [...set];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (!compatible(normMaker(a.maker), normMaker(b.maker))) continue;
      if (!compatible(normScale(a.scale), normScale(b.scale))) continue;
      // 型式番号が両方あって違う(例: KV-1 継続高校 / BT-42 継続高校)なら別物
      if (!compatible(modelCode(a.name), modelCode(b.name))) continue;
      a.similar.add(b); b.similar.add(a);
    }
  }
}
for (const k of kits) {
  if (k.similar.size) {
    k.reasons.add(`同じキットの可能性: ${[...k.similar].map((s) => s.no).sort().join(' ')}`);
  }
}

// ---------------------------------------------------------------- 出力

function sourceRef(rows) {
  const refs = rows.map((r) => `${r.issue} p.${r.page}`);
  let out = '';
  for (let i = 0; i < refs.length; i++) {
    const next = (out ? out + '; ' : 'HJ ') + refs[i];
    const rest = refs.length - i - 1;
    const tail = rest ? ` ほか${rest}件` : '';
    if ((next + tail).length > LIMIT.source_ref) {
      return `${out} ほか${refs.length - i}件`;
    }
    out = next;
  }
  return out;
}

const kitRecords = kits.map((k) => ({
  no: k.no,
  id: k.id,
  name: k.name,
  maker: k.maker,
  scale: k.scale,
  source: 'hj',
  source_ref: sourceRef(k.rows),
  needs_review: k.reasons.size ? '要確認' : '',
  review_reason: [...k.reasons].join(' / '),
  work_count: k.rows.length,
  grade_hint: k.grades.join('/'),
  works_detail: k.rows.map((r) =>
    `${r.issue} p.${r.page} ${r.name}${r.builder ? `(${r.builder})` : ''}`).join(' | '),
}));

const aliasRecords = [];
for (const k of kits) {
  const seen = new Set([k.name]);
  for (const n of k.names) {
    if (seen.has(n)) continue;
    seen.add(n);
    aliasRecords.push({ kit_no: k.no, kit_id: k.id, kit_name: k.name, alias: n });
  }
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'kits_preview.csv'), toCsv(
  ['no', 'id', 'name', 'maker', 'scale', 'source', 'source_ref', 'needs_review',
    'review_reason', 'work_count', 'grade_hint', 'works_detail'], kitRecords));
fs.writeFileSync(path.join(OUT_DIR, 'aliases_preview.csv'), toCsv(
  ['kit_no', 'kit_id', 'kit_name', 'alias'], aliasRecords));
fs.writeFileSync(path.join(OUT_DIR, 'excluded_rows.csv'), toCsv(
  ['issue', 'page', 'title', 'type', 'note'], excluded));

// ---------------------------------------------------------------- 集計

const reviewKits = kitRecords.filter((k) => k.needs_review);
const reasonCount = new Map();
for (const k of kits) {
  for (const r of k.reasons) {
    const label = r.replace(/:.*$/, '').replace(/\(.*\)$/, '');
    reasonCount.set(label, (reasonCount.get(label) ?? 0) + 1);
  }
}
console.log(`入力全行               : ${all.length}`);
console.log(`対象の作例(${[...TARGET_TYPES].join('・')}): ${works.length}`);
for (const t of TARGET_TYPES) console.log(`  ${t}: ${works.filter((r) => r.type === t).length}`);
console.log(`  うちキット名が空で除外: ${excluded.length}`);
console.log(`まとめた後のキット数   : ${kits.length}`);
console.log(`  2作例以上をまとめたキット: ${kits.filter((k) => k.rows.length > 1).length}`);
console.log(`  要確認                   : ${reviewKits.length}`);
for (const [label, n] of [...reasonCount].sort((a, b) => b[1] - a[1])) console.log(`    ${label}: ${n}`);
console.log(`別名                   : ${aliasRecords.length}`);
console.log(`メーカー空のキット     : ${kitRecords.filter((k) => !k.maker).length}`);
console.log(`スケール空のキット     : ${kitRecords.filter((k) => !k.scale).length}`);
console.log(`出力: ${path.join(OUT_DIR, 'kits_preview.csv')}, aliases_preview.csv, excluded_rows.csv`);
