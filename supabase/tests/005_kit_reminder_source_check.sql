-- =====================================================================
-- 積みプラ相談所 005_kit_reminder_source.sql の動作確認
--
-- 使い方: SupabaseのSQL Editorにまるごと貼って Run(005 を適用した後)。
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
  -- ---------- 準備(postgres 権限でテストデータを作る。取り込みスクリプトと同じ立場) ----------
  insert into public.kits (name, maker, scale, source, release_month)
    values ('[テスト]リマインドキット', 'テストメーカー', '1/24', 'reminder', '2026-10-01')
    returning id into v_kit;

  for t in
    select * from (values
      -- ===== 列と制約 =====
      (101, 'postgres', 'source=reminder のキットを追加できる(準備で追加した行)',
        $q$select source from public.kits where id = '{kit}'$q$, 'reminder'),
      (102, 'postgres', 'source=hj は今まで通り追加できる',
        $q$insert into public.kits (name, source) values ('[テスト]HJ', 'hj')$q$, 'ok'),
      (103, 'postgres', 'source=user は今まで通り追加できる',
        $q$insert into public.kits (name, source) values ('[テスト]ユーザー', 'user')$q$, 'ok'),
      (104, 'postgres', 'source に決められた値以外は入らない',
        $q$insert into public.kits (name, source) values ('[テスト]x', 'other')$q$, 'error'),
      (105, 'postgres', 'source を省略すると今まで通り user になる',
        $q$with ins as (insert into public.kits (name) values ('[テスト]省略') returning source)
           select source from ins$q$, 'user'),
      (106, 'postgres', '既存のキットの source は hj / user / reminder のどれか',
        $q$select count(*) from public.kits where source not in ('hj', 'user', 'reminder')$q$, '0'),
      (107, 'postgres', 'release_month は月の1日なら入る',
        $q$select release_month::text from public.kits where id = '{kit}'$q$, '2026-10-01'),
      (108, 'postgres', 'release_month に月の途中の日は入らない',
        $q$update public.kits set release_month = '2026-10-15' where id = '{kit}'$q$, 'error'),
      (109, 'postgres', 'release_month は空(null)でもよい',
        $q$insert into public.kits (name, source) values ('[テスト]発売月なし', 'reminder')$q$, 'ok'),
      (110, 'postgres', 'anon は release_month を読める',
        $q$select has_column_privilege('anon', 'public.kits', 'release_month', 'select')::text$q$, 'true'),
      (111, 'postgres', 'anon は release_month を書けない',
        $q$select (has_column_privilege('anon', 'public.kits', 'release_month', 'insert')
                or has_column_privilege('anon', 'public.kits', 'release_month', 'update'))::text$q$, 'false'),
      (112, 'postgres', 'anon は source_ref を読めないまま(004)',
        $q$select has_column_privilege('anon', 'public.kits', 'source_ref', 'select')::text$q$, 'false'),

      -- ===== 匿名ユーザー(公開画面と同じ権限) =====
      (201, 'anon', '名前・メーカー・スケール・発売月を読める',
        $q$select name || ' / ' || maker || ' / ' || scale || ' / ' || release_month
           from public.kits where id = '{kit}'$q$, '[テスト]リマインドキット / テストメーカー / 1/24 / 2026-10-01'),
      (202, 'anon', '検索(search_key)で探せる',
        $q$select count(*) from public.kits where id = '{kit}' and merged_into is null
           and search_key ilike '%' || public.kit_search_key('リマインドキット') || '%'$q$, '1'),
      (203, 'anon', 'source=reminder では追加できない',
        $q$insert into public.kits (name, source) values ('[テスト]偽リマインド', 'reminder')$q$, 'error'),
      (204, 'anon', '発売月を指定して追加できない',
        $q$insert into public.kits (name, release_month) values ('[テスト]x', '2026-10-01')$q$, 'error'),
      (205, 'anon', 'キットの追加は今まで通りできる',
        $q$with ins as (insert into public.kits (name, maker, scale) values ('[テスト]匿名追加', 'テスト', '1/100')
                        returning id)
           select count(*) from ins$q$, '1'),
      (206, 'anon', '発売月を書き換えられない',
        $q$update public.kits set release_month = '2027-01-01' where id = '{kit}'$q$, 'error'),
      (207, 'anon', 'source_ref は今まで通り読めない',
        $q$select source_ref from public.kits where id = '{kit}'$q$, 'error'),
      (208, 'anon', 'kit_stats(人数の集計)は今まで通り読める',
        $q$select name from public.kit_stats where kit_id = '{kit}'$q$, '[テスト]リマインドキット'),
      (209, 'anon', '積んでるボタン(record_action)は取り込んだキットにも使える',
        $q$select public.record_action('{kit}', 'stash', 'test-device-0005')$q$, 'active')
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
