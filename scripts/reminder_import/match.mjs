// 予約リマインドアプリの CSV と DB の kits を突き合わせる規則(正規化と判定)
//
// import_reminder.mjs から使う。DB やファイルには触らないので、単体でテストできる
// (テスト: node --test scripts/reminder_import/)。
//
// 判定
//   重複   : 名前・メーカー・スケールが、正規化するとすべて一致するキットが DB にある
//            (DB の別名や、統合済みキットの名前とも比べる)。CSV の中で2回目以降に出た行も重複
//   要確認 : メーカーが空 / 名前は同じでメーカーかスケールが違う / 名前が似ている
//   新規   : どれでもない

import crypto from 'node:crypto';

// id 用の固定名前空間(変えると取り込むキットの id が変わるので変更しないこと)
const ID_NAMESPACE = '8d2c5f4a-1b7e-4e39-a6d0-3c9e2b71f5a4';

// 「名前が似ている」とみなす文字の2つ組(bigram)の一致度
export const SIMILAR_THRESHOLD = 0.8;
// 「片方の名前がもう片方に含まれる」を似ているとみなす、短いほうの最低文字数
const CONTAIN_MIN_LENGTH = 3;

const HIRAGANA = /[ぁ-ゖ]/g;

// ---------------------------------------------------------------- スケール

// 「1/24」「1:24」「1／24」「１：２４」「1/24スケール」「1 / 24」→「1/24」
const SCALE_IN_TEXT = /(?<![0-9.])1\s*[/:]\s*0*([1-9][0-9]{0,3})(?![0-9])(?:\s*(?:スケール|scale))?/i;

export function normalizeScale(s) {
  const t = (s ?? '').normalize('NFKC').trim();
  if (!t) return '';
  const m = t.match(new RegExp(`^${SCALE_IN_TEXT.source}$`, 'i'));
  return m ? `1/${m[1]}` : t.replace(/\s/g, '');
}

// キット名に書かれたスケールを取り出す。{ name: スケールを除いた名前, scale: '1/24' など(なければ '') }
export function splitScale(name) {
  const n = (name ?? '').normalize('NFKC');
  const m = n.match(SCALE_IN_TEXT);
  if (!m) return { name: n.replace(/\s+/g, ' ').trim(), scale: '' };
  const rest = (n.slice(0, m.index) + ' ' + n.slice(m.index + m[0].length))
    .replace(/[(\[]\s*[)\]]/g, '')   // 「(1/24)」のかっこだけが残ったもの
    .replace(/\s+/g, ' ')
    .trim();
  return rest ? { name: rest, scale: `1/${m[1]}` } : { name: n.trim(), scale: `1/${m[1]}` };
}

// ---------------------------------------------------------------- 名前・メーカー

// 照合用の名前。表示には使わない。
//   全角/半角・大文字/小文字・ひらがな/カタカナをそろえ、空白・中黒・記号のゆれをなくす
export function normalizeName(s) {
  return (s ?? '').normalize('NFKC')
    .toLowerCase()
    .replace(HIRAGANA, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/[【\[]/g, '(').replace(/[】\]]/g, ')')
    .replace(/[〜~]/g, '~')
    .replace(/["'“”‘’「」『』]/g, '')
    .replace(/[\s・·=.]/g, '');
}

// maker_aliases.csv の行({ 表記, 統一名 })から、メーカー名をそろえる関数を作る
export function makerUnifier(aliasRows = []) {
  const clean = (s) => (s ?? '').normalize('NFKC').replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ').trim();
  const map = new Map();
  for (const r of aliasRows) {
    if (r['表記'] && r['統一名']) map.set(clean(r['表記']), clean(r['統一名']));
  }
  return (s) => {
    const m = clean(s);
    return map.get(m) ?? m;
  };
}

// ---------------------------------------------------------------- 似ている度合い

function bigrams(s) {
  const out = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const b = s.slice(i, i + 2);
    out.set(b, (out.get(b) ?? 0) + 1);
  }
  return out;
}

// 0〜1。1 なら同じ
export function similarity(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const x = bigrams(a), y = bigrams(b);
  let hit = 0;
  for (const [k, n] of x) hit += Math.min(n, y.get(k) ?? 0);
  return (2 * hit) / (a.length - 1 + b.length - 1);
}

function contains(a, b) {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= CONTAIN_MIN_LENGTH && long.includes(short);
}

// ---------------------------------------------------------------- id

export function uuidV5(name, namespace = ID_NAMESPACE) {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = crypto.createHash('sha1').update(Buffer.concat([ns, Buffer.from(name, 'utf8')])).digest();
  const b = hash.subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---------------------------------------------------------------- 判定

// CSV の1行を、登録する形と照合キーにする
//   row: { kit_name, maker, release_month }
export function prepareRow(row, unifyMaker) {
  const { name, scale } = splitScale(row.kit_name);
  const maker = unifyMaker((row.maker ?? '').trim());
  const nameKey = normalizeName(name);
  const makerKey = normalizeName(maker);
  return {
    name, maker, scale,
    nameKey, makerKey,
    key: [nameKey, makerKey, scale].join('|'),
  };
}

// DB のキットを照合しやすい形にする
//   kits   : [{ id, name, maker, scale, release_month, merged_into }]
//   aliases: [{ kit_id, alias }]
// 統合済みキットの名前・別名は統合先の名前として扱う
export function indexKits(kits, aliases, unifyMaker) {
  const byId = new Map(kits.map((k) => [k.id, k]));
  const entries = new Map();   // 統合先の id → { kit, makerKey, scale, names: Set<nameKey> }
  const target = (k) => (k.merged_into && byId.has(k.merged_into) ? byId.get(k.merged_into) : k);
  const entryOf = (k) => {
    const t = target(k);
    if (!entries.has(t.id)) {
      const own = splitScale(t.name);
      entries.set(t.id, {
        kit: t,
        makerKey: normalizeName(unifyMaker(t.maker ?? '')),
        scale: normalizeScale(t.scale) || own.scale,
        names: new Set(),
      });
    }
    return entries.get(t.id);
  };
  const addName = (k, name) => {
    const n = normalizeName(splitScale(name).name);
    if (n) entryOf(k).names.add(n);
  };
  for (const k of kits) addName(k, k.name);
  for (const a of aliases) if (byId.has(a.kit_id)) addName(byId.get(a.kit_id), a.alias);
  return [...entries.values()];
}

const describe = (e) => ({
  id: e.kit.id, name: e.kit.name, maker: e.kit.maker ?? '', scale: e.kit.scale ?? '',
  release_month: e.kit.release_month ?? null,
});

// CSV の行(prepareRow 済み)を1つずつ判定する
//   戻り値: [{ ...行, status: '新規'|'重複'|'要確認', reason, match, candidates }]
export function classify(prepared, index) {
  const seen = new Map();   // 照合キー → CSV の何番目か
  return prepared.map((r, i) => {
    const out = { ...r, status: '新規', reason: '', match: null, candidates: [] };

    if (seen.has(r.key)) {
      const j = seen.get(r.key);
      const where = prepared[j].line ? `${prepared[j].line} 行目` : `${j + 1} 件目`;
      return { ...out, status: '重複', reason: `CSV の ${where}と同じ` };
    }
    seen.set(r.key, i);

    const exact = [], sameName = [], similar = [];
    for (const e of index) {
      const nameHit = e.names.has(r.nameKey);
      if (nameHit && e.makerKey === r.makerKey && e.scale === r.scale) {
        exact.push(e);
        continue;
      }
      if (nameHit) {
        sameName.push(e);
        continue;
      }
      // 名前が似ているかは、メーカーが同じか、どちらかのメーカーが空のときだけ見る
      if (r.makerKey && e.makerKey && e.makerKey !== r.makerKey) continue;
      let best = 0;
      for (const n of e.names) {
        const s = contains(n, r.nameKey) ? 0.99 : similarity(n, r.nameKey);
        if (s > best) best = s;
      }
      if (best >= SIMILAR_THRESHOLD) similar.push({ e, score: best });
    }
    similar.sort((a, b) => b.score - a.score);
    const candidates = [...exact, ...sameName, ...similar.map((s) => s.e)].slice(0, 3).map(describe);

    if (!r.makerKey) {
      return { ...out, status: '要確認', reason: 'メーカーが空', candidates };
    }
    if (exact.length) {
      return { ...out, status: '重複', reason: exact.length > 1 ? `一致するキットが ${exact.length} 件` : '',
               match: describe(exact[0]), candidates };
    }
    if (sameName.length) {
      return { ...out, status: '要確認', reason: '名前は同じでメーカーかスケールが違う', candidates };
    }
    if (similar.length) {
      return { ...out, status: '要確認', reason: '名前が似ている', candidates };
    }
    return out;
  });
}

// 登録するキットの id。同じ照合キーなら毎回同じ id になる(再実行しても二重に登録されない)
export const kitIdFor = (key) => uuidV5(`reminder:${key}`);

// "2026-10" → "2026-10-01"。空なら null。形式が違えば undefined
export function parseReleaseMonth(s) {
  const t = (s ?? '').normalize('NFKC').trim();
  if (!t) return null;
  const m = t.match(/^(\d{4})-(\d{1,2})$/);
  if (!m || +m[2] < 1 || +m[2] > 12) return undefined;
  return `${m[1]}-${m[2].padStart(2, '0')}-01`;
}
