-- =====================================================================
-- 積みプラ相談所 004_hide_kit_source_ref.sql の動作確認
--
-- 使い方: SupabaseのSQL Editorにまるごと貼って Run(004 を適用した後)。
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
  insert into public.kits (name, maker, scale, source, source_ref)
    values ('[テスト]HJキット', 'テストメーカー', '1/144', 'hj', 'HJ 2099-01 p.001')
    returning id into v_kit;
  insert into public.kit_aliases (kit_id, alias) values (v_kit, '[テスト]HJキットの別名');

  for t in
    select * from (values
      -- ===== 権限の一覧 =====
      (101, 'postgres', 'anon は source_ref を読めない',
        $q$select has_column_privilege('anon', 'public.kits', 'source_ref', 'select')::text$q$, 'false'),
      (102, 'postgres', 'anon は画面で使う列を読める(id・name・maker・scale・merged_into・search_key)',
        $q$select bool_and(has_column_privilege('anon', 'public.kits', c, 'select'))::text
           from unnest(array['id','name','maker','scale','merged_into','search_key']) c$q$, 'true'),
      (103, 'postgres', 'authenticated(管理者)は source_ref を読める',
        $q$select has_column_privilege('authenticated', 'public.kits', 'source_ref', 'select')::text$q$, 'true'),

      -- ===== 匿名ユーザー(公開画面と同じ権限) =====
      (201, 'anon', 'source_ref を指定して読むとエラー',
        $q$select source_ref from public.kits where id = '{kit}'$q$, 'error'),
      (202, 'anon', '全列(*)で読むとエラー(画面では列名を指定する)',
        $q$select * from public.kits where id = '{kit}'$q$, 'error'),
      (203, 'anon', 'where で source_ref を使うこともできない',
        $q$select count(*) from public.kits where source_ref like 'HJ%'$q$, 'error'),
      (204, 'anon', '名前・メーカー・スケールは読める(キット詳細と同じ列)',
        $q$select name || ' / ' || maker || ' / ' || scale from public.kits where id = '{kit}'$q$,
        '[テスト]HJキット / テストメーカー / 1/144'),
      (205, 'anon', '検索(search_key)で探せる',
        $q$select count(*) from public.kits where id = '{kit}' and merged_into is null
           and search_key ilike '%' || public.kit_search_key('hjキット') || '%'$q$, '1'),
      (206, 'anon', '別名からキットをたどれる(検索と同じ結び付け)',
        $q$select k.name from public.kit_aliases a join public.kits k on k.id = a.kit_id
           where a.alias = '[テスト]HJキットの別名'$q$, '[テスト]HJキット'),
      (207, 'anon', 'キットの追加は今まで通りでき、追加した id を受け取れる',
        $q$with ins as (insert into public.kits (name, maker, scale) values ('[テスト]匿名追加', 'テスト', '1/100')
                        returning id)
           select count(*) from ins$q$, '1'),
      (208, 'anon', 'kit_stats(人数の集計)は今まで通り読める',
        $q$select name from public.kit_stats where kit_id = '{kit}'$q$, '[テスト]HJキット'),
      (209, 'anon', '積んでるボタン(record_action)は今まで通り使える',
        $q$select public.record_action('{kit}', 'stash', 'test-device-0004')$q$, 'active'),

      -- ===== ログインユーザー(管理者用の権限) =====
      (301, 'authenticated', 'ログインユーザーは source_ref を読める',
        $q$select source_ref from public.kits where id = '{kit}'$q$, 'HJ 2099-01 p.001')
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

    v_sql := replace(t.sql, '{kit}', v_kit::text);

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
