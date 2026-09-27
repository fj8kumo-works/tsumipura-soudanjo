// HJ作例インデックス → kits / kit_aliases の取り込みプレビューを作る
//
// 使い方(リポジトリのルートで):
//   node scripts/hj_import/build_kits_preview.mjs [入力CSV] [出力フォルダ]
//   既定: data/hj_index_2022-2026.csv → data/
//
// 読み込むもの:
//   入力CSV                               HJ作例インデックス
//   scripts/hj_import/maker_aliases.csv   メーカー表記の対応表(表記,統一名)
//   <出力フォルダ>/review_same.csv         前回出力した「同じキットの可能性」の確認結果
//                                          (「まとめる」列が ○ の組を統合する)
//
// 出力(UTF-8 BOM付き。Excelでそのまま開ける):
//   kits_preview.csv     取り込むキット(1行=1キット)
//   aliases_preview.csv  キットの別名(表記ゆれ)
//   excluded_rows.csv    取り込まない作例と理由
//   review_same.csv      同じキットの可能性がある組(「まとめる」列は前回の記入を引き継ぐ)
//
// Supabase には一切書き込まない。同じ入力なら何度実行しても同じ結果になる
// (id はキーから作る UUID v5 なので、再実行しても変わらない)。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const INPUT = process.argv[2] ?? 'data/hj_index_2022-2026.csv';
const OUT_DIR = process.argv[3] ?? 'data';
const MAKER_ALIASES = path.join(SCRIPT_DIR, 'maker_aliases.csv');
const REVIEW_SAME = path.join(OUT_DIR, 'review_same.csv');

const TARGET_TYPES = new Set(['作例', '連載作例', 'ジオラマ作例']);

// kits テーブルの列の上限(supabase/migrations/001_init.sql)
const LIMIT = { name: 100, maker: 50, scale: 20, source_ref: 200, alias: 100 };

// id 用の固定名前空間(変えると全キットの id が変わるので変更しないこと)
const ID_NAMESPACE = '3b0f7c1e-6a52-4c1e-9d0e-5f2a7c4b8e11';

// 「まとめる」列でこれらが入っていれば統合する
const MERGE_MARKS = new Set(['○', '〇', '◯', 'o', 'O', 'ｏ', 'Ｏ']);

// 取り込まない作例の判定
const SCRATCH_MAKER = /スクラッチ/;
// 模型メーカーではなく版元・権利元と思われるもの
const NON_KIT_MAKER = new Set(['小学館', 'KADOKAWA', '東宝', 'スクウェア・エニックス',
  'バンダイナムコフィルムワークス', 'Kishikawa Edit Office,Inc.', 'マテル']);

// ---------------------------------------------------------------- CSV

// Excel で保存し直すと Shift_JIS になることがあるので両方読めるようにする
function readText(file) {
  const buf = fs.readFileSync(file);
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('shift_jis').decode(buf);
  }
}

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
  return rows.filter((r) => r.some((v) => v.trim()));
}

// 1行目を見出しとしてオブジェクトの配列にする
function readCsvObjects(file) {
  const [header, ...body] = parseCsv(readText(file));
  return { header, rows: body.map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()]))) };
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

// メーカーの対応表(表記 → 統一名)
const makerMap = new Map();
for (const r of readCsvObjects(MAKER_ALIASES).rows) {
  if (r['表記'] && r['統一名']) makerMap.set(cleanMaker(r['表記']), cleanMaker(r['統一名']));
}

function cleanMaker(s) {
  return s.normalize('NFKC').replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ').trim();
}

// 表示にも使う統一後のメーカー名
function unifyMaker(s) {
  const m = cleanMaker(s);
  return makerMap.get(m) ?? m;
}

function cleanScale(s) {
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

const sortRef = (a, b) => (a.issue + a.page).localeCompare(b.issue + b.page);

// ---------------------------------------------------------------- 読み込み

const { header, rows: raw } = readCsvObjects(INPUT);
for (const c of ['号', 'ページ', '記事タイトル', 'キット名', 'メーカー', 'スケール', '制作者', '種別', '備考']) {
  if (!header.includes(c)) throw new Error(`列「${c}」がありません: ${header.join(',')}`);
}
const all = raw.map((r) => ({
  issue: r['号'], page: r['ページ'], title: r['記事タイトル'], name: r['キット名'],
  rawMaker: r['メーカー'], maker: unifyMaker(r['メーカー']), scale: cleanScale(r['スケール']),
  builder: r['制作者'], type: r['種別'], note: r['備考'],
}));
const works = all.filter((r) => TARGET_TYPES.has(r.type));

// ---------------------------------------------------------------- 取り込まない作例

function excludeReasons(r) {
  const reasons = [];
  if (!r.name) reasons.push('キット名が空');
  if (SCRATCH_MAKER.test(r.maker)) reasons.push('スクラッチビルド');
  if (NON_KIT_MAKER.has(r.maker)) reasons.push('メーカー欄が版元・権利元の可能性');
  if (/[!！]|^[「『]/.test(r.name)) reasons.push('キット名が作品タイトルの可能性');
  return reasons;
}

const excluded = [];
const usable = [];
for (const r of works) {
  const reasons = excludeReasons(r);
  if (reasons.length) excluded.push({ ...r, reason: reasons.join(' / ') });
  else usable.push(r);
}

// ---------------------------------------------------------------- まとめる

// 取り込むが要確認として残す理由
function reviewReasons(r) {
  const reasons = [];
  if (looksMulti(r)) reasons.push('1作例に複数キットの可能性');
  if (!r.maker) reasons.push('メーカー不明');
  if (r.name.length > LIMIT.name) reasons.push(`名前が${LIMIT.name}文字超`);
  if (r.maker.length > LIMIT.maker) reasons.push(`メーカーが${LIMIT.maker}文字超`);
  if (r.scale.length > LIMIT.scale) reasons.push(`スケールが${LIMIT.scale}文字超`);
  return reasons;
}

// 同じキットとみなす条件: 正規化した名前・メーカー・スケールがすべて一致
// ただし要確認の作例は他とまとめない(ページで区別)
const groups = new Map();
for (const r of usable) {
  r.grade = detectGrade(r.name, r.note, r.title);
  r.reasons = reviewReasons(r);
  const key = [normName(r.name), r.maker, r.scale].join('|');
  const gkey = r.reasons.length ? `${key}|#${r.issue}-${r.page}-${r.name}` : key;
  if (!groups.has(gkey)) groups.set(gkey, { key: gkey, rows: [] });
  groups.get(gkey).rows.push(r);
}

// ガンプラの 1/144・1/100・1/60 は、グレードが全作例で同じと分かる場合だけまとめる。
// 分からなければ作例ごとに分けて要確認(review_same.csv で統合を判断する)
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

// id は「最初に載った作例(号・ページ・キット名)」から作る。
// 照合キー(正規化・メーカー対応表)を変えても、後の号を追加しても変わらない。
// 統合したキットは、いちばん早い作例を持つ元キットの id になる。
const workId = (r) => uuidV5(`hj-work:${r.issue}|${r.page}|${r.name}`, ID_NAMESPACE);
{
  const seen = new Set();
  for (const r of usable) {
    const w = `${r.issue}|${r.page}|${r.name}`;
    if (seen.has(w)) throw new Error(`号・ページ・キット名が同じ作例が2行あります: ${w}`);
    seen.add(w);
  }
}

// 統合前のキット(以降「元キット」)
const baseKits = [...groups.values()].map((g) => {
  g.rows.sort(sortRef);
  // legacyId: 以前の版の id(照合キーから作っていた)。古い review_same.csv を読むためだけに使う
  return { key: g.key, id: workId(g.rows[0]), legacyId: uuidV5(`hj:${g.key}`, ID_NAMESPACE), rows: g.rows };
});
baseKits.sort((a, b) => sortRef(a.rows[0], b.rows[0]) || a.key.localeCompare(b.key));
const baseById = new Map(baseKits.flatMap((k) => [[k.legacyId, k], [k.id, k]]));

const describe = (k) => {
  const r = k.rows[0];
  return [mostFrequent(k.rows.map((x) => x.name)), r.maker || '(メーカー不明)', r.scale || '(スケール不明)'].join(' / ');
};

// ---------------------------------------------------------------- 同じキットの可能性

// 型式番号の有無・メーカー不明・スケール不明の違いだけで名前が同じもの、
// グレード不明で作例ごとに分けた同名キット
const byLoose = new Map();
for (const k of baseKits) {
  for (const n of new Set(k.rows.map((r) => r.name))) {
    const lk = normName(stripModelCode(n));
    if (!byLoose.has(lk)) byLoose.set(lk, new Set());
    byLoose.get(lk).add(k);
  }
}
const compatible = (a, b) => !a || !b || a === b;
const pairKey = (a, b) => [a.id, b.id].sort().join('+');
const pairs = new Map();
for (const set of byLoose.values()) {
  const list = [...set];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const [a, b] = [list[i], list[j]].sort((x, y) => baseKits.indexOf(x) - baseKits.indexOf(y));
      if (!compatible(a.rows[0].maker, b.rows[0].maker)) continue;
      if (!compatible(a.rows[0].scale, b.rows[0].scale)) continue;
      // 型式番号が両方あって違う(例: KV-1 継続高校 / BT-42 継続高校)なら別物
      if (!compatible(modelCode(a.rows[0].name), modelCode(b.rows[0].name))) continue;
      pairs.set(pairKey(a, b), { a, b, mark: '' });
    }
  }
}

// 前回の review_same.csv の記入を引き継ぐ(候補から消えた組の記入も捨てずに残す)
const orphanMarks = [];
if (fs.existsSync(REVIEW_SAME)) {
  for (const r of readCsvObjects(REVIEW_SAME).rows) {
    const mark = r['まとめる'] ?? '';
    const a = baseById.get(r['id_A']), b = baseById.get(r['id_B']);
    if (a && b && pairs.has(pairKey(a, b))) pairs.get(pairKey(a, b)).mark = mark;
    else if (a && b && MERGE_MARKS.has(mark)) pairs.set(pairKey(a, b), { a, b, mark }); // 手で追加した組も有効
    else if (mark) orphanMarks.push(r);
  }
}

// ○ の組を統合(A=B, B=C なら A・B・C を1つに)。
// ただしメーカー・スケールが違うものが1つにまとまる統合はしない。
// 例: スケール不明の「νガンダム」に 1/144 とも 1/100 とも ○ があると、
//     つながって 1/144 と 1/100 が1つになってしまうため、その ○ は「矛盾」として保留する
const parent = new Map(baseKits.map((k) => [k.id, k.id]));
const find = (id) => (parent.get(id) === id ? id : find(parent.get(id)));
const attrs = new Map(baseKits.map((k) => [k.id, {
  makers: new Set([k.rows[0].maker].filter(Boolean)),
  scales: new Set([k.rows[0].scale].filter(Boolean)),
}]));
const unionAttrs = (x, y) => ({
  makers: new Set([...x.makers, ...y.makers]),
  scales: new Set([...x.scales, ...y.scales]),
});
const consistent = (a) => a.makers.size <= 1 && a.scales.size <= 1;
const union = (p) => {
  const [ra, rb] = [find(p.a.id), find(p.b.id)];
  if (ra === rb) return true;
  const u = unionAttrs(attrs.get(ra), attrs.get(rb));
  if (!consistent(u)) return false;
  // 先に出てきた方の id を残す
  const [keep, drop] = baseKits.indexOf(baseById.get(ra)) < baseKits.indexOf(baseById.get(rb)) ? [ra, rb] : [rb, ra];
  parent.set(drop, keep);
  attrs.set(keep, u);
  return true;
};
const known = (k) => k.rows[0].maker && k.rows[0].scale;
const markedPairs = [...pairs.values()].filter((p) => MERGE_MARKS.has(p.mark));
// 1) メーカー・スケールが両方分かっている組を先に統合
for (const p of markedPairs.filter((p) => known(p.a) && known(p.b))) if (!union(p)) p.conflict = true;
// 2) 不明を含む組: 不明側が別々のメーカー・スケールの相手と ○ なら、その不明側の組はすべて保留
const rest = markedPairs.filter((p) => !(known(p.a) && known(p.b)));
const partnerAttrs = new Map();
for (const p of rest) {
  for (const [self, other] of [[p.a, p.b], [p.b, p.a]]) {
    const r = find(self.id);
    partnerAttrs.set(r, unionAttrs(partnerAttrs.get(r) ?? attrs.get(r), attrs.get(find(other.id))));
  }
}
for (const p of rest) {
  const bad = [p.a, p.b].some((k) => !consistent(partnerAttrs.get(find(k.id))));
  if (bad || !union(p)) p.conflict = true;
}

// ---------------------------------------------------------------- キットを確定

const merged = new Map();
for (const k of baseKits) {
  const root = find(k.id);
  if (!merged.has(root)) merged.set(root, { id: root, members: [] });
  merged.get(root).members.push(k);
}

const kits = [...merged.values()].map((m) => {
  const rows = m.members.flatMap((k) => k.rows).sort(sortRef);
  const names = rows.map((r) => r.name);
  const nonEmpty = (vals) => vals.filter(Boolean);
  const reasons = new Set(rows.flatMap((r) => r.reasons));
  const grades = [...new Set(rows.map((r) => r.grade).filter(Boolean))];
  if (grades.length > 1) reasons.add(`グレード違いの可能性(${grades.join('/')})`);
  const makers = nonEmpty(rows.map((r) => r.maker));
  const scales = nonEmpty(rows.map((r) => r.scale));
  // 統合してメーカー・スケールがそろったら、分けた理由の要確認は外す
  if (m.members.length > 1) {
    reasons.delete(GRADE_UNKNOWN);
    if (makers.length) reasons.delete('メーカー不明');
  }
  if (new Set(makers).size > 1 || new Set(scales).size > 1) reasons.add('統合した作例でメーカーかスケールが違う');
  return {
    id: m.id,
    members: m.members,
    rows,
    name: mostFrequent(names),
    names: [...new Set(names)],
    maker: makers.length ? mostFrequent(makers) : '',
    scale: scales.length ? mostFrequent(scales) : '',
    grades,
    reasons,
  };
});
kits.sort((a, b) => sortRef(a.rows[0], b.rows[0]) || a.id.localeCompare(b.id));
kits.forEach((k, i) => { k.no = `HJ-${String(i + 1).padStart(4, '0')}`; });
const kitOfBase = new Map(kits.flatMap((k) => k.members.map((b) => [b.id, k])));

// 未記入の組が残っていれば「同じキットの可能性」を付ける
for (const p of pairs.values()) {
  const ka = kitOfBase.get(p.a.id), kb = kitOfBase.get(p.b.id);
  if (ka === kb) continue;
  if (p.conflict) {
    ka.conflict ??= new Set(); kb.conflict ??= new Set();
    ka.conflict.add(kb.no); kb.conflict.add(ka.no);
    continue;
  }
  if (p.mark) continue;
  ka.similar ??= new Set(); kb.similar ??= new Set();
  ka.similar.add(kb.no); kb.similar.add(ka.no);
}
for (const k of kits) {
  if (k.similar) k.reasons.add(`同じキットの可能性: ${[...k.similar].sort().join(' ')}(review_same.csv)`);
  if (k.conflict) {
    k.reasons.add(`○が矛盾して統合を保留(メーカーかスケールが違う相手とつながる): ${[...k.conflict].sort().join(' ')}`);
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

const workRefs = (rows) => rows.map((r) =>
  `${r.issue} p.${r.page} ${r.name}${r.builder ? `(${r.builder})` : ''}`).join(' | ');

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
  works_detail: workRefs(k.rows),
  work_ids: k.rows.map(workId).join(' '),
}));

const aliasRecords = [];
for (const k of kits) {
  for (const n of k.names) {
    if (n === k.name) continue;
    aliasRecords.push({ kit_no: k.no, kit_id: k.id, kit_name: k.name, alias: n });
  }
}

const excludedRecords = excluded.sort(sortRef).map((r) => ({
  issue: r.issue, page: r.page, type: r.type, kit_name: r.name, maker: r.rawMaker,
  scale: r.scale, title: r.title, builder: r.builder, note: r.note, reason: r.reason,
}));

const reviewRecords = [...pairs.values()]
  .sort((x, y) => baseKits.indexOf(x.a) - baseKits.indexOf(y.a) || baseKits.indexOf(x.b) - baseKits.indexOf(y.b))
  .map((p) => ({
    '候補A': describe(p.a),
    '候補B': describe(p.b),
    '作例の号': `A: ${p.a.rows.map((r) => `${r.issue} p.${r.page}`).join(', ')} / B: ${p.b.rows.map((r) => `${r.issue} p.${r.page}`).join(', ')}`,
    'まとめる': p.mark,
    '状態': p.conflict ? '矛盾のため保留' : (MERGE_MARKS.has(p.mark) ? '統合済み' : ''),
    'キット番号': `${kitOfBase.get(p.a.id).no} / ${kitOfBase.get(p.b.id).no}`,
    'id_A': p.a.id,
    'id_B': p.b.id,
  }));
// 候補から消えた組の記入も失わないよう末尾に残す
for (const r of orphanMarks) reviewRecords.push({ ...r, '状態': '候補から消えた組' });

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'kits_preview.csv'), toCsv(
  ['no', 'id', 'name', 'maker', 'scale', 'source', 'source_ref', 'needs_review',
    'review_reason', 'work_count', 'grade_hint', 'works_detail', 'work_ids'], kitRecords));
fs.writeFileSync(path.join(OUT_DIR, 'aliases_preview.csv'), toCsv(
  ['kit_no', 'kit_id', 'kit_name', 'alias'], aliasRecords));
fs.writeFileSync(path.join(OUT_DIR, 'excluded_rows.csv'), toCsv(
  ['issue', 'page', 'type', 'kit_name', 'maker', 'scale', 'title', 'builder', 'note', 'reason'],
  excludedRecords));
fs.writeFileSync(REVIEW_SAME, toCsv(
  ['候補A', '候補B', '作例の号', 'まとめる', '状態', 'キット番号', 'id_A', 'id_B'], reviewRecords));

// ---------------------------------------------------------------- 集計

const count = (list, labelOf) => {
  const m = new Map();
  for (const x of list) for (const l of labelOf(x)) m.set(l, (m.get(l) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
};
const reviewKits = kits.filter((k) => k.reasons.size);
const marked = markedPairs.length;
const conflicts = markedPairs.filter((p) => p.conflict).length;
console.log(`入力全行               : ${all.length}`);
console.log(`対象の作例             : ${works.length}(${[...TARGET_TYPES].map((t) => `${t} ${works.filter((r) => r.type === t).length}`).join('・')})`);
console.log(`除外した作例           : ${excluded.length}`);
for (const [l, n] of count(excluded, (r) => r.reason.split(' / '))) console.log(`    ${l}: ${n}`);
console.log(`取り込む作例           : ${usable.length}`);
console.log(`取り込むキット数       : ${kits.length}`);
console.log(`  2作例以上をまとめたキット: ${kits.filter((k) => k.rows.length > 1).length}`);
console.log(`  review_same.csv で統合    : ${marked - conflicts}組(○が矛盾して保留 ${conflicts}組)`);
console.log(`  要確認(needs_review)     : ${reviewKits.length}`);
for (const [l, n] of count(reviewKits, (k) => [...k.reasons].map((r) => r.replace(/[::].*$/, '').replace(/\(.*\)$/, '')))) {
  console.log(`    ${l}: ${n}`);
}
console.log(`別名                   : ${aliasRecords.length}`);
console.log(`review_same.csv        : ${reviewRecords.length}行(記入済み ${reviewRecords.filter((r) => r['まとめる']).length})`);
console.log(`メーカー空 / スケール空のキット: ${kits.filter((k) => !k.maker).length} / ${kits.filter((k) => !k.scale).length}`);
const unmapped = count(kits, (k) => [k.maker]).filter(([m]) => m);
console.log(`メーカーの種類         : ${unmapped.length}(対応表 ${makerMap.size}件を適用)`);
console.log(`出力先: ${OUT_DIR}`);
