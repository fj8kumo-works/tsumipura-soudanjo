-- =====================================================================
-- 積みプラ相談所 002: キット検索の表記ゆれ対策
--
-- kits.name / kit_aliases.alias から、検索用の文字列 search_key を自動で作る。
--   ・全角/半角の英数字・記号・カナをそろえる(Unicode NFKC。Ｆ→F、１→1、／→/、ｶﾞ→ガ)
--   ・英字は小文字にそろえる
--   ・ひらがなをカタカナにそろえる(ふみな→フミナ)
-- 画面側(assets/api.js の toSearchKey)も同じ規則で検索語を変換し、search_key を ilike で探す。
-- 規則を変えるときは、この関数と toSearchKey を必ず両方直すこと。
--
-- 使い方: SQL Editor にまるごと貼って Run(001_init.sql の後に1回だけ)。
--   既存の行の search_key も、このとき自動で作られる。
--   全体を1つのトランザクションにしてあるので、途中で失敗したら何も反映されない。
-- =====================================================================

begin;

create function public.kit_search_key(p text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select pg_catalog.translate(
    -- pg_catalog. を付けた普通の関数呼び出しでは、形式は文字列 'NFKC' で渡す
    -- (引用符なしの NFKC は、pg_catalog. を付けない normalize(p, NFKC) の特別な書き方でしか使えない)
    pg_catalog.lower(pg_catalog.normalize(p, 'NFKC')),
    'ぁあぃいぅうぇえぉおかがきぎくぐけげこごさざしじすずせぜそぞただちぢっつづてでとどなにぬねのはばぱひびぴふぶぷへべぺほぼぽまみむめもゃやゅゆょよらりるれろゎわゐゑをんゔゕゖゝゞ',
    'ァアィイゥウェエォオカガキギクグケゲコゴサザシジスズセゼソゾタダチヂッツヅテデトドナニヌネノハバパヒビピフブプヘベペホボポマミムメモャヤュユョヨラリルレロヮワヰヱヲンヴヵヶヽヾ'
  )
$$;

-- 生成列なので、追加・更新のたびに自動で計算される(利用者や管理者が直接書くことはできない)
alter table public.kits
  add column search_key text generated always as (public.kit_search_key(name)) stored;
alter table public.kit_aliases
  add column search_key text generated always as (public.kit_search_key(alias)) stored;

-- 匿名ユーザーのキット追加でも計算されるよう、実行権限を明示しておく(中身は文字の変換だけ)
grant execute on function public.kit_search_key(text) to anon, authenticated;

-- kits / kit_aliases の SELECT はテーブル単位で許可済みなので、search_key も読める。
-- INSERT は列単位(name, maker, scale)のままで、search_key は指定できない。

commit;
