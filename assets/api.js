// Supabase からの読み出し(公開用の publishable キーだけを使う)
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';

const SEARCH_LIMIT = 50;

// 管理者用のキーがブラウザに置かれていたら、使わずに止める
function checkKey(key) {
  if (!SUPABASE_URL || !key) {
    throw new Error('assets/config.js に Supabase の URL と publishable キーを入れてください。');
  }
  if (key.startsWith('sb_publishable_')) return;
  if (key.startsWith('sb_secret_')) {
    throw new Error('assets/config.js に secret キーが入っています。すぐに消して、publishable キーに差し替えてください。');
  }
  // 旧形式(JWT)のキーは role が anon のものだけ許す
  try {
    const payload = JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.role === 'anon') return;
    throw new Error(`role=${payload.role}`);
  } catch {
    throw new Error('assets/config.js のキーが publishable キーではありません。service_role キーなどは絶対に置かないでください。');
  }
}

let client;
function db() {
  if (!client) {
    checkKey(SUPABASE_PUBLISHABLE_KEY);
    client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

// 検索用に表記をそろえる。DB の public.kit_search_key(002_kit_search_key.sql)と同じ規則:
//   全角/半角をそろえる(NFKC)→ 英字を小文字に → ひらがなをカタカナに
// 規則を変えるときは、DB の関数と必ず両方直すこと。
export function toSearchKey(text) {
  return text.normalize('NFKC').toLowerCase()
    .replace(/[ぁ-ゖゝゞ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
}

// 表記をそろえて、空白で区切った語に分ける
export function toTerms(query) {
  return toSearchKey(query).split(/\s+/).filter(Boolean).slice(0, 5);
}

// LIKE の特殊文字(% _ \)をそのままの文字として扱う
const likePattern = (term) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const KIT_COLUMNS = 'id, name, maker, scale, merged_into';

// キット名か別名に、すべての語を含むキットを探す(search_key で比べるので、
// ひらがな/カタカナ・全角/半角・大文字/小文字の違いは無視される)。
// 統合済みのキット(merged_into あり)は統合先に置き換える。
export async function searchKits(query) {
  const terms = toTerms(query);
  if (!terms.length) return { kits: [], truncated: false };

  let byName = db().from('kits').select(KIT_COLUMNS);
  let byAlias = db().from('kit_aliases').select(`alias, kits!inner(${KIT_COLUMNS})`);
  for (const t of terms) {
    byName = byName.ilike('search_key', likePattern(t));
    byAlias = byAlias.ilike('search_key', likePattern(t));
  }
  const [nameRes, aliasRes] = await Promise.all([
    byName.order('name').limit(SEARCH_LIMIT),
    byAlias.limit(SEARCH_LIMIT),
  ]);
  if (nameRes.error) throw nameRes.error;
  if (aliasRes.error) throw aliasRes.error;

  const found = new Map(); // id → { kit, alias }
  const pendingMerged = new Map(); // 統合先 id → 一致した別名
  const add = (kit, alias) => {
    if (kit.merged_into) {
      if (!pendingMerged.has(kit.merged_into)) pendingMerged.set(kit.merged_into, alias);
    } else if (!found.has(kit.id)) {
      found.set(kit.id, { kit, alias });
    }
  };
  for (const kit of nameRes.data) add(kit, null);
  for (const row of aliasRes.data) add(row.kits, row.alias);

  const mergedIds = [...pendingMerged.keys()].filter((id) => !found.has(id));
  if (mergedIds.length) {
    const { data, error } = await db().from('kits').select(KIT_COLUMNS).in('id', mergedIds);
    if (error) throw error;
    for (const kit of data) add(kit, pendingMerged.get(kit.id));
  }

  const kits = [...found.values()].sort((a, b) => a.kit.name.localeCompare(b.kit.name, 'ja'));
  const truncated = nameRes.data.length >= SEARCH_LIMIT || aliasRes.data.length >= SEARCH_LIMIT;
  return { kits: kits.slice(0, SEARCH_LIMIT), truncated };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 1件取得。見つからなければ null
export async function getKit(id) {
  if (!UUID_RE.test(id ?? '')) return null;
  const { data, error } = await db().from('kits').select(KIT_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

// 通信エラーなどを利用者向けの文にする
export function errorMessage(err) {
  const msg = err?.message ?? String(err);
  if (/config\.js/.test(msg)) return msg;
  if (/search_key/.test(msg)) {
    return 'データベースの更新が済んでいません。supabase/migrations/002_kit_search_key.sql を SQL Editor で実行してください。';
  }
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
    return 'サーバーに接続できませんでした。ネット接続を確認して、もう一度お試しください。';
  }
  return `読み込みに失敗しました(${msg})`;
}
