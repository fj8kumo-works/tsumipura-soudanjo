// 取り込み済みキットの「名前の修正」と「重複の統合」を CSV でまとめて反映する
// (管理画面ができるまでのつなぎ)
//
// 使い方(リポジトリのルートで):
//   node scripts/admin/apply_kit_corrections.mjs            確認だけ(書き込まない)
//   node scripts/admin/apply_kit_corrections.mjs --apply    書き込む
//   ファイルを変えるとき: node scripts/admin/apply_kit_corrections.mjs <CSV> [--apply]
//
// CSV(既定: data/kit_corrections.csv。Excel で Shift_JIS 保存しても読める)
//   キットid        直すキットの id(必須)
//   今の名前        DB の今の名前。DB と違えば止める(古い CSV で上書きしないため)
//   新しい名前      入っていれば名前を変える。変更前の名前は自動で別名に残る
//   統合先のキットid 入っていれば、このキットを統合先にまとめる(merged_into)。
//                   レビュー・押下記録も統合先へ付け替え、名前と別名は統合先の別名に残る
//   メモ            自由記入(DB には書かない)
//
// 反映済みの行は何もしないので、同じ CSV を何度実行してもよい。
// 1行ずつ DB 関数 admin_apply_kit_correction(003_kit_corrections.sql)で反映する。
// 1行の中身(名前の変更・統合・付け替え)は、全部反映されるか何も反映されないかのどちらか。

import { loadEnv, readCsv, client } from '../hj_import/supabase.mjs';

const APPLY = process.argv.includes('--apply');
const FILE = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'data/kit_corrections.csv';
const COLUMNS = ['キットid', '今の名前', '新しい名前', '統合先のキットid', 'メモ'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_MAX = 100;

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
  rows = readCsv(FILE);
} catch {
  problem(FILE, 'CSV ファイルが見つからないか、読み込めませんでした。',
    `ファイルの場所(${FILE})を確認してください。列は「${COLUMNS.join(',')}」です。`);
  stopWithProblems();
}
if (rows.length && COLUMNS.slice(0, 4).some((c) => !(c in rows[0]))) {
  problem(FILE, `見出しの行に必要な列がありません(今の見出し: ${Object.keys(rows[0]).join(',')})。`,
    `1行目を「${COLUMNS.join(',')}」にしてください。`);
  stopWithProblems();
}
const db = client(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

// ---------------------------------------------------------------- CSV の検査

const items = rows.map((r, i) => ({
  line: i + 2, // 1行目は見出し
  id: (r['キットid'] ?? '').trim().toLowerCase(),
  currentName: (r['今の名前'] ?? '').trim(),
  newName: (r['新しい名前'] ?? '').trim(),
  mergeInto: (r['統合先のキットid'] ?? '').trim().toLowerCase(),
  memo: (r['メモ'] ?? '').trim(),
})).filter((it) => it.id || it.newName || it.mergeInto);

const seen = new Map();
for (const it of items) {
  const at = `${it.line}行目`;
  if (!UUID_RE.test(it.id)) {
    problem(at, `キットid「${it.id}」の形式が正しくありません。`,
      'Supabase の kits 表か kits_preview.csv から id(xxxxxxxx-xxxx-… の形)をコピーし直してください。');
  }
  if (it.mergeInto && !UUID_RE.test(it.mergeInto)) {
    problem(at, `統合先のキットid「${it.mergeInto}」の形式が正しくありません。`,
      '統合先の id をコピーし直してください。統合しないなら空欄にしてください。');
  }
  if (!it.newName && !it.mergeInto) {
    problem(at, '「新しい名前」も「統合先のキットid」も空なので、何をすればよいか分かりません。',
      'どちらかを入れるか、不要ならこの行を消してください。');
  }
  if (it.newName.length > NAME_MAX) {
    problem(at, `新しい名前が ${it.newName.length} 文字あり、上限の ${NAME_MAX} 文字を超えています。`,
      `${NAME_MAX} 文字以内に短くしてください。`);
  }
  if (it.mergeInto && it.mergeInto === it.id) {
    problem(at, '統合先が自分自身になっています。', '統合先には、残す方のキットの id を入れてください。');
  }
  if (seen.has(it.id)) {
    problem(at, `同じキットid が ${seen.get(it.id)}行目 にもあります。`,
      '1つのキットにつき1行にまとめてください(名前の修正と統合は同じ行に書けます)。');
  } else {
    seen.set(it.id, it.line);
  }
}
// 統合先が、同じ CSV で別のキットに統合されるなら連鎖になる
const mergedHere = new Map(items.filter((it) => it.mergeInto).map((it) => [it.id, it]));
for (const it of items) {
  const chain = mergedHere.get(it.mergeInto);
  if (chain && it.mergeInto !== it.id) {
    problem(`${it.line}行目`,
      `統合先のキットは、${chain.line}行目 でさらに別のキット(${chain.mergeInto})に統合されます。`,
      `統合は1段にする決まりです。統合先には最終的な ${chain.mergeInto} を入れてください。`);
  }
}
if (problems.length) stopWithProblems();

// ---------------------------------------------------------------- DB と突き合わせ

let dbKits;
try {
  if (!(await db.hasRpc('admin_apply_kit_correction'))) {
    problem('データベース', '修正用の DB 関数 admin_apply_kit_correction がまだありません。',
      'Supabase の SQL Editor で supabase/migrations/003_kit_corrections.sql を実行してから、もう一度試してください。');
    stopWithProblems();
  }
  const ids = [...new Set(items.flatMap((it) => [it.id, it.mergeInto].filter(Boolean)))];
  dbKits = new Map((await db.get('kits', `select=id,name,maker,scale,merged_into&id=in.(${ids.join(',')})`))
    .map((k) => [k.id, k]));
} catch (e) {
  problem('データベース', `Supabase に接続できませんでした(${e.message.slice(0, 200)})。`,
    'ネット接続と、.env の SUPABASE_URL・SUPABASE_SERVICE_ROLE_KEY が正しいか確認してください。');
  stopWithProblems();
}

const label = (k) => `「${k.name}」${k.scale ? ` ${k.scale}` : ''}`;
const plans = [];
for (const it of items) {
  const at = `${it.line}行目`;
  const k = dbKits.get(it.id);
  if (!k) {
    problem(at, `キット ${it.id} が DB にありません。`, 'キットid が正しいか、Supabase の kits 表で確認してください。');
    continue;
  }
  const steps = [];
  // 名前の修正
  if (it.newName) {
    if (k.name === it.newName) {
      steps.push(`名前: 反映済み(${label(k)})`);
    } else if (it.currentName && k.name !== it.currentName) {
      problem(at, `DB の今の名前は「${k.name}」で、CSV の「今の名前」(「${it.currentName}」)と違います。`,
        'CSV を作った後に名前が変わった可能性があります。「今の名前」を DB の名前に直し、「新しい名前」が今も正しいか確認してください。');
      continue;
    } else {
      steps.push(`名前を変更: 「${k.name}」→「${it.newName}」(変更前の名前は別名に残す)`);
      it.willRename = true;
    }
  }
  // 統合
  if (it.mergeInto) {
    const t = dbKits.get(it.mergeInto);
    if (k.merged_into === it.mergeInto) {
      steps.push(`統合: 反映済み(→ ${t ? label(t) : it.mergeInto})`);
    } else if (k.merged_into) {
      problem(at, `このキットはすでに別のキット ${k.merged_into} に統合されています。`,
        '統合先を変えたいときは、今の統合先の行を見直してください。統合をやめる操作はこのスクリプトではできません。');
      continue;
    } else if (!t) {
      problem(at, `統合先のキット ${it.mergeInto} が DB にありません。`, '統合先のキットid が正しいか確認してください。');
      continue;
    } else if (t.merged_into) {
      problem(at, `統合先のキット${label(t)}は、すでに別のキット ${t.merged_into} に統合されています。`,
        `統合は1段にする決まりです。統合先には ${t.merged_into} を入れてください。`);
      continue;
    } else {
      if ((k.scale ?? '') !== (t.scale ?? '') || (k.maker ?? '') !== (t.maker ?? '')) {
        steps.push(`※ 注意: メーカーかスケールが違うキット同士です(${k.maker ?? '不明'} ${k.scale ?? ''} → ${t.maker ?? '不明'} ${t.scale ?? ''})`);
      }
      steps.push(`統合: ${label(k)} → ${label(t)}(レビュー・押下記録も付け替え、名前は統合先の別名に残す)`);
      it.willMerge = true;
    }
  }
  plans.push({ it, k, steps });
}
if (problems.length) stopWithProblems();

// ---------------------------------------------------------------- 確認の表示

const todo = plans.filter((p) => p.it.willRename || p.it.willMerge);
console.log(`${FILE}: ${items.length}行(反映する ${todo.length} / 反映済み ${items.length - todo.length})\n`);
for (const { it, k, steps } of plans) {
  console.log(`${it.line}行目 ${k.id}${it.memo ? `  [${it.memo}]` : ''}`);
  for (const s of steps) console.log(`    ${s}`);
}

if (!APPLY) {
  console.log(todo.length
    ? '\n確認のみです。この内容で書き込むには --apply を付けて実行してください。'
    : '\nすべて反映済みです。書き込むものはありません。');
  process.exit(0);
}

// ---------------------------------------------------------------- 書き込み

let done = 0;
for (const { it } of todo) {
  try {
    const r = await db.rpc('admin_apply_kit_correction', {
      p_kit_id: it.id,
      p_current_name: it.currentName || null,
      p_new_name: it.willRename ? it.newName : null,
      p_merge_into: it.willMerge ? it.mergeInto : null,
    });
    done++;
    const parts = [];
    if (r.renamed_to) parts.push('名前を変更');
    if (r.merged_into) parts.push(`統合(レビュー ${r.reviews_moved}件・押下記録 ${r.actions_moved}件を付け替え${r.actions_left ? `、重複のため ${r.actions_left}件は統合元に残した` : ''})`);
    console.log(`${it.line}行目: ${parts.join('、') || '変更なし'}`);
  } catch (e) {
    // DB 関数のエラー文(日本語)を取り出す
    const msg = (e.message.match(/"message":"((?:[^"\\]|\\.)*)"/)?.[1] ?? e.message).replace(/\\"/g, '"');
    console.error(`\n${it.line}行目で止めました。この行は反映されていません(ここより前の行で反映した分はそのまま残ります)。`);
    console.error(`  何が起きたか : ${msg}`);
    console.error('  どうすれば直るか: 上の内容に沿って CSV を直し、もう一度実行してください。反映済みの行は自動で飛ばします。');
    process.exit(1);
  }
}
console.log(`\n${done}行を反映しました。`);
