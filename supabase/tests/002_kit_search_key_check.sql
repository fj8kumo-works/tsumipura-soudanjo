-- =====================================================================
-- 積みプラ相談所 002_kit_search_key.sql の動作確認
--
-- 使い方: SupabaseのSQL Editorにまるごと貼って Run(002 を適用した後)。
--   ・結果を表示するため、最後にわざとエラーで終了します。
--     エラーメッセージに「OK / NG」の一覧が出ます。テストデータはすべてロールバックされ残りません。
-- =====================================================================
do $test$
declare
  v_kit   uuid;
  v_phase text := '';
  v_sql   text;
  v_got   text;
  v_ok    boolean;
  v_total int := 0;
  v_fail  int := 0;
  v_log   text := '';
  t       record;
begin
  -- ---------- 準備(postgres 権限でテストデータを作る) ----------
  insert into public.kits (name) values ('[テスト]ＳＤ　ふみな１／１４４') returning id into v_kit;
  insert into public.kit_aliases (kit_id, alias) values (v_kit, '[テスト]ﾌﾐﾅ別名');

  for t in
    select * from (values
      -- ===== 変換の規則 =====
      (101, 'postgres', 'ひらがな → カタカナ',
        $q$select public.kit_search_key('あばたーふみな')$q$, 'アバターフミナ'),
      (102, 'postgres', 'カタカナはそのまま',
        $q$select public.kit_search_key('アバターフミナ')$q$, 'アバターフミナ'),
      (103, 'postgres', '全角英字 → 半角小文字',
        $q$select public.kit_search_key('ＦＵＭＩＮＡ Fumina')$q$, 'fumina fumina'),
      (104, 'postgres', '全角数字・記号 → 半角',
        $q$select public.kit_search_key('１／１４４')$q$, '1/144'),
      (105, 'postgres', '半角カナ(濁点つき) → 全角カナ',
        $q$select public.kit_search_key('ｶﾞﾝﾀﾞﾑ')$q$, 'ガンダム'),
      (106, 'postgres', '全角空白 → 半角空白',
        $q$select public.kit_search_key('ＳＤ　ふみな')$q$, 'sd フミナ'),
      (107, 'postgres', 'ゔ・ゝ もカタカナに',
        $q$select public.kit_search_key('ゔぁいえいと ゝ')$q$, 'ヴァイエイト ヽ'),

      -- ===== 生成列 =====
      (201, 'postgres', 'kits.search_key が自動で入る',
        $q$select search_key from public.kits where id = '{kit}'$q$, '[テスト]sd フミナ1/144'),
      (202, 'postgres', 'kit_aliases.search_key が自動で入る',
        $q$select search_key from public.kit_aliases where kit_id = '{kit}'$q$, '[テスト]フミナ別名'),
      (203, 'postgres', '名前を変えると search_key も変わる',
        $q$update public.kits set name = '[テスト]ふみな改' where id = '{kit}'
           returning search_key$q$, '[テスト]フミナ改'),
      (204, 'postgres', 'search_key を直接書き換えることはできない',
        $q$update public.kits set search_key = 'x' where id = '{kit}'$q$, 'error'),
      (205, 'postgres', '取り込み済みの全キットに search_key がある',
        $q$select count(*) from public.kits where search_key is null$q$, '0'),

      -- ===== 匿名ユーザー(公開画面と同じ権限) =====
      (301, 'anon', 'search_key を読める',
        $q$select search_key from public.kits where id = '{kit}'$q$, '[テスト]フミナ改'),
      (302, 'anon', 'ひらがなの検索語でカタカナ名を探せる',
        $q$select count(*) from public.kits
           where id = '{kit}' and search_key ilike '%' || public.kit_search_key('ふみな') || '%'$q$, '1'),
      (303, 'anon', '半角カナの検索語で別名を探せる',
        $q$select count(*) from public.kit_aliases
           where kit_id = '{kit}' and search_key ilike '%' || public.kit_search_key('ﾌﾐﾅ') || '%'$q$, '1'),
      (304, 'anon', 'キットを追加すると search_key も入る',
        $q$with ins as (insert into public.kits (name) values ('[テスト]ＳＤ　くま') returning 1)
           select count(*) from ins$q$, '1'),
      (305, 'anon', 'search_key を指定して追加することはできない',
        $q$insert into public.kits (name, search_key) values ('[テスト]偽キー', 'x')$q$, 'error')
    ) as x(ord, phase, label, sql, expect)
    order by ord
  loop
    -- 立場の切り替え
    if t.phase <> v_phase then
      v_phase := t.phase;
      reset role;
      if v_phase = 'anon' then
        perform set_config('request.jwt.claims', '{"role":"anon"}', true);
        set local role anon;
      end if;
      v_log := v_log || E'\n--- ' || v_phase || ' ---';
    end if;

    v_sql := replace(t.sql, '{kit}', v_kit::text);

    v_total := v_total + 1;
    begin
      if t.expect in ('ok', 'error') then
        execute v_sql;
        v_got := 'ok';
      else
        execute v_sql into v_got;
      end if;
    exception when others then
      v_got := 'error(' || sqlstate || ': ' || sqlerrm || ')';
    end;

    v_ok := coalesce(case when t.expect = 'error' then v_got like 'error%'
                          else v_got = t.expect end, false);
    if not v_ok then
      v_fail := v_fail + 1;
    end if;
    v_log := v_log || E'\n' || case when v_ok then 'OK  ' else 'NG  ' end || t.label
             || case when v_ok then ''
                     else ' (期待: ' || t.expect || ' / 実際: ' || coalesce(v_got, 'null') || ')' end;
  end loop;

  reset role;
  raise notice '%', v_log;
  raise exception using
    message = format(E'テスト結果: %s件中 NG %s件\n'
                     '(結果表示のためわざとエラーで終了しています。テストデータは残りません)%s',
                     v_total, v_fail, v_log);
end;
$test$;
