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
  tests/001_init_check.sql    動作確認用SQL(実行してもデータは残らない)
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
