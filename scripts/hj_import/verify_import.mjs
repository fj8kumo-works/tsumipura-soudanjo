// 取り込み結果の確認(読むだけ。書き込まない)
//
// 使い方: node scripts/hj_import/verify_import.mjs
//   1. 件数が CSV と一致する
//   2. 別名で検索すると正しいキットが出る(公開画面と同じ anon キーで確認)
//   3. 統合した組が重複していない
// NG があれば終了コード 1

import path from 'node:path';
import { loadEnv, readCsv, client } from './supabase.mjs';

const DIR = process.argv[2] ?? 'data';
const env = loadEnv();
const admin = client(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const anon = env.SUPABASE_ANON_KEY ? client(env.SUPABASE_URL, env.SUPABASE_ANON_KEY) : null;

const kits = readCsv(path.join(DIR, 'kits_preview.csv'));
const aliases = readCsv(path.join(DIR, 'aliases_preview.csv'));

let ng = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK' : 'NG'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) ng++;
};
const key = (k) => [k.name, k.maker ?? '', k.scale ?? ''].join('|');

// ---------------------------------------------------------------- 1. 件数

const dbKits = await admin.selectAll('kits', 'select=id,name,maker,scale,source,source_ref&source=eq.hj');
const dbById = new Map(dbKits.map((k) => [k.id, k]));
check('hj キットの件数が kits_preview.csv と一致', dbKits.length === kits.length,
  `DB ${dbKits.length} / CSV ${kits.length}`);

const missing = kits.filter((k) => !dbById.has(k.id));
check('CSV の全キットが同じ id で DB にある', missing.length === 0,
  missing.slice(0, 5).map((k) => k.no).join(' '));

const diff = kits.filter((k) => {
  const d = dbById.get(k.id);
  return d && (d.name !== k.name || (d.maker ?? '') !== k.maker || (d.scale ?? '') !== k.scale
    || (d.source_ref ?? '') !== k.source_ref);
});
check('名前・メーカー・スケール・source_ref が CSV と一致', diff.length === 0,
  diff.slice(0, 5).map((k) => k.no).join(' '));

const hjIds = new Set(dbKits.map((k) => k.id));
const dbAliases = (await admin.selectAll('kit_aliases', 'select=id,kit_id,alias')).filter((a) => hjIds.has(a.kit_id));
check('hj キットの別名の件数が aliases_preview.csv と一致', dbAliases.length === aliases.length,
  `DB ${dbAliases.length} / CSV ${aliases.length}`);
const dbAliasSet = new Set(dbAliases.map((a) => `${a.kit_id}|${a.alias}`));
const missingAlias = aliases.filter((a) => !dbAliasSet.has(`${a.kit_id}|${a.alias}`));
check('CSV の全別名が正しいキットに付いている', missingAlias.length === 0,
  missingAlias.slice(0, 5).map((a) => `${a.kit_no} ${a.alias}`).join(', '));

// ---------------------------------------------------------------- 2. 別名で検索

const reader = anon ?? admin;
if (!anon) console.log('--  SUPABASE_ANON_KEY がないので、検索は service_role で確認します');
async function searchByAlias(alias) {
  const q = `select=alias,kits(id,name,maker,scale)&alias=eq.${encodeURIComponent(alias)}`;
  return reader.get('kit_aliases', q);
}
{
  const hits = await searchByAlias('ドアン専用ザク');
  const names = hits.map((h) => `${h.kits.name} ${h.kits.scale ?? ''}`);
  check('別名「ドアン専用ザク」で「MS-06F ドアン専用ザク 1/144」が1件出る',
    hits.length === 1 && hits[0].kits.name === 'MS-06F ドアン専用ザク' && hits[0].kits.scale === '1/144',
    names.join(', ') || '0件');
}
// CSV の別名すべてで、正しいキットが引けるか
{
  let wrong = 0;
  for (const a of aliases) {
    const hits = await searchByAlias(a.alias);
    if (!hits.some((h) => h.kits.id === a.kit_id)) wrong++;
  }
  check(`全別名(${aliases.length}件)で検索して正しいキットが出る`, wrong === 0, wrong ? `${wrong}件ずれ` : '');
}

// ---------------------------------------------------------------- 3. 統合した組が重複していない

{
  const hits = dbKits.filter((k) => k.name === 'RX-78-2 ガンダム' && k.scale === '1/100');
  const csvKit = kits.find((k) => k.name === 'RX-78-2 ガンダム' && k.scale === '1/100');
  check('「RX-78-2 ガンダム 1/100」が1件', hits.length === 1, `${hits.length}件`);
  check('  その1件に統合した5作例が入っている', csvKit?.work_count === '5' && hits[0]?.id === csvKit.id,
    `作例 ${csvKit?.work_count}`);
}
// 統合で消えた元キット(統合先以外の作例 id)が DB にキットとして残っていない
{
  const absorbed = kits.flatMap((k) => k.work_ids.split(' ').filter((w) => w !== k.id));
  const left = absorbed.filter((w) => dbById.has(w));
  check('統合したキットの元キットが DB に残っていない', left.length === 0, `${left.length}件`);
}
// 同じ名前・メーカー・スケールの組の数が CSV と同じ(統合で1件になったものが増えていない)
{
  const dupCount = (list) => {
    const m = new Map();
    for (const k of list) m.set(key(k), (m.get(key(k)) ?? 0) + 1);
    return [...m.values()].filter((n) => n > 1).reduce((s, n) => s + n, 0);
  };
  const csvLike = kits.map((k) => ({ name: k.name, maker: k.maker || null, scale: k.scale || null }));
  check('同名・同メーカー・同スケールのキット数が CSV と一致(統合した組が重複していない)',
    dupCount(dbKits) === dupCount(csvLike), `DB ${dupCount(dbKits)} / CSV ${dupCount(csvLike)}`);
}

console.log(`\n${ng ? `NG ${ng}件` : 'すべて OK'}`);
process.exit(ng ? 1 : 0);
