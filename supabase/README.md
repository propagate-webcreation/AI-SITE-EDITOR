# Supabase セットアップ手順

## 1. Supabase プロジェクト作成

1. https://supabase.com/dashboard で新規プロジェクトを作成
2. Project URL と 2 つのキーをメモ:
   - **anon key** (公開可): クライアント/サーバー両方で使用
   - **service_role key** (機密): サーバー専用、RLS バイパス用

## 2. マイグレーション実行

Supabase Dashboard → SQL Editor を開いて、`migrations/` 配下の SQL を番号順に実行。

- `0001_init.sql`
  - `public.directors` / `sessions` / `corrections` 作成
  - RLS ポリシー
  - `auth.users` → `public.directors` 自動同期トリガー
- `0002_instruction_applications.sql`〜`0004_global_instruction.sql`
  - `public.instruction_applications` テーブルとその周辺カラムを追加していた履歴。
  - **後続の `0005` で drop するため、現在は空っぽでも問題ない**。
    クリーンな Supabase プロジェクトに新規セットアップする場合は、`0001` を流した後すぐ `0005` に進んで OK。
    ただし「すでに 0002〜0004 を流した既存 DB を片付ける」場合は、差分だけで済むので `0005` を最後に走らせる。
- `0005_drop_instruction_applications.sql`
  - `public.instruction_applications` / `public.corrections` を drop
  - `sessions.last_pushed_at` / `last_pushed_commit_sha` カラムを drop
  - **修正指示は DB に保存せず**、クライアントの localStorage と Sandbox 内の git log から復元する方針に変更したため

> **retention について**: 案件を閉じた瞬間に `sessions` 行が物理削除されます。
> 修正指示はそもそも DB に保存しないので purge 対象なし。AI の修正履歴は GitHub の commit 履歴
> および Sandbox 内の git log を参照してください。

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
