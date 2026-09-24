-- =====================================================================
-- 積みプラ相談所 001_init.sql
--   テーブル / RLS / 押下記録関数 / 集計 / Storage の初期設定
--
-- 前提:
--   - 利用者はログインなし(anon ロール)。管理者だけ Supabase Auth でログイン(authenticated ロール)
--   - 接続キーはブラウザから見えるため、守りはすべて GRANT(列単位)+ RLS + DB関数で行う
--   - 新しいプロジェクトに1回だけ実行する想定(再実行すると create table で失敗します)
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. テーブル
-- ---------------------------------------------------------------------

-- キット
create table public.kits (
  id          uuid primary key default gen_random_uuid(),
  name        text not null
              check (char_length(btrim(name)) >= 1 and char_length(name) <= 100),
  maker       text check (char_length(maker) <= 50),
  scale       text check (char_length(scale) <= 20),
  source      text not null default 'user' check (source in ('hj', 'user')),
  source_ref  text check (char_length(source_ref) <= 200),
  merged_into uuid references public.kits (id),
  created_at  timestamptz not null default now(),
  check (merged_into is null or merged_into <> id)
);
create index kits_merged_into_idx on public.kits (merged_into);

-- キットの別名(検索用)
create table public.kit_aliases (
  id     uuid primary key default gen_random_uuid(),
  kit_id uuid not null references public.kits (id),
  alias  text not null
         check (char_length(btrim(alias)) >= 1 and char_length(alias) <= 100),
  unique (kit_id, alias)
);

-- レビュー
create table public.reviews (
  id         uuid primary key default gen_random_uuid(),
  kit_id     uuid not null references public.kits (id),
  nickname   text not null
             check (char_length(btrim(nickname)) >= 1 and char_length(nickname) <= 30),
  body       text not null
             check (char_length(btrim(body)) >= 1 and char_length(body) <= 2000),
  x_url      text
             check (char_length(x_url) <= 300
                    and x_url ~ '^https://(www\.)?(x|twitter)\.com/'),
  device_id  text not null check (char_length(device_id) between 8 and 64),
  user_id    uuid,  -- 将来のログイン導入用。MVPでは常に null
  status     text not null default 'visible' check (status in ('visible', 'hidden')),
  created_at timestamptz not null default now()
);
create index reviews_kit_id_created_at_idx on public.reviews (kit_id, created_at desc);

-- レビュー画像(1レビュー3枚まで。sort_order 1〜3 の一意制約で担保)
--   storage_path はバケット内のパス。形式: <review_id>/<sort_order>.<jpg|jpeg|png|webp>
create table public.review_images (
  id           uuid primary key default gen_random_uuid(),
  review_id    uuid not null references public.reviews (id),
  storage_path text not null,
  sort_order   integer not null check (sort_order between 1 and 3),
  unique (review_id, sort_order),
  check (storage_path ~ ('^' || review_id::text || '/' || sort_order::text
                         || '\.(jpg|jpeg|png|webp)$'))
);

-- 押下記録(積んでる / 作った)
create table public.actions (
  id         uuid primary key default gen_random_uuid(),
  kit_id     uuid not null references public.kits (id),
  type       text not null check (type in ('stash', 'built')),
  device_id  text not null check (char_length(device_id) between 8 and 64),
  user_id    uuid,  -- 将来のログイン導入用。MVPでは常に null
  status     text not null default 'active' check (status in ('active', 'pending', 'rejected')),
  created_at timestamptz not null default now()
);
-- 同じ端末・キット・種類の有効な記録(active / pending)は1件だけ
create unique index actions_one_live_per_device_idx
  on public.actions (kit_id, type, device_id)
  where status in ('active', 'pending');
create index actions_device_created_idx on public.actions (device_id, created_at);
create index actions_kit_created_idx    on public.actions (kit_id, created_at);
create index actions_status_idx         on public.actions (status);

-- 削除依頼
create table public.deletion_requests (
  id         uuid primary key default gen_random_uuid(),
  review_id  uuid not null references public.reviews (id),
  reason     text not null check (reason in ('withdraw', 'copyright', 'inappropriate')),
  status     text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  handled_at timestamptz
);
create index deletion_requests_status_idx on public.deletion_requests (status, created_at);

-- 管理者(ここに登録されたユーザーだけを管理者とみなす)
create table public.admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- 設定値(しきい値など。管理者が後から変更できる)
create table public.settings (
  key         text primary key,
  value       integer not null check (value >= 0),
  description text,
  updated_at  timestamptz not null default now()
);

insert into public.settings (key, value, description) values
  ('action_device_hourly_limit', 10, '同じ端末から直近1時間の押下がこの件数を超えたら pending'),
  ('action_kit_hourly_limit',    20, '同じキットへの直近1時間の押下がこの件数を超えたら pending'),
  ('review_image_upload_minutes', 30, 'レビュー投稿後、この分数以内なら画像を追加できる');


-- ---------------------------------------------------------------------
-- 2. トリガー
-- ---------------------------------------------------------------------

-- settings.updated_at
create function public.settings_touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
create trigger settings_touch_updated_at
  before update on public.settings
  for each row execute function public.settings_touch_updated_at();

-- deletion_requests.handled_at を status 変更時に自動で入れる
create function public.deletion_requests_set_handled_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status is distinct from old.status then
    new.handled_at := case when new.status = 'pending' then null else now() end;
  end if;
  return new;
end;
$$;
create trigger deletion_requests_set_handled_at
  before update on public.deletion_requests
  for each row execute function public.deletion_requests_set_handled_at();

-- キット統合: 統合は常に1段にする(A→B→C のような連鎖を作らない)
create function public.kits_check_merge()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.merged_into is not null and new.merged_into is distinct from old.merged_into then
    if exists (select 1 from public.kits k
               where k.id = new.merged_into and k.merged_into is not null) then
      raise exception '統合先のキットはすでに別のキットに統合されています。最終的な統合先を指定してください';
    end if;
  end if;
  return new;
end;
$$;
create trigger kits_check_merge
  before update of merged_into on public.kits
  for each row execute function public.kits_check_merge();

-- このキットに統合されていたキットも、新しい統合先へ付け替える
create function public.kits_repoint_merged()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.merged_into is not null and new.merged_into is distinct from old.merged_into then
    update public.kits set merged_into = new.merged_into where merged_into = new.id;
  end if;
  return null;
end;
$$;
create trigger kits_repoint_merged
  after update of merged_into on public.kits
  for each row execute function public.kits_repoint_merged();


-- ---------------------------------------------------------------------
-- 3. 補助関数
-- ---------------------------------------------------------------------

-- ログイン中のユーザーが管理者か
create function public.is_admin()
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid());
$$;

-- このレビューに画像を追加してよいか(表示中 かつ 投稿直後)
create function public.review_accepts_images(p_review_id uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.reviews r
    where r.id = p_review_id
      and r.status = 'visible'
      and r.created_at > now() - make_interval(mins => coalesce(
            (select s.value from public.settings s where s.key = 'review_image_upload_minutes'), 30))
  );
$$;

-- Storage へのアップロードを許可するか
--   パス形式: <review_id>/<1〜3>.<jpg|jpeg|png|webp>
--   対象レビューが画像を受け付けていて、同じフォルダのファイルが3つ未満なら許可
create function public.can_upload_review_image(p_name text)
returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_folder text;
begin
  if p_name is null or p_name !~
     '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[1-3]\.(jpg|jpeg|png|webp)$' then
    return false;
  end if;
  v_folder := split_part(p_name, '/', 1);
  if not public.review_accepts_images(v_folder::uuid) then
    return false;
  end if;
  return (select count(*) from storage.objects o
          where o.bucket_id = 'review-images' and o.name like v_folder || '/%') < 3;
end;
$$;


-- ---------------------------------------------------------------------
-- 4. 押下記録関数 record_action
--   戻り値: 'active' | 'pending' | 'duplicate'(既に有効な記録があり、記録しなかった)
-- ---------------------------------------------------------------------
create function public.record_action(p_kit_id uuid, p_type text, p_device_id text)
returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_kit_id       uuid;
  v_device_limit integer;
  v_kit_limit    integer;
  v_device_count integer;
  v_kit_count    integer;
  v_status       text;
  v_rows         integer;
begin
  if p_type is null or p_type not in ('stash', 'built') then
    raise exception 'type は stash か built を指定してください' using errcode = '22023';
  end if;
  if p_device_id is null or char_length(p_device_id) not between 8 and 64 then
    raise exception 'device_id が不正です' using errcode = '22023';
  end if;

  -- 統合済みキットへの押下は統合先に記録する
  select coalesce(k.merged_into, k.id) into v_kit_id
  from public.kits k where k.id = p_kit_id;
  if not found then
    raise exception 'キットが見つかりません' using errcode = 'P0002';
  end if;

  -- 同じ端末からの同時押下で件数判定がずれないよう、端末単位で直列化
  perform pg_advisory_xact_lock(hashtextextended('record_action:' || p_device_id, 0));

  -- 既に有効な記録(active / pending)があれば記録しない
  if exists (select 1 from public.actions a
             where a.kit_id = v_kit_id and a.type = p_type and a.device_id = p_device_id
               and a.status in ('active', 'pending')) then
    return 'duplicate';
  end if;

  select coalesce((select s.value from public.settings s where s.key = 'action_device_hourly_limit'), 10),
         coalesce((select s.value from public.settings s where s.key = 'action_kit_hourly_limit'), 20)
    into v_device_limit, v_kit_limit;

  select count(*) into v_device_count from public.actions a
  where a.device_id = p_device_id and a.created_at > now() - interval '1 hour';

  select count(*) into v_kit_count from public.actions a
  where a.kit_id = v_kit_id and a.created_at > now() - interval '1 hour';

  -- 今回の押下を含めた件数がしきい値を超えたら pending
  if v_device_count + 1 > v_device_limit or v_kit_count + 1 > v_kit_limit then
    v_status := 'pending';
  else
    v_status := 'active';
  end if;

  insert into public.actions (kit_id, type, device_id, status)
  values (v_kit_id, p_type, p_device_id, v_status)
  on conflict (kit_id, type, device_id) where status in ('active', 'pending') do nothing;

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return 'duplicate';
  end if;
  return v_status;
end;
$$;


-- ---------------------------------------------------------------------
-- 5. 集計
-- ---------------------------------------------------------------------

-- キットごとの人数(active のみ・端末の重複なし)。統合済みキットは統合先に合算し、一覧には出さない。
-- 「今月」は日本時間の月初から。
-- ※ このビューは所有者(postgres)の権限で actions を読む(security_invoker を付けない)。
--    匿名ユーザーは actions を直接読めないが、device_id を含まない集計結果だけを読める。
create view public.kit_stats as
with month_start as (
  select (date_trunc('month', now() at time zone 'Asia/Tokyo') at time zone 'Asia/Tokyo') as ts
),
live as (
  select coalesce(k.merged_into, k.id) as kit_id, a.type, a.device_id, a.created_at
  from public.actions a
  join public.kits k on k.id = a.kit_id
  where a.status = 'active'
)
select
  k.id    as kit_id,
  k.name,
  k.maker,
  k.scale,
  count(distinct l.device_id) filter (where l.type = 'stash')                       as stash_count,
  count(distinct l.device_id) filter (where l.type = 'built')                       as built_count,
  count(distinct l.device_id) filter (where l.type = 'stash' and l.created_at >= m.ts) as stash_count_month,
  count(distinct l.device_id) filter (where l.type = 'built' and l.created_at >= m.ts) as built_count_month
from public.kits k
cross join month_start m
left join live l on l.kit_id = k.id
where k.merged_into is null
group by k.id, k.name, k.maker, k.scale, m.ts;

-- ランキング
--   p_type: 'stash'(積みプラ) | 'built'(作った)
--   p_period: 'all'(累計) | 'month'(今月・日本時間)
--   0人のキットは出さない。不正な引数なら空。最大100件。
create function public.get_ranking(p_type text, p_period text default 'all', p_limit integer default 20)
returns table (rank_no bigint, kit_id uuid, name text, maker text, scale text, people bigint)
language sql stable set search_path = '' as $$
  select rank() over (order by s.c desc), s.kit_id, s.name, s.maker, s.scale, s.c
  from (
    select ks.kit_id, ks.name, ks.maker, ks.scale,
           case
             when p_type = 'stash' and p_period = 'all'   then ks.stash_count
             when p_type = 'stash' and p_period = 'month' then ks.stash_count_month
             when p_type = 'built' and p_period = 'all'   then ks.built_count
             when p_type = 'built' and p_period = 'month' then ks.built_count_month
           end as c
    from public.kit_stats ks
  ) s
  where s.c > 0
  order by s.c desc, s.name
  limit least(greatest(coalesce(p_limit, 20), 1), 100);
$$;


-- ---------------------------------------------------------------------
-- 6. 権限(GRANT)
--   Supabase は新しいテーブルに anon / authenticated へ全権限を自動で付けるので、
--   いったん全部外してから必要な分だけ付け直す。
--   INSERT は列単位で許可し、status / created_at / user_id などは匿名では指定できないようにする。
-- ---------------------------------------------------------------------
revoke all on
  public.kits, public.kit_aliases, public.reviews, public.review_images,
  public.actions, public.deletion_requests, public.admins, public.settings,
  public.kit_stats
from anon, authenticated;

-- 公開(匿名・ログイン共通)
grant select                          on public.kits          to anon, authenticated;
grant insert (name, maker, scale)     on public.kits          to anon, authenticated;
grant select                          on public.kit_aliases   to anon, authenticated;
-- reviews は device_id / user_id を匿名に見せない(列単位で許可)
grant select (id, kit_id, nickname, body, x_url, status, created_at)
                                      on public.reviews       to anon;
grant insert (kit_id, nickname, body, x_url, device_id)
                                      on public.reviews       to anon, authenticated;
grant select                          on public.review_images to anon, authenticated;
grant insert (review_id, storage_path, sort_order)
                                      on public.review_images to anon, authenticated;
grant insert (review_id, reason)      on public.deletion_requests to anon, authenticated;
grant select                          on public.kit_stats     to anon, authenticated;

-- 管理者用(authenticated に付けるが、行は RLS で is_admin() の人にしか見えない・更新できない)
grant select, update on
  public.kits, public.kit_aliases, public.reviews, public.review_images,
  public.actions, public.deletion_requests, public.settings
to authenticated;
grant select on public.admins to authenticated;  -- 管理者の追加は SQL Editor で行う

-- 関数の実行権限
revoke execute on function
  public.is_admin(),
  public.review_accepts_images(uuid),
  public.can_upload_review_image(text),
  public.record_action(uuid, text, text),
  public.get_ranking(text, text, integer),
  public.settings_touch_updated_at(),
  public.deletion_requests_set_handled_at(),
  public.kits_check_merge(),
  public.kits_repoint_merged()
from public, anon, authenticated;

grant execute on function public.is_admin()                          to authenticated;
grant execute on function public.review_accepts_images(uuid)         to anon, authenticated;
grant execute on function public.can_upload_review_image(text)       to anon, authenticated;
grant execute on function public.record_action(uuid, text, text)     to anon, authenticated;
grant execute on function public.get_ranking(text, text, integer)    to anon, authenticated;


-- ---------------------------------------------------------------------
-- 7. RLS
-- ---------------------------------------------------------------------
alter table public.kits              enable row level security;
alter table public.kit_aliases       enable row level security;
alter table public.reviews           enable row level security;
alter table public.review_images     enable row level security;
alter table public.actions           enable row level security;
alter table public.deletion_requests enable row level security;
alter table public.admins            enable row level security;
alter table public.settings          enable row level security;

-- kits
create policy "kits: 誰でも閲覧" on public.kits
  for select to anon, authenticated using (true);
create policy "kits: 誰でも追加(ユーザー登録分のみ)" on public.kits
  for insert to anon, authenticated
  with check (source = 'user' and source_ref is null and merged_into is null);
create policy "kits: 管理者が更新" on public.kits
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- kit_aliases
create policy "kit_aliases: 誰でも閲覧" on public.kit_aliases
  for select to anon, authenticated using (true);
create policy "kit_aliases: 管理者が更新" on public.kit_aliases
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- reviews
create policy "reviews: 表示中のみ閲覧" on public.reviews
  for select to anon, authenticated using (status = 'visible');
create policy "reviews: 管理者は全件閲覧" on public.reviews
  for select to authenticated using (public.is_admin());
create policy "reviews: 誰でも投稿(表示中として)" on public.reviews
  for insert to anon, authenticated
  with check (status = 'visible' and user_id is null);
create policy "reviews: 管理者が更新" on public.reviews
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- review_images
create policy "review_images: 表示中レビューの画像のみ閲覧" on public.review_images
  for select to anon, authenticated
  using (exists (select 1 from public.reviews r
                 where r.id = review_images.review_id and r.status = 'visible'));
create policy "review_images: 管理者は全件閲覧" on public.review_images
  for select to authenticated using (public.is_admin());
create policy "review_images: 投稿直後のレビューに追加" on public.review_images
  for insert to anon, authenticated
  with check (public.review_accepts_images(review_id));
create policy "review_images: 管理者が更新" on public.review_images
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- actions(匿名は直接触れない。record_action 経由のみ)
create policy "actions: 管理者が閲覧" on public.actions
  for select to authenticated using (public.is_admin());
create policy "actions: 管理者が更新" on public.actions
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- deletion_requests
create policy "deletion_requests: 誰でも追加" on public.deletion_requests
  for insert to anon, authenticated
  with check (status = 'pending' and handled_at is null);
create policy "deletion_requests: 管理者が閲覧" on public.deletion_requests
  for select to authenticated using (public.is_admin());
create policy "deletion_requests: 管理者が更新" on public.deletion_requests
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- admins
create policy "admins: 管理者が閲覧" on public.admins
  for select to authenticated using (public.is_admin());

-- settings
create policy "settings: 管理者が閲覧" on public.settings
  for select to authenticated using (public.is_admin());
create policy "settings: 管理者が更新" on public.settings
  for update to authenticated using (public.is_admin()) with check (public.is_admin());


-- ---------------------------------------------------------------------
-- 8. Storage(バケット review-images)
--   公開バケットなので閲覧は公開URLで誰でも可能(select ポリシー不要)。
--   ファイルサイズ 2MB・MIME タイプはバケット設定で制限する。
--   update ポリシーは作らない = 上書き(upsert)不可。
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('review-images', 'review-images', true, 2097152,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy "review-images: 投稿直後のレビューに匿名アップロード" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'review-images' and public.can_upload_review_image(name));

create policy "review-images: 管理者が一覧" on storage.objects
  for select to authenticated
  using (bucket_id = 'review-images' and public.is_admin());

-- 著作権侵害などでファイル自体を消す必要があるときのため、管理者のみ削除可
create policy "review-images: 管理者が削除" on storage.objects
  for delete to authenticated
  using (bucket_id = 'review-images' and public.is_admin());
