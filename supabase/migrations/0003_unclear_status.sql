-- =============================================================================
-- directors-bot-v1: AI 判定不能 status の追加
-- =============================================================================
-- AI がエラーを起こさず最終メッセージは返したが、ファイル編集を 1 つも行わなかった
-- ケース (= 指示内容を特定できず説明だけ返した) を 'unclear' として区別する。
-- 今までは `applied` (commit なし) で記録されており、ディレクターから見ると
-- 「反映済み」なのに実際には何も変わらないという紛らわしい状態だった。
--
-- 'failed' (API エラー / 例外) とも区別する: 後続指示の処理を止めない「ソフト失敗」。
-- =============================================================================

alter table public.instruction_applications
  drop constraint if exists instruction_applications_status_check;

alter table public.instruction_applications
  add constraint instruction_applications_status_check
  check (status in ('pending', 'running', 'applied', 'failed', 'reverted', 'unclear'));
