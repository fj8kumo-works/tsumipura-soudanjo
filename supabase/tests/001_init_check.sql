-- =====================================================================
-- 積みプラ相談所 001_init.sql の動作確認
--
-- 使い方: SupabaseのSQL Editorにまるごと貼って Run。
--   ・匿名(anon)/ ログインしただけの一般ユーザー / 管理者 の3つの立場に切り替えて確認します
--   ・管理者のテストは public.admins に1人以上登録済みのときだけ実行されます
--   ・結果を表示するため、最後にわざとエラーで終了します。
--     エラーメッセージに「OK / NG」の一覧が出ます。テストデータはすべてロールバックされ残りません。
-- =====================================================================
do $test$
declare
  v_kit    uuid;
  v_kit2   uuid;
  v_review uuid;
  v_hidden uuid;
  v_rkits  uuid[];
  v_admin  uuid;
  v_phase  text := '';
  v_sql    text;
  v_got    text;
  v_ok     boolean;
  v_total  int := 0;
  v_fail   int := 0;
  v_skip   int := 0;
  v_log    text := '';
  t        record;
begin
  -- ---------- 準備(postgres 権限でテストデータを作る) ----------
  insert into public.kits (name) values ('[テスト]キットA') returning id into v_kit;
  insert into public.kits (name) values ('[テスト]キットB') returning id into v_kit2;
  with ins as (
    insert into public.kits (name)
    select '[テスト]連打用' || g from generate_series(1, 11) g
    returning id
  ) select array_agg(id) into v_rkits from ins;
  insert into public.kit_aliases (kit_id, alias) values (v_kit, '[テスト]別名A');
  insert into public.reviews (kit_id, nickname, body, device_id)
    values (v_kit, 'テスター', '表示中のレビュー', 'test-device-0001') returning id into v_review;
  insert into public.reviews (kit_id, nickname, body, device_id, status)
    values (v_kit, 'テスター', '非表示のレビュー', 'test-device-0001', 'hidden') returning id into v_hidden;
  insert into public.review_images (review_id, storage_path, sort_order)
    values (v_hidden, v_hidden || '/1.jpg', 1);
  insert into public.deletion_requests (review_id, reason) values (v_review, 'withdraw');
  select user_id into v_admin from public.admins limit 1;

  -- ---------- テスト一覧 ----------
  -- expect: 'error' = エラーになるべき / 'ok' = エラーなく実行できるべき / それ以外 = 結果の値
  for t in
    select * from (values
      -- ===== 匿名ユーザー =====
      (101, 'anon', 'kits: 閲覧できる',
        $q$select count(*) from public.kits where id in ('{kit}', '{kit2}')$q$, '2'),
      (102, 'anon', 'kits: 追加できる',
        $q$insert into public.kits (name, maker, scale) values ('[テスト]匿名追加', 'バンダイ', '1/144')$q$, 'ok'),
      (103, 'anon', 'kits: 名前0文字は拒否',
        $q$insert into public.kits (name) values ('  ')$q$, 'error'),
      (104, 'anon', 'kits: 名前101文字は拒否',
        $q$insert into public.kits (name) values (repeat('あ', 101))$q$, 'error'),
      (105, 'anon', 'kits: source=hj では追加できない',
        $q$insert into public.kits (name, source) values ('[テスト]偽HJ', 'hj')$q$, 'error'),
      (106, 'anon', 'kits: 統合先を指定して追加できない',
        $q$insert into public.kits (name, merged_into) values ('[テスト]x', '{kit}')$q$, 'error'),
      (107, 'anon', 'kits: 更新できない',
        $q$update public.kits set name = '改ざん' where id = '{kit}'$q$, 'error'),
      (108, 'anon', 'kits: 削除できない',
        $q$delete from public.kits where id = '{kit}'$q$, 'error'),
      (111, 'anon', 'kit_aliases: 閲覧できる',
        $q$select count(*) from public.kit_aliases where kit_id = '{kit}'$q$, '1'),
      (112, 'anon', 'kit_aliases: 追加できない',
        $q$insert into public.kit_aliases (kit_id, alias) values ('{kit}', '勝手な別名')$q$, 'error'),
      (121, 'anon', 'reviews: 表示中のものだけ見える',
        $q$select count(*) from public.reviews where id in ('{review}', '{hidden}')$q$, '1'),
      (122, 'anon', 'reviews: device_id は読めない',
        $q$select count(device_id) from public.reviews$q$, 'error'),
      (123, 'anon', 'reviews: 投稿できる',
        $q$insert into public.reviews (kit_id, nickname, body, x_url, device_id)
           values ('{kit}', '匿名', 'テスト本文', 'https://x.com/test/status/1', 'test-device-0002')$q$, 'ok'),
      (124, 'anon', 'reviews: status を指定して投稿できない',
        $q$insert into public.reviews (kit_id, nickname, body, device_id, status)
           values ('{kit}', '匿名', 'テスト', 'test-device-0002', 'hidden')$q$, 'error'),
      (125, 'anon', 'reviews: 本文2001文字は拒否',
        $q$insert into public.reviews (kit_id, nickname, body, device_id)
           values ('{kit}', '匿名', repeat('あ', 2001), 'test-device-0002')$q$, 'error'),
      (126, 'anon', 'reviews: X以外のURLは拒否',
        $q$insert into public.reviews (kit_id, nickname, body, x_url, device_id)
           values ('{kit}', '匿名', 'テスト', 'javascript:alert(1)', 'test-device-0002')$q$, 'error'),
      (127, 'anon', 'reviews: 更新できない(非表示→表示に戻せない)',
        $q$update public.reviews set status = 'visible' where id = '{hidden}'$q$, 'error'),
      (128, 'anon', 'reviews: 削除できない',
        $q$delete from public.reviews where id = '{review}'$q$, 'error'),
      (131, 'anon', 'review_images: 1枚目を追加できる',
        $q$insert into public.review_images (review_id, storage_path, sort_order)
           values ('{review}', '{review}/1.jpg', 1)$q$, 'ok'),
      (132, 'anon', 'review_images: 2・3枚目を追加できる',
        $q$insert into public.review_images (review_id, storage_path, sort_order)
           values ('{review}', '{review}/2.png', 2), ('{review}', '{review}/3.webp', 3)$q$, 'ok'),
      (133, 'anon', 'review_images: 4枚目は拒否',
        $q$insert into public.review_images (review_id, storage_path, sort_order)
           values ('{review}', '{review}/4.jpg', 4)$q$, 'error'),
      (134, 'anon', 'review_images: 同じ番号の重複は拒否',
        $q$insert into public.review_images (review_id, storage_path, sort_order)
           values ('{review}', '{review}/1.png', 1)$q$, 'error'),
      (135, 'anon', 'review_images: 非表示レビューには追加できない',
        $q$insert into public.review_images (review_id, storage_path, sort_order)
           values ('{hidden}', '{hidden}/2.jpg', 2)$q$, 'error'),
      (136, 'anon', 'review_images: 表示中レビューの画像は見える',
        $q$select count(*) from public.review_images where review_id = '{review}'$q$, '3'),
      (137, 'anon', 'review_images: 非表示レビューの画像は見えない',
        $q$select count(*) from public.review_images where review_id = '{hidden}'$q$, '0'),
      (138, 'anon', 'review_images: 削除できない',
        $q$delete from public.review_images where review_id = '{review}'$q$, 'error'),
      (141, 'anon', 'actions: 直接閲覧できない',
        $q$select count(*) from public.actions$q$, 'error'),
      (142, 'anon', 'actions: 直接追加できない',
        $q$insert into public.actions (kit_id, type, device_id) values ('{kit}', 'stash', 'test-device-0002')$q$, 'error'),
      (143, 'anon', 'record_action: 初回は active',
        $q$select public.record_action('{kit}', 'stash', 'test-device-0002')$q$, 'active'),
      (144, 'anon', 'record_action: 同じ押下の2回目は記録しない',
        $q$select public.record_action('{kit}', 'stash', 'test-device-0002')$q$, 'duplicate'),
      (145, 'anon', 'record_action: 種類が違えば記録する',
        $q$select public.record_action('{kit}', 'built', 'test-device-0002')$q$, 'active'),
      (146, 'anon', 'record_action: 不正な type は拒否',
        $q$select public.record_action('{kit}', 'bad', 'test-device-0002')$q$, 'error'),
      (147, 'anon', 'record_action: 1端末1時間で11件目は pending(1件)',
        $q$select count(*) filter (where r = 'pending')
           from (select public.record_action(k, 'stash', 'test-device-0003') as r
                 from unnest('{rkits}'::uuid[]) as k) s$q$, '1'),
      (148, 'anon', 'record_action: 1キット1時間で21件目は pending(1件)',
        $q$select count(*) filter (where r = 'pending')
           from (select public.record_action('{kit2}', 'built', 'test-kit-dev-' || g) as r
                 from generate_series(1, 21) g) s$q$, '1'),
      (151, 'anon', 'kit_stats: 積んでる/作った人数',
        $q$select stash_count || '/' || built_count from public.kit_stats where kit_id = '{kit}'$q$, '1/1'),
      (152, 'anon', 'kit_stats: pending は数えない(累計)',
        $q$select built_count from public.kit_stats where kit_id = '{kit2}'$q$, '20'),
      (153, 'anon', 'kit_stats: pending は数えない(今月)',
        $q$select built_count_month from public.kit_stats where kit_id = '{kit2}'$q$, '20'),
      (154, 'anon', 'kit_stats: device_id の列がない',
        $q$select count(*) from pg_attribute
           where attrelid = 'public.kit_stats'::regclass and attnum > 0 and attname like '%device%'$q$, '0'),
      (155, 'anon', 'get_ranking: 作ったランキング(累計)',
        $q$select people from public.get_ranking('built', 'all', 100) where kit_id = '{kit2}'$q$, '20'),
      (156, 'anon', 'get_ranking: 作ったランキング(今月)',
        $q$select people from public.get_ranking('built', 'month', 100) where kit_id = '{kit2}'$q$, '20'),
      (161, 'anon', 'deletion_requests: 追加できる',
        $q$insert into public.deletion_requests (review_id, reason) values ('{review}', 'copyright')$q$, 'ok'),
      (162, 'anon', 'deletion_requests: 閲覧できない',
        $q$select count(*) from public.deletion_requests$q$, 'error'),
      (163, 'anon', 'deletion_requests: status を指定して追加できない',
        $q$insert into public.deletion_requests (review_id, reason, status) values ('{review}', 'copyright', 'approved')$q$, 'error'),
      (164, 'anon', 'deletion_requests: 更新できない',
        $q$update public.deletion_requests set status = 'approved'$q$, 'error'),
      (171, 'anon', 'settings: 閲覧できない',
        $q$select count(*) from public.settings$q$, 'error'),
      (172, 'anon', 'settings: 更新できない',
        $q$update public.settings set value = 9999$q$, 'error'),
      (173, 'anon', 'admins: 閲覧できない',
        $q$select count(*) from public.admins$q$, 'error'),
      (174, 'anon', 'admins: 自分を追加できない',
        $q$insert into public.admins (user_id) values ('00000000-0000-0000-0000-000000000001')$q$, 'error'),
      (181, 'anon', 'Storage: 投稿直後のレビューには画像を上げられる',
        $q$select public.can_upload_review_image('{review}/1.jpg')$q$, 'true'),
      (182, 'anon', 'Storage: 4番目のファイル名は拒否',
        $q$select public.can_upload_review_image('{review}/4.jpg')$q$, 'false'),
      (183, 'anon', 'Storage: 画像以外の拡張子は拒否',
        $q$select public.can_upload_review_image('{review}/1.gif')$q$, 'false'),
      (184, 'anon', 'Storage: 非表示レビューには上げられない',
        $q$select public.can_upload_review_image('{hidden}/1.jpg')$q$, 'false'),
      (185, 'anon', 'Storage: 決まった形式以外のパスは拒否',
        $q$select public.can_upload_review_image('../hack.jpg')$q$, 'false'),

      -- ===== ログインしただけの一般ユーザー(adminsに未登録) =====
      (201, 'user', 'actions: 1件も見えない',
        $q$select count(*) from public.actions$q$, '0'),
      (202, 'user', 'reviews: 非表示は見えない',
        $q$select count(*) from public.reviews where id = '{hidden}'$q$, '0'),
      (203, 'user', 'reviews: 更新しても1件も変わらない',
        $q$with u as (update public.reviews set status = 'visible' where id = '{hidden}' returning 1)
           select count(*) from u$q$, '0'),
      (204, 'user', 'settings: 1件も見えない',
        $q$select count(*) from public.settings$q$, '0'),
      (205, 'user', 'reviews: 削除できない',
        $q$delete from public.reviews where id = '{review}'$q$, 'error'),
      (206, 'user', 'record_action: 押せる',
        $q$select public.record_action('{kit}', 'stash', 'test-device-0004')$q$, 'active'),

      -- ===== 管理者 =====
      (301, 'admin', 'reviews: 非表示も含めて見える',
        $q$select count(*) from public.reviews where id in ('{review}', '{hidden}')$q$, '2'),
      (302, 'admin', 'actions: pending が見える',
        $q$select count(*) from public.actions where kit_id = '{kit2}' and status = 'pending'$q$, '1'),
      (303, 'admin', 'actions: pending を承認できる',
        $q$with u as (update public.actions set status = 'active'
                      where kit_id = '{kit2}' and status = 'pending' returning 1)
           select count(*) from u$q$, '1'),
      (304, 'admin', 'kit_stats: 承認後は人数に入る',
        $q$select built_count from public.kit_stats where kit_id = '{kit2}'$q$, '21'),
      (305, 'admin', 'reviews: 非表示にできる',
        $q$with u as (update public.reviews set status = 'hidden' where id = '{review}' returning 1)
           select count(*) from u$q$, '1'),
      (306, 'admin', 'deletion_requests: 承認すると handled_at が入る',
        $q$with u as (update public.deletion_requests set status = 'approved'
                      where review_id = '{review}' and reason = 'withdraw' returning handled_at)
           select count(*) from u where handled_at is not null$q$, '1'),
      (307, 'admin', 'settings: しきい値を変更できる',
        $q$with u as (update public.settings set value = 15
                      where key = 'action_device_hourly_limit' returning 1)
           select count(*) from u$q$, '1'),
      (308, 'admin', 'reviews: 削除はできない(非表示で対応)',
        $q$delete from public.reviews where id = '{review}'$q$, 'error'),
      (309, 'admin', 'actions: 直接追加はできない',
        $q$insert into public.actions (kit_id, type, device_id) values ('{kit}', 'stash', 'test-device-0009')$q$, 'error'),
      (311, 'admin', 'kits: キットBをキットAに統合できる',
        $q$with u as (update public.kits set merged_into = '{kit}' where id = '{kit2}' returning 1)
           select count(*) from u$q$, '1'),
      (312, 'admin', 'kit_stats: 統合先に合算される',
        $q$select built_count from public.kit_stats where kit_id = '{kit}'$q$, '22'),
      (313, 'admin', 'kit_stats: 統合元は一覧から消える',
        $q$select count(*) from public.kit_stats where kit_id = '{kit2}'$q$, '0'),
      (314, 'admin', 'record_action: 統合元への押下は統合先に記録',
        $q$select public.record_action('{kit2}', 'stash', 'test-device-0005')$q$, 'active'),
      (315, 'admin', 'kit_stats: 統合先の積んでる人数',
        $q$select stash_count from public.kit_stats where kit_id = '{kit}'$q$, '3'),
      (316, 'admin', 'kits: 統合済みキットを統合先にはできない',
        $q$update public.kits set merged_into = '{kit2}' where id = ('{rkits}'::uuid[])[1]$q$, 'error')
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
      elsif v_phase = 'user' then
        perform set_config('request.jwt.claims',
          '{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000abcd"}', true);
        set local role authenticated;
      elsif v_phase = 'admin' and v_admin is not null then
        perform set_config('request.jwt.claims',
          json_build_object('role', 'authenticated', 'sub', v_admin)::text, true);
        set local role authenticated;
      end if;
      v_log := v_log || E'\n--- ' || v_phase
               || case when v_phase = 'admin' and v_admin is null
                       then '(admins が未登録のためスキップ)' else '' end || ' ---';
    end if;

    if v_phase = 'admin' and v_admin is null then
      v_skip := v_skip + 1;
      continue;
    end if;

    v_sql := replace(replace(replace(replace(replace(t.sql,
               '{kit2}',   v_kit2::text),
               '{kit}',    v_kit::text),
               '{review}', v_review::text),
               '{hidden}', v_hidden::text),
               '{rkits}',  v_rkits::text);

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
    message = format(E'テスト結果: %s件中 NG %s件 / スキップ %s件\n'
                     '(結果表示のためわざとエラーで終了しています。テストデータは残りません)%s',
                     v_total, v_fail, v_skip, v_log);
end;
$test$;
