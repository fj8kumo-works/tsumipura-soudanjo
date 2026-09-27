# 積みプラ相談所

未組立プラモ(積みプラ)のレビューを共有するアプリ。

- 公開: GitHub Pages(静的サイト)
- データ: Supabase(Postgres + Storage)
- 利用者はログインなし。管理者1人だけ Supabase Auth でログインする
- 接続キーはブラウザから見えるため、守りはすべて **列単位の GRANT + RLS + DB関数** で行う

## フォルダ構成

```
supabase/
  migrations/001_init.sql     テーブル・権限・関数・集計・Storage の初期設定
  migrations/002_kit_search_key.sql  検索用の列 search_key(表記ゆれ対策)
  tests/001_init_check.sql    動作確認用SQL(実行してもデータは残らない)
  migrations/003_kit_corrections.sql  検索で中黒・空白を無視 / キット修正・統合用の関数
  tests/002_kit_search_key_check.sql  002 の動作確認用SQL
  tests/003_kit_corrections_check.sql  003 の動作確認用SQL
scripts/
  hj_import/build_kits_preview.mjs  HJ作例インデックス → kits / kit_aliases のプレビューCSV
  hj_import/maker_aliases.csv       メーカー表記の対応表
  hj_import/import_to_supabase.mjs  プレビューCSV → Supabase(追加のみ。--apply で書き込み)
  hj_import/verify_import.mjs       取り込み結果の確認
  hj_import/supabase.mjs            .env・CSV・Supabase REST の共通処理
  admin/apply_kit_corrections.mjs   data/kit_corrections.csv でキットの名前修正・統合(--apply で書き込み)
```

---

## データベースのセットアップ(ステップ1)

### 1. マイグレーションを適用する

1. [Supabase ダッシュボード](https://supabase.com/dashboard) で対象プロジェクトを開く
2. 左メニューの **SQL Editor** → **New query**
3. `supabase/migrations/001_init.sql` の中身をすべて貼り付けて **Run**
4. 「Success. No rows returned」と出れば完了

> 新しいプロジェクトに **1回だけ** 実行してください。2回目は「already exists」で失敗します。
> Supabase から「security definer view」の警告が出ることがありますが、`kit_stats` は意図的にそうしています(下記「集計」参照)。

### 2. 一般ユーザーの新規登録を止める(重要)

管理者以外がアカウントを作れないようにします。

- **Authentication** → **Sign In / Providers**(旧 Providers → Email)
- **Allow new users to sign up** を **OFF**

### 3. 管理者を登録する

1. **Authentication** → **Users** → **Add user** → **Create new user** でメールアドレスとパスワードを入力して作成
2. SQL Editor で次を実行(メールアドレスは作成したものに置き換え)

```sql
insert into public.admins (user_id)
select id from auth.users where email = 'admin@example.com';
```

### 4. 動作確認

1. SQL Editor の New query に `supabase/tests/001_init_check.sql` をすべて貼り付けて **Run**
2. **わざとエラーで終わります**。エラーメッセージが結果の一覧です
   - `テスト結果: 74件中 NG 0件 / スキップ 0件` なら全部OK
   - 管理者を未登録だと管理者のテスト15件がスキップされます
3. テスト用のデータはすべてロールバックされ、DBには残りません

### 5. Storage を確認する

**Storage** に `review-images` バケットができていて、Public・2MB・`image/jpeg, image/png, image/webp` になっていればOK。

### 6. 検索の表記ゆれ対策(002)

1. SQL Editor の New query に `supabase/migrations/002_kit_search_key.sql` をすべて貼り付けて **Run**(1回だけ)
2. 続けて `supabase/tests/002_kit_search_key_check.sql` を貼り付けて **Run**。わざとエラーで終わり、`テスト結果: 17件中 NG 0件` なら OK

`kits` と `kit_aliases` に検索用の列 `search_key` が自動で作られる。ひらがな/カタカナ、全角/半角(Ｆ/F、１/1、／//)、大文字/小文字の違いをそろえた文字列で、画面の検索はこの列で探す。そろえる規則は DB の `public.kit_search_key` と `assets/api.js` の `toSearchKey` で同じにしてあるので、変えるときは両方直す。

### 7. 中黒・空白を無視する検索 / キット修正用の関数(003)

1. SQL Editor の New query に `supabase/migrations/003_kit_corrections.sql` をすべて貼り付けて **Run**(1回だけ。全体が `begin;`〜`commit;` なので、失敗したら何も反映されない)
2. 続けて `supabase/tests/003_kit_corrections_check.sql` を貼り付けて **Run**。わざとエラーで終わり、`テスト結果: 27件中 NG 0件` なら OK

- `search_key` の規則に「中黒(・)と空白を取り除く」が加わり、「ガンダムエアリアル」でも「ガンダム・エアリアル」でもヒットする。既存の行も計算し直される
- `admin_apply_kit_correction`(キットの名前修正・統合)ができる。呼べるのは service_role だけ
- 003 の後は 002 のテストは一部 NG になる(規則が変わるため)。003 のテストで確認する

---

## HJ作例インデックスの取り込み準備(ステップ2-1)

HJ作例インデックス(`data/hj_index_2022-2026.csv`)を、キット単位にまとめたプレビューCSVに変換します。**Supabase には書き込みません。**

```
node scripts/hj_import/build_kits_preview.mjs [入力CSV] [出力フォルダ]
```

`data/` は公開しない方針のため `.gitignore` 済み。出力もすべて `data/` に置く。

| 出力 | 内容 |
|---|---|
| `kits_preview.csv` | 取り込むキット。`maker`・`scale` も取り込む |
| `aliases_preview.csv` | キットの別名(表記ゆれ) |
| `excluded_rows.csv` | 取り込まない作例と理由(キット名が空・スクラッチビルド・作品タイトルの可能性・版元の可能性) |
| `review_same.csv` | 同じキットの可能性がある組。手で確認する |

- 対象は `種別` が「作例」「連載作例」「ジオラマ作例」の行
- 名前(空白・中黒・全角半角などの違いを無視)・メーカー・スケールがすべて一致すれば同じキットとしてまとめ、表記の違いは別名にする
- メーカー名は `scripts/hj_import/maker_aliases.csv`(表記,統一名)で揃える。表記ゆれを見つけたら行を足して再実行する
- 次のものはまとめずに取り込み、`needs_review = 要確認` と理由を `review_reason` に残す
  - ガンプラの 1/144・1/100・1/60(同名でもグレード HG/RG/EG、MGのVer. を判別できないため作例ごとに分ける)
  - 1作例に複数キットの可能性があるもの、メーカー不明のもの
- `id` は「そのキットが最初に載った作例(号・ページ・キット名)」から作る UUID v5。メーカー対応表や正規化を変えても、後の号を追加しても変わらず、そのまま `kits.id` に使える

### 同じキットの確認(review_same.csv)

1. `data/review_same.csv` を開き、同じキットなら「まとめる」列に `○` を入れて保存する(Excel で Shift_JIS 保存しても読める)
2. スクリプトを再実行すると ○ の組が1つのキットに統合され、表記の違いは別名になる(A=B、B=C なら3つとも1つに)
3. ただし、つながった結果メーカーかスケールが違うものが1つになる ○ は統合せず、「状態」列に「矛盾のため保留」と出す
   (例: スケール不明の「νガンダム」に 1/144 とも 1/100 とも ○ を付けた場合)
4. 記入は次回の `review_same.csv` に引き継がれる。別物と確認したものは `×` など ○ 以外を入れておくと、要確認から外れる

---

## Supabase への取り込み(ステップ2-2)

### 準備: .env

`.env.example` をコピーして `.env` を作り、Supabase ダッシュボード → **Project Settings** → **API** の値を入れる。
`.env` は `.gitignore` 済み。**service_role キーは RLS を通らないので、リポジトリやブラウザには絶対に出さない。**

### 取り込みと確認

```
node scripts/hj_import/build_kits_preview.mjs          プレビューCSVを作る
node scripts/hj_import/import_to_supabase.mjs          確認だけ(書き込まない)
node scripts/hj_import/import_to_supabase.mjs --apply  kits / kit_aliases に書き込む
node scripts/hj_import/verify_import.mjs               件数・別名検索・統合の重複を確認(読むだけ)
```

### 再実行・HJデータの追加について

- 取り込みは**追加だけ**。既にある kits / kit_aliases の行は更新も削除もしない。管理画面で直した名前や `merged_into`、レビュー・押下記録の紐づけはそのまま残る
- キットの id は最初の作例から決まるので、再実行しても同じキットは同じ id になり、重複しない。新しい号を足せば、新しいキットと別名だけが増える
- 既存キットに新しい作例が増えても、DB の `source_ref` は更新されない(追加だけのため)
- 取り込み後に `review_same.csv` で新しく ○ を付けると、統合される側のキットは DB に残る。スクリプトはそれを「merged_into を検討」として表示するだけなので、統合は管理画面の merged_into で行う
- `excluded_rows.csv` の条件を変えるなどで CSV から消えたキットも、DB からは消さない(「CSV にない」と表示するだけ)

---

## キットの名前修正・統合(管理画面ができるまでのつなぎ)

`data/kit_corrections.csv`(`data/` は公開しないので `.gitignore` 済み)に書いて、まとめて反映する。先に 003 を適用しておくこと。

| 列 | 内容 |
|---|---|
| キットid | 直すキットの id(必須) |
| 今の名前 | DB の今の名前。DB と違えば止まる(古い CSV で上書きしないため) |
| 新しい名前 | 入っていれば名前を変える。変更前の名前は自動で別名に残る(古い名前でも検索に出る) |
| 統合先のキットid | 入っていれば merged_into で統合先にまとめる。レビュー・押下記録も付け替え、名前と別名は統合先の別名に残る |
| メモ | 自由記入(DB には書かない) |

```
node scripts/admin/apply_kit_corrections.mjs            確認だけ(書き込まない)
node scripts/admin/apply_kit_corrections.mjs --apply    書き込む
```

- 問題のある行が1つでもあれば、何も書き込まずに「何が起きたか / どうすれば直るか」を表示して止まる
- 1行の中身(名前の変更・統合・付け替え)は全部反映されるか何も反映されないかのどちらか。反映済みの行は飛ばすので、同じ CSV を何度実行してもよい
- 押下記録は「同じ端末・キット・種類の有効な記録は1件」の決まりがあるので、統合先にぶつかる記録は統合元に残す(`kit_stats` が統合先に合算するので人数は変わらない)
- 統合は1段だけ(A→B→C は不可)。統合の取り消しはできない
- HJ の取り込み(`import_to_supabase.mjs`)を再実行しても、既存の行は更新しないので、この修正は元に戻らない

---

## 作ったもの

### テーブル

| テーブル | 内容 | 匿名ユーザー | 管理者 |
|---|---|---|---|
| `kits` | キット | 閲覧・追加(`name` `maker` `scale` のみ指定可) | 閲覧・更新 |
| `kit_aliases` | キットの別名 | 閲覧 | 閲覧・更新 |
| `reviews` | レビュー | `visible` のみ閲覧(`device_id` `user_id` 列は読めない)・投稿 | 全件閲覧・更新 |
| `review_images` | レビュー画像(最大3枚) | 表示中レビューの分のみ閲覧・投稿直後のレビューに追加 | 全件閲覧・更新 |
| `actions` | 積んでる/作った の押下記録 | 直接は不可(`record_action` 経由のみ) | 閲覧・更新 |
| `deletion_requests` | 削除依頼 | 追加のみ | 閲覧・更新 |
| `admins` | 管理者 | 不可 | 閲覧(追加は SQL Editor で) |
| `settings` | しきい値 | 不可 | 閲覧・更新 |

- 削除(DELETE)は誰にも許可していません。レビューは `status = 'hidden'` で非表示にします
- `user_id` は将来のログイン導入用で、MVP では常に null

### 関数・ビュー

| 名前 | 用途 | 呼べる人 |
|---|---|---|
| `record_action(kit_id, type, device_id)` | 押下を記録。戻り値 `active` / `pending` / `duplicate` | 誰でも |
| `kit_stats`(ビュー) | キットごとの人数(累計・今月) | 誰でも |
| `get_ranking(type, period, limit)` | ランキング(`type`: stash/built、`period`: all/month) | 誰でも |
| `can_upload_review_image(path)` | Storage アップロード可否(Storage のポリシーから使用) | 誰でも |
| `review_accepts_images(review_id)` | 画像を追加できるレビューか | 誰でも |
| `is_admin()` | ログイン中の人が管理者か | ログインユーザー |

### settings の初期値

| key | 値 | 意味 |
|---|---|---|
| `action_device_hourly_limit` | 10 | 同じ端末から直近1時間の押下がこれを超えたら pending |
| `action_kit_hourly_limit` | 20 | 同じキットへの直近1時間の押下がこれを超えたら pending |
| `review_image_upload_minutes` | 30 | レビュー投稿から何分以内なら画像を追加できるか |

変更例: `update public.settings set value = 15 where key = 'action_device_hourly_limit';`

---

## 画面を作るときの注意(ステップ2以降向け)

- **reviews を読むときは列を指定する**。`select('*')` は `device_id` を含むので匿名では権限エラーになります
  ```js
  supabase.from('reviews').select('id, kit_id, nickname, body, x_url, created_at')
  ```
- **レビュー投稿 → 画像の順**。投稿時に `.insert({...}).select('id')` で id を受け取り、画像はその id を使う
- **画像のパスは `<review_id>/<1〜3>.<jpg|jpeg|png|webp>`**(拡張子は小文字)。`review_images.storage_path` にも同じ値を入れる
- **アップロードは上書きなし**(`upsert: false`)。上書き・削除のポリシーはありません
- 画像の追加はレビュー投稿から30分以内のみ(`settings` で変更可)
- `device_id` は初回に `crypto.randomUUID()` で作って localStorage に保存する想定(8〜64文字)
- `deletion_requests` への追加は `.insert()` のみ(`.select()` を付けると権限エラー)
- ランキング: `supabase.rpc('get_ranking', { p_type: 'stash', p_period: 'month', p_limit: 20 })`
- 押下: `supabase.rpc('record_action', { p_kit_id, p_type: 'stash', p_device_id })`
- 統合済みキット(`merged_into` が入っている)は一覧で除外し、統合先に誘導する
