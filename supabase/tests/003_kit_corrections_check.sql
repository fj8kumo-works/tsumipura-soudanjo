-- =====================================================================
-- 積みプラ相談所 003_kit_corrections.sql の動作確認
--
-- 使い方: SupabaseのSQL Editorにまるごと貼って Run(003 を適用した後)。
--   ・結果を表示するため、最後にわざとエラーで終了します。
--     エラーメッセージに「OK / NG」の一覧が出ます。テストデータはすべてロールバックされ残りません。
-- =====================================================================
do $test$
declare
  v_a     uuid;
  v_b     uuid;
  v_c     uuid;
  v_d     uuid;
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
  insert into public.kits (name) values ('[テスト]キットA') returning id into v_a;
  insert into public.kits (name) values ('[テスト]キットB') returning id into v_b;
  insert into public.kits (name) values ('[テスト]キットC') returning id into v_c;
  insert into public.kits (name) values ('[テスト]キットD') returning id into v_d;
  insert into public.kit_aliases (kit_id, alias) values (v_a, '[テスト]Aの別名');
  insert into public.reviews (kit_id, nickname, body, device_id)
    values (v_a, 'テスター', 'Aのレビュー', 'test-device-0001');
  -- A: 端末1・端末2 が積んでる / B: 端末1 が積んでる(統合すると端末1がぶつかる)
  insert into public.actions (kit_id, type, device_id) values
    (v_a, 'stash', 'test-device-0001'),
    (v_a, 'stash', 'test-device-0002'),
    (v_b, 'stash', 'test-device-0001');
  -- D は C に統合済み
  update public.kits set merged_into = v_c where id = v_d;

  for t in
    select * from (values
      -- ===== 検索の規則(中黒・空白を無視) =====
      (101, 'postgres', '中黒を取り除く',
        $q$select public.kit_search_key('ガンダム・エアリアル')$q$, 'ガンダムエアリアル'),
      (102, 'postgres', '半角中黒・全角空白・半角空白も取り除く',
        $q$select public.kit_search_key('ｶﾞﾝﾀﾞﾑ･ｴｱﾘｱﾙ　改修型 Ver.2')$q$, 'ガンダムエアリアル改修型ver.2'),
      (103, 'postgres', 'ひらがな→カタカナ・全角→半角は 002 のまま',
        $q$select public.kit_search_key('あばたーふみな １／１４４')$q$, 'アバターフミナ1/144'),
      (104, 'postgres', '取り込み済みのキットも新しい規則で計算し直されている',
        $q$select count(*) from public.kits where search_key ~ '[[:space:]・]'$q$, '0'),
      (105, 'postgres', '取り込み済みの別名も計算し直されている',
        $q$select count(*) from public.kit_aliases where search_key ~ '[[:space:]・]'$q$, '0'),
      (106, 'postgres', '全キットに search_key がある',
        $q$select count(*) from public.kits where search_key is null$q$, '0'),

      -- ===== 名前の修正 =====
      (201, 'postgres', '今の名前が違うと止まる',
        $q$select public.admin_apply_kit_correction('{a}', '[テスト]別の名前', '[テスト]キットA改', null)$q$, 'error'),
      (202, 'postgres', '名前を変えられる',
        $q$select public.admin_apply_kit_correction('{a}', '[テスト]キットA', '[テスト]キットA改', null)->>'renamed_from'$q$,
        '[テスト]キットA'),
      (203, 'postgres', '変更後の名前が入っている',
        $q$select name from public.kits where id = '{a}'$q$, '[テスト]キットA改'),
      (204, 'postgres', '変更前の名前が別名に残る',
        $q$select count(*) from public.kit_aliases where kit_id = '{a}' and alias = '[テスト]キットA'$q$, '1'),
      (205, 'postgres', '同じ内容をもう一度呼んでも何もしない',
        $q$select public.admin_apply_kit_correction('{a}', '[テスト]キットA', '[テスト]キットA改', null)->>'renamed_from'$q$,
        null),
      (206, 'postgres', '検索用の文字列も新しい名前になる',
        $q$select search_key from public.kits where id = '{a}'$q$, '[テスト]キットa改'),

      -- ===== 統合 =====
      (301, 'postgres', '自分自身には統合できない',
        $q$select public.admin_apply_kit_correction('{a}', null, null, '{a}')$q$, 'error'),
      (302, 'postgres', '統合済みのキット(D)を統合先にはできない',
        $q$select public.admin_apply_kit_correction('{a}', null, null, '{d}')$q$, 'error'),
      (303, 'postgres', 'ない統合先は止まる',
        $q$select public.admin_apply_kit_correction('{a}', null, null, '00000000-0000-0000-0000-000000000000')$q$, 'error'),
      (304, 'postgres', 'A を B に統合できる(押下記録は1件が重複のため残る)',
        $q$select public.admin_apply_kit_correction('{a}', null, null, '{b}')->>'actions_left'$q$, '1'),
      (305, 'postgres', 'A の merged_into が B',
        $q$select merged_into::text from public.kits where id = '{a}'$q$, '{b}'),
      (306, 'postgres', 'レビューが B に付け替わる',
        $q$select count(*) from public.reviews where kit_id = '{b}' and body = 'Aのレビュー'$q$, '1'),
      (307, 'postgres', '重複しない押下記録(端末2)は B に付け替わる',
        $q$select count(*) from public.actions where kit_id = '{b}' and device_id = 'test-device-0002'$q$, '1'),
      (308, 'postgres', '重複する押下記録(端末1)は A に残る',
        $q$select count(*) from public.actions where kit_id = '{a}' and device_id = 'test-device-0001'$q$, '1'),
      (309, 'postgres', 'B の積んでる人数は2人(A に残った分も合算、端末1は1人と数える)',
        $q$select stash_count from public.kit_stats where kit_id = '{b}'$q$, '2'),
      (310, 'postgres', 'A の名前・変更前の名前・別名が B の別名になる',
        $q$select string_agg(alias, ',' order by alias collate "C") from public.kit_aliases where kit_id = '{b}'$q$,
        '[テスト]Aの別名,[テスト]キットA,[テスト]キットA改'),
      (311, 'postgres', '同じ統合をもう一度呼んでも何もしない',
        $q$select public.admin_apply_kit_correction('{a}', null, null, '{b}')->>'merged_into'$q$, null),
      (312, 'postgres', '統合済みの A を別のキットに統合し直すことはできない',
        $q$select public.admin_apply_kit_correction('{a}', null, null, '{c}')$q$, 'error'),

      -- ===== 権限 =====
      (401, 'anon', '匿名ユーザーは修正用の関数を呼べない',
        $q$select public.admin_apply_kit_correction('{c}', '[テスト]キットC', '[テスト]乗っ取り', null)$q$, 'error'),
      (402, 'anon', '匿名ユーザーは検索用の関数を呼べる',
        $q$select public.kit_search_key('ふみな・ＳＤ')$q$, 'フミナsd'),
      (403, 'authenticated', 'ログインしただけのユーザーも修正用の関数を呼べない',
        $q$select public.admin_apply_kit_correction('{c}', '[テスト]キットC', '[テスト]乗っ取り', null)$q$, 'error')
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
      elsif v_phase = 'authenticated' then
        perform set_config('request.jwt.claims',
          '{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000abcd"}', true);
        set local role authenticated;
      end if;
      v_log := v_log || E'\n--- ' || v_phase || ' ---';
    end if;

    v_sql := replace(replace(replace(replace(t.sql,
               '{a}', v_a::text), '{b}', v_b::text), '{c}', v_c::text), '{d}', v_d::text);

    v_total := v_total + 1;
    begin
      if t.expect = 'error' then
        execute v_sql;
        v_got := 'ok';
      else
        execute v_sql into v_got;
      end if;
    exception when others then
      v_got := 'error(' || sqlstate || ': ' || sqlerrm || ')';
    end;

    v_ok := case when t.expect = 'error' then coalesce(v_got like 'error%', false)
                 else v_got is not distinct from replace(replace(t.expect, '{a}', v_a::text), '{b}', v_b::text) end;
    if not v_ok then
      v_fail := v_fail + 1;
    end if;
    v_log := v_log || E'\n' || case when v_ok then 'OK  ' else 'NG  ' end || t.label
             || case when v_ok then ''
                     else ' (期待: ' || coalesce(t.expect, 'null') || ' / 実際: ' || coalesce(v_got, 'null') || ')' end;
  end loop;

  reset role;
  raise notice '%', v_log;
  raise exception using
    message = format(E'テスト結果: %s件中 NG %s件\n'
                     '(結果表示のためわざとエラーで終了しています。テストデータは残りません)%s',
                     v_total, v_fail, v_log);
end;
$test$;
