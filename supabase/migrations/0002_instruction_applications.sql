-- =============================================================================
-- directors-bot-v1: 逐次修正指示の適用履歴
-- =============================================================================
-- 1 修正指示 = 1 commit 単位で追跡する。
-- 「AI に修正させる」で各 instruction を 1 つずつ Gemini に流し、
-- 完了ごとに git commit → ここに 1 行 insert。
-- revert ボタンで個別にロールバック (revert commit 追加 + status=reverted)。
-- 「そのまま変更する」ボタン押下時に sessions.sandbox 上の commit 群を一括 push。

create table if not exists public.instruction_applications (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  instruction_id text not null,
  comment text not null,
  pin_index int,
  attachments jsonb,

  order_index int not null,

  status text not null check (
    status in ('pending', 'running', 'applied', 'failed', 'reverted')
  ),
  summary text,
  error_message text,

  commit_sha text,
  revert_commit_sha text,

  started_at timestamptz,
  completed_at timestamptz,
  reverted_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists instruction_applications_session_instruction_unique
  on public.instruction_applications (session_id, instruction_id);

create index if not exists instruction_applications_session_order_idx
  on public.instruction_applications (session_id, order_index);

comment on table public.instruction_applications is
  'AI 修正指示 1 件ごとの適用履歴。1 行 = 1 commit。revert 操作で status=reverted。';

alter table public.instruction_applications enable row level security;

create policy "instruction_applications_self_select" on public.instruction_applications
  for select using (
    exists (
      select 1 from public.sessions s
      where s.id = instruction_applications.session_id
      and s.director_id = auth.uid()
    )
  );

create policy "instruction_applications_self_insert" on public.instruction_applications
  for insert with check (
    exists (
      select 1 from public.sessions s
      where s.id = instruction_applications.session_id
      and s.director_id = auth.uid()
    )
  );

create policy "instruction_applications_self_update" on public.instruction_applications
  for update using (
    exists (
      select 1 from public.sessions s
      where s.id = instruction_applications.session_id
      and s.director_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- sessions に「一度でも push 済みか」フラグを追加 (任意でもいいが UI で使う)
-- ---------------------------------------------------------------------------
alter table public.sessions
  add column if not exists last_pushed_at timestamptz,
  add column if not exists last_pushed_commit_sha text;
