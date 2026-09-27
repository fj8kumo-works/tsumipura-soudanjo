// Supabase からの読み出し(公開用の publishable キーだけを使う)
//
// X などのアプリ内ブラウザでも確実に動くよう、ライブラリ(supabase-js)を使わず、
// ブラウザ標準の fetch で Supabase の REST API を直接呼ぶ。
//   ・特別なヘッダーを付けない GET だけにする(キーは URL の apikey= で渡す)。
//     こうすると CORS の事前確認(preflight)が起きず、アプリ内ブラウザで止まる原因を減らせる
//   ・外部の CDN から追加のファイルを読み込まない
//   ・10秒で打ち切り、「何が起きたか / どうすれば直るか」を日本語で返す
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';

const SEARCH_LIMIT = 50;
const TIMEOUT_MS = 10000;
const IN_APP_HINT = 'X などのアプリの中で開いている場合は、Safari や Chrome などのブラウザで開くと表示できる場合があります。';

// 利用者に見せるエラー(何が起きたか / どうすれば直るか)
export class AppError extends Error {
  constructor(what, how, detail = '') {
    super(detail ? `${what}(${detail})` : what);
    this.what = what;
    this.how = how;
  }
}

// 管理者用のキーがブラウザに置かれていたら、使わずに止める
function checkConfig() {
  const key = SUPABASE_PUBLISHABLE_KEY;
  if (!SUPABASE_URL || !key) {
    throw new AppError('接続先が設定されていません。', 'assets/config.js に Supabase の URL と publishable キーを入れてください。');
  }
  if (key.startsWith('sb_publishable_')) return;
  if (key.startsWith('sb_secret_')) {
    throw new AppError('assets/config.js に secret キーが入っています。', 'すぐに消して、publishable キーに差し替えてください。');
  }
  // 旧形式(JWT)のキーは role が anon のものだけ許す
  let role = '';
  try {
    role = JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role;
  } catch { /* 形式が違う */ }
  if (role !== 'anon') {
    throw new AppError('assets/config.js のキーが publishable キーではありません。',
      'service_role キーなどは絶対に置かず、publishable キーに差し替えてください。');
  }
}

// REST API を GET で呼ぶ。params は [名前, 値] の配列(同じ名前を何度でも指定できる)
// action はエラー文に使う言葉(「検索」「読み込み」)
async function get(table, params, action = '読み込み') {
  checkConfig();
  const qs = new URLSearchParams(params);
  qs.append('apikey', SUPABASE_PUBLISHABLE_KEY);
  const url = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${table}?${qs}`;

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller?.abort(); }, TIMEOUT_MS);
  // AbortController がないブラウザでも、10秒で待つのをやめる
  const timeout = new Promise((_, reject) => setTimeout(() => {
    reject(new AppError(`${action}に時間がかかっています(10秒以上応答がありません)。`,
      `電波の良い場所で、もう一度お試しください。${IN_APP_HINT}`));
  }, TIMEOUT_MS + 500));

  try {
    const res = await Promise.race([fetch(url, { signal: controller?.signal }), timeout]);
    const text = await Promise.race([res.text(), timeout]);
    if (!res.ok) {
      if (res.status >= 500) {
        throw new AppError('サーバーで一時的なエラーが起きました。', '少し時間をおいて、もう一度お試しください。', `HTTP ${res.status}`);
      }
      throw new AppError('データを読み込めませんでした。',
        '時間をおいてもう一度お試しください。直らない場合は、管理者にお知らせください。',
        `HTTP ${res.status}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new AppError('サーバーから想定外の返事がありました。', '少し時間をおいて、もう一度お試しください。');
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (timedOut) {
      throw new AppError(`${action}に時間がかかっています(10秒以上応答がありません)。`,
        `電波の良い場所で、もう一度お試しください。${IN_APP_HINT}`);
    }
    throw new AppError('サーバーに接続できませんでした。', `ネット接続を確認して、もう一度お試しください。${IN_APP_HINT}`);
  } finally {
    clearTimeout(timer);
  }
}

// 検索用に表記をそろえる。DB の public.kit_search_key(003_kit_corrections.sql)と同じ規則:
//   全角/半角をそろえる(NFKC)→ 英字を小文字に → ひらがなをカタカナに → 中黒(・ ·)と空白を取り除く
// 規則を変えるときは、DB の関数と必ず両方直すこと。
export function toSearchKey(text) {
  return text.normalize('NFKC').toLowerCase()
    .replace(/[ぁ-ゖゝゞ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))
    .replace(/[\s・·]/g, '');
}

// 空白で区切った語に分けてから、それぞれの表記をそろえる
export function toTerms(query) {
  return query.normalize('NFKC').split(/\s+/).map(toSearchKey).filter(Boolean).slice(0, 5);
}

// ilike の値。LIKE の特殊文字(% _ \)はそのままの文字として扱う。
// REST API では * が「何文字でも」になるので、入力の * は「任意の1文字」(_)として扱う
const likeValue = (term) => `ilike.*${term.replace(/[\\%_]/g, (c) => `\\${c}`).replace(/\*/g, '_')}*`;

const KIT_COLUMNS = 'id,name,maker,scale,merged_into';

// キット名か別名に、すべての語を含むキットを探す(search_key で比べるので、
// ひらがな/カタカナ・全角/半角・大文字/小文字・中黒/空白の違いは無視される)。
// 統合済みのキット(merged_into あり)は統合先に置き換える。
export async function searchKits(query) {
  const terms = toTerms(query);
  if (!terms.length) return { kits: [], truncated: false };

  const filters = terms.map((t) => ['search_key', likeValue(t)]);
  const [byName, byAlias] = await Promise.all([
    get('kits', [['select', KIT_COLUMNS], ...filters, ['order', 'name.asc'], ['limit', SEARCH_LIMIT]], '検索'),
    get('kit_aliases', [['select', `alias,kits!inner(${KIT_COLUMNS})`], ...filters, ['limit', SEARCH_LIMIT]], '検索'),
  ]);

  const found = new Map(); // id → { kit, alias }
  const pendingMerged = new Map(); // 統合先 id → 一致した別名
  const add = (kit, alias) => {
    if (kit.merged_into) {
      if (!pendingMerged.has(kit.merged_into)) pendingMerged.set(kit.merged_into, alias);
    } else if (!found.has(kit.id)) {
      found.set(kit.id, { kit, alias });
    }
  };
  for (const kit of byName) add(kit, null);
  for (const row of byAlias) add(row.kits, row.alias);

  const mergedIds = [...pendingMerged.keys()].filter((id) => !found.has(id));
  if (mergedIds.length) {
    const merged = await get('kits', [['select', KIT_COLUMNS], ['id', `in.(${mergedIds.join(',')})`]], '検索');
    for (const kit of merged) add(kit, pendingMerged.get(kit.id));
  }

  const kits = [...found.values()].sort((a, b) => a.kit.name.localeCompare(b.kit.name, 'ja'));
  const truncated = byName.length >= SEARCH_LIMIT || byAlias.length >= SEARCH_LIMIT;
  return { kits: kits.slice(0, SEARCH_LIMIT), truncated };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 1件取得。見つからなければ null
export async function getKit(id) {
  if (!UUID_RE.test(id ?? '')) return null;
  const rows = await get('kits', [['select', KIT_COLUMNS], ['id', `eq.${id}`], ['limit', 1]]);
  return rows[0] ?? null;
}

// エラーを「何が起きたか / どうすれば直るか」に分ける
export function describeError(err) {
  if (err instanceof AppError) return { what: err.what, how: err.how };
  return {
    what: '思わぬエラーが起きました。',
    how: `ページを読み込み直して、もう一度お試しください。${IN_APP_HINT}`,
  };
}
