-- =====================================================================
-- 積みプラ相談所 005: 予約リマインドアプリの CSV からキットを取り込む準備
--
-- 1. kits.source に 'reminder'(予約リマインドアプリから取り込んだキット)を足す
--      今の値 'hj'(HJ 作例インデックス)・'user'(利用者が画面から追加)はそのまま。
--      既存の行は書き換えない。匿名ユーザーが追加できるのは今まで通り 'user' だけ
-- 2. kits.release_month(発売月)を足す
--      date 型で、その月の1日を入れる(例: 2026年10月 → 2026-10-01)。空でもよい
--      公開してよい情報なので、匿名ユーザーにも読めるようにする(書き込みはできない)
--
-- 取り込みは scripts/reminder_import/import_reminder.mjs(service_role)で行う。
--
-- 使い方: SQL Editor にまるごと貼って Run(004 の後に1回だけ)。
--   全体を1つのトランザクションにしてあるので、途中で失敗したら何も反映されない。
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. source に 'reminder' を足す
--   001 で列に付けた check 制約(名前は自動で kits_source_check)を付け直す
-- ---------------------------------------------------------------------
alter table public.kits drop constraint kits_source_check;
alter table public.kits
  add constraint kits_source_check check (source in ('hj', 'user', 'reminder'));

-- ---------------------------------------------------------------------
-- 2. 発売月
-- ---------------------------------------------------------------------
alter table public.kits
  add column if not exists release_month date
  constraint kits_release_month_first_day
    check (release_month = date_trunc('month', release_month)::date);

-- 004 から kits の SELECT は列単位の許可なので、足した列も明示して許可する
grant select (release_month) on public.kits to anon;
-- authenticated(管理者)は SELECT / UPDATE ともテーブル単位の許可なので追加は不要。
-- anon の INSERT は列単位(name, maker, scale)のままで、release_month は指定できない。

commit;
