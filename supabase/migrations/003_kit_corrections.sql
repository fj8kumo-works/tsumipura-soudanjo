-- =====================================================================
-- 積みプラ相談所 003: 検索で中黒・空白を無視 / キットの修正・統合用の関数
--
-- 1. search_key の規則に「中黒(・)と空白を取り除く」を足す
--      「ガンダムエアリアル」でも「ガンダム・エアリアル」でもヒットするように
--    画面側(assets/api.js の toSearchKey)も同じ規則にしてある。変えるときは両方直すこと。
-- 2. admin_apply_kit_correction: キット1件の「名前の修正」と「統合」を1回でまとめて行う
--      scripts/admin/apply_kit_corrections.mjs から service_role で呼ぶ(管理画面ができるまでのつなぎ)
--
-- 使い方: SQL Editor にまるごと貼って Run(002 の後に1回だけ)。
--   全体を1つのトランザクションにしてあるので、途中で失敗したら何も反映されない。
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. search_key の規則を変える
--   生成列は関数を差し替えただけでは既存の行が再計算されないので、
--   いったん列を外し、関数を差し替えてから付け直す(付け直したときに全行計算される)
-- ---------------------------------------------------------------------
alter table public.kits        drop column search_key;
alter table public.kit_aliases drop column search_key;

create or replace function public.kit_search_key(p text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select pg_catalog.regexp_replace(
    pg_catalog.translate(
      -- pg_catalog. を付けた普通の関数呼び出しでは、形式は文字列 'NFKC' で渡す
      pg_catalog.lower(pg_catalog.normalize(p, 'NFKC')),
      'ぁあぃいぅうぇえぉおかがきぎくぐけげこごさざしじすずせぜそぞただちぢっつづてでとどなにぬねのはばぱひびぴふぶぷへべぺほぼぽまみむめもゃやゅゆょよらりるれろゎわゐゑをんゔゕゖゝゞ',
      'ァアィイゥウェエォオカガキギクグケゲコゴサザシジスズセゼソゾタダチヂッツヅテデトドナニヌネノハバパヒビピフブプヘベペホボポマミムメモャヤュユョヨラリルレロヮワヰヱヲンヴヵヶヽヾ'
    ),
    -- 中黒(・ と ·)と空白を取り除く(全角空白・半角中黒は NFKC で ・ / 半角空白になっている)
    '[[:space:]・·]', '', 'g'
  )
$$;

alter table public.kits
  add column search_key text generated always as (public.kit_search_key(name)) stored;
alter table public.kit_aliases
  add column search_key text generated always as (public.kit_search_key(alias)) stored;

grant execute on function public.kit_search_key(text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. キットの修正・統合
--   p_kit_id       : 直すキット
--   p_current_name : CSV に書いた「今の名前」。DB と違えば止める(古い CSV で上書きしないため)
--   p_new_name     : 新しい名前(null なら名前は変えない)
--   p_merge_into   : 統合先のキット(null なら統合しない)
--
--   名前の修正: 変更前の名前を別名に残してから名前を変える
--   統合      : merged_into を設定し(統合先の統合先は付け替え済みのトリガーが処理)、
--               統合元の名前・別名を統合先の別名にコピーし、レビューと押下記録を統合先へ付け替える。
--               押下記録は「同じ端末・キット・種類の有効な記録は1件」の決まりがあるので、
--               統合先に同じ端末の有効な記録があるものは統合元に残す
--               (kit_stats は統合元の記録も統合先に合算するので、人数は変わらない)
--   すでに反映済みの内容は何もしない(何度呼んでも同じ結果)
-- ---------------------------------------------------------------------
create function public.admin_apply_kit_correction(
  p_kit_id       uuid,
  p_current_name text,
  p_new_name     text default null,
  p_merge_into   uuid default null
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  k          public.kits;
  t          public.kits;
  v_new_name text := nullif(btrim(coalesce(p_new_name, '')), '');
  v_result   jsonb := jsonb_build_object('kit_id', p_kit_id);
  n          integer;
begin
  select * into k from public.kits where id = p_kit_id for update;
  if not found then
    raise exception 'キット % が見つかりません。キットidが正しいか確認してください', p_kit_id;
  end if;

  -- ----- 名前の修正 -----
  if v_new_name is not null and k.name <> v_new_name then
    if p_current_name is not null and k.name <> p_current_name then
      raise exception 'キット % の今の名前が CSV と違います(DB:「%」/ CSV:「%」)。CSV の「今の名前」を DB に合わせてから、もう一度実行してください',
        p_kit_id, k.name, p_current_name;
    end if;
    insert into public.kit_aliases (kit_id, alias) values (k.id, k.name)
      on conflict (kit_id, alias) do nothing;
    delete from public.kit_aliases where kit_id = k.id and alias = v_new_name;
    update public.kits set name = v_new_name where id = k.id;
    v_result := v_result || jsonb_build_object('renamed_from', k.name, 'renamed_to', v_new_name);
    k.name := v_new_name;
  end if;

  -- ----- 統合 -----
  if p_merge_into is not null and k.merged_into is distinct from p_merge_into then
    if p_merge_into = k.id then
      raise exception 'キット % の統合先が自分自身になっています。統合先のキットidを見直してください', k.id;
    end if;
    if k.merged_into is not null then
      raise exception 'キット % はすでに別のキット % に統合されています。統合先を変えるときは管理者に相談してください',
        k.id, k.merged_into;
    end if;
    select * into t from public.kits where id = p_merge_into for update;
    if not found then
      raise exception '統合先のキット % が見つかりません。統合先のキットidが正しいか確認してください', p_merge_into;
    end if;
    if t.merged_into is not null then
      raise exception '統合先のキット % はすでに別のキット % に統合されています。統合先には % を指定してください',
        t.id, t.merged_into, t.merged_into;
    end if;

    update public.kits set merged_into = t.id where id = k.id;

    -- 統合元の名前と別名で検索しても、統合先が出るようにする
    insert into public.kit_aliases (kit_id, alias)
      select t.id, x.alias
      from (select k.name as alias
            union
            select a.alias from public.kit_aliases a where a.kit_id = k.id) x
      where x.alias <> t.name
      on conflict (kit_id, alias) do nothing;

    update public.reviews set kit_id = t.id where kit_id = k.id;
    get diagnostics n = row_count;
    v_result := v_result || jsonb_build_object('merged_into', t.id, 'reviews_moved', n);

    update public.actions a set kit_id = t.id
    where a.kit_id = k.id
      and not (a.status in ('active', 'pending') and exists (
        select 1 from public.actions b
        where b.kit_id = t.id and b.type = a.type and b.device_id = a.device_id
          and b.status in ('active', 'pending')));
    get diagnostics n = row_count;
    v_result := v_result || jsonb_build_object('actions_moved', n,
      'actions_left', (select count(*) from public.actions where kit_id = k.id));
  end if;

  return v_result;
end;
$$;

-- service_role(取り込み・修正スクリプト)だけが呼べる
revoke execute on function public.admin_apply_kit_correction(uuid, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_apply_kit_correction(uuid, text, text, uuid) to service_role;

commit;
