# Supabase セットアップ手順

## 1. Supabase プロジェクト作成

1. https://supabase.com/dashboard で新規プロジェクトを作成
2. Project URL と 2 つのキーをメモ:
   - **anon key** (公開可): クライアント/サーバー両方で使用
   - **service_role key** (機密): サーバー専用、RLS バイパス用

## 2. マイグレーション実行

Supabase Dashboard → SQL Editor を開いて、`migrations/0001_init.sql` の全文を貼り付けて実行。

以下が作られる:
- `public.directors` (ディレクタープロフィール)
- `public.sessions` (案件セッション、Sandbox ID を保持)
- `public.corrections` (修正指示履歴)
- RLS ポリシー (自分のデータだけ読み書き可)
- `auth.users` → `public.directors` の自動同期トリガー

## 3. 認証設定 (Authentication)

Supabase Dashboard → Authentication → Providers で:
- **Email**: 有効化、「Confirm email」は運用に応じて
- もしくは Google OAuth を有効化

必要ならテスト用ディレクター:
Dashboard → Authentication → Users → Invite user でメールアドレスを登録。

## 4. directors-bot-v1 に環境変数を設定

`.env.local` に:
```
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGci...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGci...
```

## 5. 確認

`npm run dev` を起動して `/login` にアクセスできれば準備 OK。
