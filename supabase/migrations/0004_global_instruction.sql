-- =============================================================================
-- directors-bot-v1: 「全体指示」フラグ追加
-- =============================================================================
-- 通常の指示は並列で走らせるが、is_global=true の指示は他がすべて完了してから
-- 単独で順次実行する。実行時は system prompt が緩和され、max iteration も拡張される。

alter table public.instruction_applications
  add column if not exists is_global boolean not null default false;

create index if not exists instruction_applications_is_global_idx
  on public.instruction_applications (session_id, is_global);
