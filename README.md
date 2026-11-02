# マイスケジュール（PWA）

空き時間が見える1日タイムラインに、ToDo と習慣を自動で割り振る個人用スケジュールアプリ。
スマホ優先・ダークモード対応・オフラインで動作。`schedule.html`（参考実装）の UI を引き継いでいます。

## 機能

| 機能 | 内容 |
|---|---|
| 1日タイムライン | 縦の時間軸。30分以上（設定可）の隙間を「空き時間」として表示し、タップで予定追加。左右スワイプで日送り |
| ToDo 自動割り振り | 追加すると所要時間を AI（Claude）で見積もり、今後1週間の空きに配置。期限 → 優先度順。入らなければ分割、それでも足りなければ警告 |
| 習慣 | 曜日・時間帯・所要時間を指定すると、その範囲の空きに毎週自動配置。「この日はスキップ」も可 |
| 設定 | 活動時間、予定前後の余白、空き時間の最小長、分割単位、配置期間、通知タイミング（複数）、テーマ |
| 通知 | 予定の N 分前に Web Push（アプリを閉じていても届く）。未設定時はアプリを開いている間のローカル通知 |
| 同期 | Supabase（メールの6桁コードでログイン）。ローカルファースト＋last-write-wins、Realtime で即時反映 |

自動配置された枠は点線で表示されます。枠の時間を手で変えると「固定」になり、再配置で動かなくなります。
すでに置かれた枠は、予定と衝突しない限り動かしません（時間が経っても毎分ずれない）。
「余白」は手で入れた予定の前後にだけ確保します（ToDo・習慣の枠同士は詰めて配置）。

## 構成

```
web/                    静的ファイルだけの PWA（ビルド不要）
  index.html styles.css manifest.webmanifest sw.js config.js icons/
  js/scheduler.js       空き時間計算・自動配置（純粋関数、テストあり）
  js/store.js           localStorage のデータストア（変更履歴・論理削除）
  js/sync.js            Supabase 同期・ログイン
  js/push.js            Web Push 購読・ローカル通知
  js/ai.js              所要時間見積もり（Edge Function / キーワードの簡易見積もり）
  js/app.js             UI
supabase/
  migrations/           テーブル・RLS・LWW トリガー
  functions/estimate/   Claude API で所要時間を見積もる（要ログイン）
  functions/push-dispatch/  毎分起動し、通知時刻が来た予定を Web Push 送信
  cron.sql              push-dispatch を毎分呼ぶ pg_cron 設定
tests/                  スケジューラのテスト（node --test）
```

## ローカルで動かす

```sh
npm test          # スケジューラのテスト
npm run dev       # http://localhost:5173 で web/ を配信
```

`web/config.js` が空のままなら「この端末のみ」モードで全機能（AI 見積もりはキーワードによる目安、通知はアプリ表示中のみ）が動きます。

## Supabase のセットアップ（同期・AI・Web Push）

1. [Supabase](https://supabase.com) でプロジェクトを作成
2. スキーマを適用
   ```sh
   npx supabase link --project-ref <PROJECT_REF>
   npx supabase db push
   ```
   （または `supabase/migrations/*.sql` を SQL Editor に貼って実行）
3. **ログインを6桁コード方式にする**：Authentication → Email Templates → Magic Link の本文に `{{ .Token }}` を入れる
   （ホーム画面の PWA からマジックリンクを開くと Safari に飛んでしまうため、コード入力にしています）
4. VAPID 鍵を作成
   ```sh
   npx web-push generate-vapid-keys
   ```
5. Edge Function の secrets を設定してデプロイ
   ```sh
   npx supabase secrets set \
     ANTHROPIC_API_KEY=sk-ant-... \
     VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@example.com \
     CRON_SECRET=$(openssl rand -hex 24)
   npx supabase functions deploy estimate
   npx supabase functions deploy push-dispatch --no-verify-jwt
   ```
6. Database → Extensions で `pg_cron` と `pg_net` を有効化し、`supabase/cron.sql` の `<PROJECT_REF>` と `<CRON_SECRET>` を置き換えて SQL Editor で実行
7. `web/config.js` に `supabaseUrl`・`supabaseAnonKey`（Project Settings → API）・`vapidPublicKey` を記入
8. Authentication → URL Configuration の Site URL に公開 URL を設定

AI 見積もりは `claude-opus-5-5`（effort: low、構造化出力）を使います。安全分類器で断られた場合はサーバー側フォールバック（`fallbacks: "default"`）で別モデルに切り替わります。

## 公開（GitHub Pages）

`.github/workflows/pages.yml` が `main` への push でテスト → `web/` を GitHub Pages にデプロイします。
リポジトリの Settings → Pages → Source を「GitHub Actions」にしてください。HTTPS 配信なので Service Worker / Web Push がそのまま使えます。

## iPhone で通知を受け取るには

iOS 16.4 以降で、Safari の共有ボタン →「ホーム画面に追加」したアプリから 設定 → 通知「オンにする」を押してください（Safari のタブのままでは Web Push は使えません）。

## データモデル

すべて `records(user_id, id, kind, data jsonb, deleted, updated_at, starts_at, server_updated_at)` の1テーブル。

- `kind='event'` 予定（`auto=true` は自動配置の枠。`kind`=`todo|habit`、`ref`=元の ID、`pinned`）
- `kind='todo'` ToDo（`minutes`, `due`, `priority`, `done`, `estSource`）
- `kind='habit'` 習慣（`days`[0=日..6=土], `from`, `to`, `minutes`, `skip`[日付]）
- `kind='settings'` 設定（1件）

自動配置の ID は入力から決まる（`auto-h-<習慣>-<日付>` など）ので、複数端末で同時に再配置しても同じ結果になり衝突しません。
参考実装 `schedule.html` の localStorage データ（`my-schedule-v1`）は同じオリジンで開けば初回起動時に取り込まれます。
