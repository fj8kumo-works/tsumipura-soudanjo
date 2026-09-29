// 予約リマインドアプリから出力した CSV を kits に取り込む
//
// 使い方(リポジトリのルートで。先に 005_kit_reminder_source.sql を適用しておく):
//   node scripts/reminder_import/import_reminder.mjs            確認だけ(書き込まない)
//   node scripts/reminder_import/import_reminder.mjs --apply    書き込む
//   ファイルを変えるとき: node scripts/reminder_import/import_reminder.mjs <CSV> [--apply]
//
// CSV(既定: data/reminder_export.csv。Excel で Shift_JIS 保存しても読める)
//   kit_name       キット名(必須)。「1/24 スバル BRZ」のようにスケールが入っていれば取り出して scale 列に入れる
//   maker          メーカー。scripts/hj_import/maker_aliases.csv で表記をそろえる。空なら必ず「要確認」
//   ※ CSV の中で名前が似ている行(書き方違いの同じキットかもしれない)は、両方とも「要確認」になる。
//     同じキットなら CSV を1行にまとめてから、もう一度確認する
//   release_month  発売月(例: 2026-10)。空でもよい
//
// 確認だけのとき、判定結果を data/reminder_review.csv に書き出す。
//   「要確認」の行は、登録してよければ「登録」列に ○ を入れて保存する(記入は次回の確認にも引き継ぐ)
//
// --apply で書き込むもの:
//   ・「新規」と、「要確認」のうち ○ を付けたキット(source = 'reminder')
//   ・「重複」で、DB のキットの発売月が空のものは、CSV の発売月を入れる(ほかの列は変えない)
// 既にあるキットは消さない・名前も変えない。キットの id は照合キーから作るので、同じ CSV を
// 何度実行しても二重には登録されない。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, readCsv, writeCsv, client } from '../hj_import/supabase.mjs';
import { makerUnifier, prepareRow, indexKits, classify, kitIdFor, parseReleaseMonth } from './match.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MAKER_ALIASES = path.join(SCRIPT_DIR, '..', 'hj_import', 'maker_aliases.csv');
const APPLY = process.argv.includes('--apply');
const FILE = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'data/reminder_export.csv';
const REVIEW = path.join(path.dirname(FILE), 'reminder_review.csv');
const COLUMNS = ['kit_name', 'maker', 'release_month'];
const LIMIT = { name: 100, maker: 50, scale: 20 };
const MARKS = new Set(['○', '〇', '◯', 'o', 'O', 'ｏ', 'Ｏ']);

const problems = [];
// 何が起きたか / どうすれば直るか を組にして記録する
const problem = (where, what, how) => problems.push({ where, what, how });

function stopWithProblems() {
  console.error(`\n問題が ${problems.length} 件あるため、何も書き込まずに止めました。\n`);
  for (const p of problems) {
    console.error(`■ ${p.where}`);
    console.error(`  何が起きたか : ${p.what}`);
    console.error(`  どうすれば直るか: ${p.how}\n`);
  }
  process.exit(1);
}

// ---------------------------------------------------------------- 準備

let env, rows;
try {
  env = loadEnv();
} catch (e) {
  problem('.env', e.message, '.env.example をコピーして .env を作り、SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY を入れてください。');
  stopWithProblems();
}
try {
  // 見出しの前後の空白は無視する
  rows = readCsv(FILE).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.trim(), v])));
} catch {
  problem(FILE, 'CSV ファイルが見つからないか、読み込めませんでした。',
    `予約リマインドアプリから出力した CSV を ${FILE} に置いてください。列は「${COLUMNS.join(',')}」です。`);
  stopWithProblems();
}
if (!rows.length) {
  problem(FILE, 'CSV にキットの行がありません。', '予約リマインドアプリから出力し直した CSV を置いてください。');
  stopWithProblems();
}
const missing = COLUMNS.filter((c) => !(c in rows[0]));
if (missing.length) {
  problem(FILE, `見出しの行に ${missing.join(',')} の列がありません(今の見出し: ${Object.keys(rows[0]).join(',')})。`,
    `1行目を「${COLUMNS.join(',')}」にしてください。`);
  stopWithProblems();
}

const unifyMaker = makerUnifier(readCsv(MAKER_ALIASES));

// ---------------------------------------------------------------- CSV の検査

const prepared = rows.map((r, i) => {
  const line = i + 2;   // 見出しが1行目
  const p = { line, raw: r, ...prepareRow(r, unifyMaker), release_month: parseReleaseMonth(r.release_month) };
  const where = `${FILE} の ${line} 行目(${r.kit_name || '名前なし'})`;
  if (!p.name) problem(where, 'キット名が空です。', 'kit_name を入れるか、その行を消してください。');
  if (p.name.length > LIMIT.name) problem(where, `キット名が ${LIMIT.name} 文字を超えています。`, `${LIMIT.name} 文字以内に縮めてください。`);
  if (p.maker.length > LIMIT.maker) problem(where, `メーカー名が ${LIMIT.maker} 文字を超えています。`, `${LIMIT.maker} 文字以内に縮めてください。`);
  if (p.scale.length > LIMIT.scale) problem(where, `スケールが ${LIMIT.scale} 文字を超えています。`, 'キット名に書かれたスケールを確認してください。');
  if (p.release_month === undefined) {
    problem(where, `発売月「${r.release_month}」の形が読み取れません。`, '「2026-10」のように 年-月 で書くか、空にしてください。');
  }
  return p;
});
if (problems.length) stopWithProblems();

// ---------------------------------------------------------------- DB と突き合わせ

const db = client(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
let kits, aliases;
try {
  kits = await db.selectAll('kits', 'select=id,name,maker,scale,release_month,merged_into');
  aliases = await db.selectAll('kit_aliases', 'select=id,kit_id,alias');
} catch (e) {
  if (/release_month/.test(e.message)) {
    problem('Supabase', 'kits に release_month の列がありません(005 がまだ適用されていません)。',
      'SQL Editor で supabase/migrations/005_kit_reminder_source.sql を実行してから、もう一度実行してください。');
  } else {
    problem('Supabase', `DB を読めませんでした(${e.message})。`,
      '.env の SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が正しいか、ネットにつながっているかを確認してください。');
  }
  stopWithProblems();
}

const results = classify(prepared, indexKits(kits, aliases, unifyMaker));

// 前回の review CSV の「登録」列の記入を引き継ぐ
const marks = new Map();
if (fs.existsSync(REVIEW)) {
  for (const r of readCsv(REVIEW)) if (r['照合キー']) marks.set(r['照合キー'], (r['登録'] ?? '').trim());
}
for (const r of results) {
  r.mark = marks.get(r.key) ?? '';
  r.register = r.status === '新規' || (r.status === '要確認' && MARKS.has(r.mark));
  // 重複のうち、DB の発売月が空で CSV に発売月があるもの
  r.fillMonth = r.status === '重複' && r.match && !r.match.release_month && r.release_month ? r.release_month : null;
}

// ---------------------------------------------------------------- 表示

const month = (d) => (d ? d.slice(0, 7) : '');
const label = (r) => `${r.line}行目 ${r.name}${r.scale ? ` [${r.scale}]` : ''} / ${r.maker || '(メーカー空)'}${r.release_month ? ` / ${month(r.release_month)}` : ''}`;
const kitLabel = (k) => `${k.name}${k.scale ? ` [${k.scale}]` : ''} / ${k.maker || '(メーカー空)'}${k.release_month ? ` / ${month(k.release_month)}` : ''}  (${k.id})`;
const byStatus = (s) => results.filter((r) => r.status === s);

console.log(`CSV: ${FILE}  ${results.length}件 / DB の kits: ${kits.length}件\n`);

console.log(`■ 新規(登録する): ${byStatus('新規').length}件`);
for (const r of byStatus('新規')) console.log(`  ${label(r)}`);

console.log(`\n■ 重複(登録しない): ${byStatus('重複').length}件`);
for (const r of byStatus('重複')) {
  console.log(`  ${label(r)}`);
  if (r.match) console.log(`      = DB: ${kitLabel(r.match)}`);
  if (r.reason) console.log(`      ${r.reason}`);
  if (r.fillMonth) console.log(`      → DB の発売月が空なので ${month(r.fillMonth)} を入れる`);
  else if (r.match?.release_month && r.release_month && r.match.release_month !== r.release_month) {
    console.log(`      ※ 発売月が DB(${month(r.match.release_month)})と違う。DB は変えない`);
  }
}

console.log(`\n■ 要確認: ${byStatus('要確認').length}件(○ を付けたものだけ登録する)`);
for (const r of byStatus('要確認')) {
  console.log(`  ${label(r)}  … ${r.reason}  [登録: ${MARKS.has(r.mark) ? '○' : 'しない'}]`);
  for (const c of r.candidates) console.log(`      似ている DB のキット: ${kitLabel(c)}`);
  for (const s of r.csvSimilar) {
    console.log(`      似ている CSV の行: ${s.line} ${s.name}${s.scale ? ` [${s.scale}]` : ''} / ${s.maker || '(メーカー空)'}`);
  }
}

const toInsert = results.filter((r) => r.register);
const toFill = results.filter((r) => r.fillMonth);
console.log(`\n登録するキット: ${toInsert.length}件 / 発売月を入れる既存キット: ${toFill.length}件`);

if (!APPLY) {
  const header = ['行', '判定', '理由', '登録', 'キット名(CSV)', '登録する名前', 'スケール', 'メーカー', '発売月',
    '候補1', '候補2', '候補3', '照合キー'];
  writeCsv(REVIEW, header, results.map((r) => ({
    '行': r.line, '判定': r.status, '理由': r.reason, '登録': r.status === '要確認' ? r.mark : '',
    'キット名(CSV)': r.raw.kit_name, '登録する名前': r.name, 'スケール': r.scale, 'メーカー': r.maker,
    '発売月': month(r.release_month),
    '候補1': r.match ? kitLabel(r.match) : r.candidates[0] ? kitLabel(r.candidates[0]) : '',
    '候補2': r.match ? '' : r.candidates[1] ? kitLabel(r.candidates[1]) : '',
    '候補3': r.match ? '' : r.candidates[2] ? kitLabel(r.candidates[2]) : '',
    '照合キー': r.key,
  })));
  console.log(`\n確認のみ。一覧を ${REVIEW} に書き出しました。`);
  console.log('「要確認」で登録してよいものは、そのファイルの「登録」列に ○ を入れて保存し、もう一度この確認を実行してください。');
  console.log('内容が良ければ --apply を付けて実行すると書き込みます。');
  process.exit(0);
}

// ---------------------------------------------------------------- 書き込み

try {
  await db.insertIgnore('kits', toInsert.map((r) => ({
    id: kitIdFor(r.key),
    name: r.name,
    maker: r.maker || null,
    scale: r.scale || null,
    source: 'reminder',
    release_month: r.release_month,
  })), 'id');
  let filled = 0;
  for (const r of toFill) {
    // 発売月が空のときだけ入れる(確認のあとに誰かが入れていたら上書きしない)
    const updated = await db.update('kits', `id=eq.${r.match.id}&release_month=is.null`, { release_month: r.fillMonth });
    filled += updated.length;
  }
  console.log(`\n書き込みました。登録: ${toInsert.length}件(既にあったものは飛ばしました) / 発売月を入れた既存キット: ${filled}件`);
  console.log(`source = reminder のキットは全部で ${await db.count('kits', 'source=eq.reminder')}件です。`);
} catch (e) {
  problem('Supabase', `書き込みの途中で失敗しました(${e.message})。`,
    '途中まで書き込まれている可能性があります。もう一度 --apply で実行すると、残りだけが書き込まれます。'
    + '同じエラーが続くときは、005 を適用したかと .env の値を確認してください。');
  stopWithProblems();
}
