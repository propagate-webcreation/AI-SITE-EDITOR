-- =============================================================================
-- directors-bot-v1 初期スキーマ
-- =============================================================================
-- Supabase SQL Editor でこのファイル全文を貼って実行する。
-- 既存データを想定していない初期セットアップ用。

-- ---------------------------------------------------------------------------
-- ディレクター (Supabase Auth の auth.users と紐付け)
-- ---------------------------------------------------------------------------
create table if not exists public.directors (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  created_at timestamptz not null default now()
);

comment on table public.directors is
  'ウェブディレクターのプロフィール。auth.users を拡張する。';

-- ---------------------------------------------------------------------------
-- セッション: 1 ディレクター × 1 案件 × 1 Sandbox
-- ---------------------------------------------------------------------------
create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  director_id uuid not null references public.directors(id) on delete cascade,
  record_number text not null,
  partner_name text not null,
  contract_plan text,
  sandbox_id text not null,
  preview_url text not null,
  github_repo_url text not null,
  status text not null check (status in ('active', 'closed', 'expired', 'error')),
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  closed_at timestamptz,
  error_message text
);

-- 同一 record_number に対して active は 1 件のみ (排他制御)
create unique index if not exists sessions_active_record_unique
  on public.sessions(record_number)
  where status = 'active';

create index if not exists sessions_director_status_idx
  on public.sessions(director_id, status);

create index if not exists sessions_expires_at_idx
  on public.sessions(expires_at)
  where status = 'active';

comment on table public.sessions is
  '案件を開いている間の作業セッション。1 Sandbox にマップ。';

-- ---------------------------------------------------------------------------
-- 修正指示バッチ: 1 セッション内で複数回送信されうる
-- ---------------------------------------------------------------------------
create table if not exists public.corrections (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  instructions jsonb not null,
  status text not null check (status in ('pending', 'running', 'success', 'error')),
  summary text,
  tool_use_count int,
  duration_sec numeric(10, 3),
  submitted_at timestamptz not null default now(),
  completed_at timestamptz,
  error_message text
);

create index if not exists corrections_session_idx
  on public.corrections(session_id);

comment on table public.corrections is
  'ディレクターが送信した修正指示とその実行結果の履歴。';

-- ---------------------------------------------------------------------------
-- Row Level Security: ディレクター自身のデータだけ参照可
-- ---------------------------------------------------------------------------
alter table public.directors enable row level security;
alter table public.sessions enable row level security;
alter table public.corrections enable row level security;

-- directors: 自分自身の行だけ
create policy "directors_self_select" on public.directors
  for select using (auth.uid() = id);
create policy "directors_self_insert" on public.directors
  for insert with check (auth.uid() = id);
create policy "directors_self_update" on public.directors
  for update using (auth.uid() = id);

-- sessions: 自分が作ったセッションだけ読める
create policy "sessions_self_select" on public.sessions
  for select using (auth.uid() = director_id);
create policy "sessions_self_insert" on public.sessions
  for insert with check (auth.uid() = director_id);
create policy "sessions_self_update" on public.sessions
  for update using (auth.uid() = director_id);

-- corrections: 紐づく session の director のみ
create policy "corrections_self_select" on public.corrections
  for select using (
    exists (
      select 1 from public.sessions s
      where s.id = corrections.session_id and s.director_id = auth.uid()
    )
  );
create policy "corrections_self_insert" on public.corrections
  for insert with check (
    exists (
      select 1 from public.sessions s
      where s.id = corrections.session_id and s.director_id = auth.uid()
    )
  );
create policy "corrections_self_update" on public.corrections
  for update using (
    exists (
      select 1 from public.sessions s
      where s.id = corrections.session_id and s.director_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- auth.users → public.directors の自動同期トリガー
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.directors (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', new.email)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
