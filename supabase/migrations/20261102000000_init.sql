-- マイスケジュール：同期・通知用スキーマ

-- すべての予定・ToDo・習慣・設定を1テーブルで持つ（中身は jsonb）
create table if not exists public.records (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null,
  kind text not null check (kind in ('event', 'todo', 'habit', 'settings')),
  data jsonb not null default '{}'::jsonb,
  deleted boolean not null default false,
  updated_at timestamptz not null,            -- クライアントが変更した時刻（LWW 判定用）
  starts_at timestamptz,                      -- 予定の開始時刻（通知判定用）
  server_updated_at timestamptz not null default now(), -- 差分取得用（サーバー時計）
  primary key (user_id, id)
);

create index if not exists records_pull_idx on public.records (user_id, server_updated_at);
create index if not exists records_starts_idx on public.records (starts_at) where kind = 'event' and not deleted;

-- 古い変更で新しいデータを上書きしない（last-write-wins）＋ server_updated_at を更新
create or replace function public.records_lww() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.updated_at < old.updated_at then
    return null; -- この更新は捨てる
  end if;
  new.server_updated_at := clock_timestamp();
  return new;
end $$;

drop trigger if exists records_lww on public.records;
create trigger records_lww before insert or update on public.records
  for each row execute function public.records_lww();

alter table public.records enable row level security;
drop policy if exists "own records" on public.records;
create policy "own records" on public.records
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Realtime で他端末の変更を受け取る
do $$ begin
  alter publication supabase_realtime add table public.records;
exception when duplicate_object or undefined_object then null;
end $$;

-- Web Push の購読情報（端末ごと）
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;
drop policy if exists "own subscriptions" on public.push_subscriptions;
create policy "own subscriptions" on public.push_subscriptions
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- 送信済み通知（重複送信防止）。Edge Function（service role）だけが使う
create table if not exists public.push_log (
  user_id uuid not null references auth.users (id) on delete cascade,
  event_id text not null,
  offset_min int not null,
  starts_at timestamptz not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, event_id, offset_min, starts_at)
);
alter table public.push_log enable row level security; -- ポリシーなし = クライアントからは触れない
