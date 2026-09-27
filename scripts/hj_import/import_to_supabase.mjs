// kits_preview.csv / aliases_preview.csv を Supabase の kits / kit_aliases に取り込む
//
// 使い方(リポジトリのルートで。先に build_kits_preview.mjs を実行しておく):
//   node scripts/hj_import/import_to_supabase.mjs            確認だけ(書き込まない)
//   node scripts/hj_import/import_to_supabase.mjs --apply    書き込む
//
// 方針(再実行しても既存データを壊さない):
//   - 追加だけ行う。既にある kits / kit_aliases の行は一切更新・削除しない
//     (管理画面で直した名前や merged_into、キットに付いたレビューはそのまま)
//   - キットの id は「最初に載った作例」から作るので、再実行しても同じ id になる
//   - CSV 側で統合したキットの作例が、DB では別キットとして既にある場合は
//     そのキットを追加せずに止めて知らせる(管理画面の merged_into で統合する)

import path from 'node:path';
import { loadEnv, readCsv, client } from './supabase.mjs';

const APPLY = process.argv.includes('--apply');
const DIR = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'data';
const LIMIT = { name: 100, maker: 50, scale: 20, source_ref: 200, alias: 100 };

const env = loadEnv();
const db = client(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const kits = readCsv(path.join(DIR, 'kits_preview.csv'));
const aliases = readCsv(path.join(DIR, 'aliases_preview.csv'));

// ---------------------------------------------------------------- CSV の検査

const problems = [];
const ids = new Set();
for (const k of kits) {
  if (!k.id || ids.has(k.id)) problems.push(`id が空か重複: ${k.no}`);
  ids.add(k.id);
  if (!k.name.trim()) problems.push(`名前が空: ${k.no}`);
  if (k.source !== 'hj') problems.push(`source が hj でない: ${k.no}`);
  for (const c of ['name', 'maker', 'scale', 'source_ref']) {
    if (k[c].length > LIMIT[c]) problems.push(`${c} が${LIMIT[c]}文字超: ${k.no}`);
  }
  if (!k.work_ids) problems.push(`work_ids が空(build_kits_preview.mjs を再実行してください): ${k.no}`);
}
for (const a of aliases) {
  if (!ids.has(a.kit_id)) problems.push(`別名のキットが kits_preview.csv にない: ${a.kit_no} ${a.alias}`);
  if (a.alias.length > LIMIT.alias) problems.push(`別名が${LIMIT.alias}文字超: ${a.kit_no}`);
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}

// ---------------------------------------------------------------- DB と突き合わせ

const existing = await db.selectAll('kits', 'select=id,name,maker,scale,source,merged_into');
const existingById = new Map(existing.map((k) => [k.id, k]));

const toInsert = [];
const blocked = [];      // 追加すると重複になるので止めたもの
const absorbed = [];     // CSV では統合済みだが DB では別キットのもの(merged_into の候補)
for (const k of kits) {
  const others = k.work_ids.split(' ').filter((w) => w !== k.id && existingById.has(w));
  for (const w of others) absorbed.push({ kit: k, dbKit: existingById.get(w) });
  if (existingById.has(k.id)) continue;
  if (others.length) blocked.push(k);
  else toInsert.push(k);
}
const allWorkIds = new Set(kits.flatMap((k) => k.work_ids.split(' ')));
const missingFromCsv = existing.filter((k) => k.source === 'hj' && !allWorkIds.has(k.id));

const insertable = new Set([...existingById.keys(), ...toInsert.map((k) => k.id)]);
const aliasRows = aliases.filter((a) => insertable.has(a.kit_id));

console.log(`kits_preview.csv       : ${kits.length}件`);
console.log(`DB の kits(全体)      : ${existing.length}件(うち hj ${existing.filter((k) => k.source === 'hj').length})`);
console.log(`  追加するキット       : ${toInsert.length}`);
console.log(`  既にある(変更しない) : ${kits.length - toInsert.length - blocked.length}`);
console.log(`  重複になるので保留   : ${blocked.length}`);
for (const k of blocked) console.log(`    ${k.no} ${k.name} ${k.scale}`);
if (absorbed.length) {
  console.log(`CSV では統合済みだが DB では別キット(管理画面で merged_into を検討): ${absorbed.length}`);
  for (const { kit, dbKit } of absorbed) {
    console.log(`    ${dbKit.id} ${dbKit.name} ${dbKit.scale ?? ''} → ${kit.id} ${kit.name} ${kit.scale}`);
  }
}
if (missingFromCsv.length) {
  console.log(`DB にあるが今回の CSV にない hj キット(そのまま残す): ${missingFromCsv.length}`);
  for (const k of missingFromCsv.slice(0, 20)) console.log(`    ${k.id} ${k.name} ${k.scale ?? ''}`);
}
console.log(`別名(追加対象、既にあるものは無視): ${aliasRows.length}`);

if (!APPLY) {
  console.log('\n確認のみ。書き込むには --apply を付けて実行してください。');
  process.exit(0);
}

// ---------------------------------------------------------------- 書き込み

const blank = (v) => (v.trim() ? v.trim() : null);
await db.insertIgnore('kits', toInsert.map((k) => ({
  id: k.id,
  name: k.name,
  maker: blank(k.maker),
  scale: blank(k.scale),
  source: 'hj',
  source_ref: blank(k.source_ref),
})), 'id');
await db.insertIgnore('kit_aliases', aliasRows.map((a) => ({ kit_id: a.kit_id, alias: a.alias })), 'kit_id,alias');

console.log(`\n書き込みました。kits: ${await db.count('kits', 'source=eq.hj')}件(hj) / kit_aliases: ${await db.count('kit_aliases')}件`);
