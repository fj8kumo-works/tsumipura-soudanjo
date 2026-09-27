-- =====================================================================
-- 積みプラ相談所 004: kits.source_ref(HJ の号・ページ)を匿名ユーザーから隠す
--
-- HJ 目次データは公開しない方針のため、公開用のキー(anon / publishable)では
-- kits.source_ref を読めないようにする。画面が使うのは id・名前・メーカー・スケール・
-- 統合先・検索用の列だけ。
--   ・anon の SELECT を「テーブル全体」から「source_ref 以外の列」に変える
--   ・ログインユーザー(authenticated)は今まで通り全列を読める
--     (新規登録は止めてあり、ログインできるのは管理者だけ。管理画面で source_ref を使う想定)
--   ・service_role(取り込み・修正スクリプト)は影響なし
--
-- 注意: 列単位の許可なので、今後 kits に列を足したときは、匿名に見せてよい列なら
--       grant select (その列) on public.kits to anon; を忘れずに行うこと。
--       また anon で select=*(全列)を指定するとエラーになる。画面では必ず列名を指定する。
--
-- 使い方: SQL Editor にまるごと貼って Run(003 の後に1回だけ)。
--   全体を1つのトランザクションにしてあるので、途中で失敗したら何も反映されない。
-- =====================================================================

begin;

revoke select on public.kits from anon;
grant select (id, name, maker, scale, source, merged_into, created_at, search_key)
  on public.kits to anon;

commit;
