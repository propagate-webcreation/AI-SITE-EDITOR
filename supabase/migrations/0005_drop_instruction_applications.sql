-- =============================================================================
-- directors-bot-v1: instruction_applications / corrections テーブル削除
-- =============================================================================
-- 修正指示は案件を閉じたら破棄する方針のため、DB に保存する必要がなくなった。
-- 復元・revert は Sandbox 内の git log（コミットメッセージに instructionId を含む）と
-- クライアントの localStorage から行う。
--
-- 既存データは保持していても使われないので丸ごと DROP する。
-- =============================================================================

drop table if exists public.instruction_applications;
drop table if exists public.corrections;

-- sessions の last_pushed_* カラムも UI で表示していないので削除する。
alter table public.sessions
  drop column if exists last_pushed_at,
  drop column if exists last_pushed_commit_sha;
