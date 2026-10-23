-- notify-kit setup. Safe to run more than once. Run in Supabase: SQL Editor -> New query -> paste -> Run.
-- It ONLY creates tables prefixed "notify_". It never touches, alters or drops public.users or any of your tables.
-- user_id is TEXT so it works with uuid ids (Supabase Auth) or any id type you use. No foreign key to your users
-- table on purpose: this avoids conflicts with whatever schema it has.

create extension if not exists pgcrypto;

create table if not exists public.notify_preferences (
  user_id              text primary key,
  email                text,                                  -- optional fallback address (set from your server only)
  in_app_enabled       boolean not null default true,
  email_transactional  boolean not null default true,
  email_marketing      boolean not null default false,        -- marketing is OPT-IN
  marketing_consent_at timestamptz,
  updated_at           timestamptz not null default now()
);

create table if not exists public.notify_broadcasts (
  id               uuid primary key default gen_random_uuid(),
  idempotency_key  text not null unique,
  type             text,
  category         text not null check (category in ('transactional','marketing')),
  title            text not null,
  created_at       timestamptz not null default now()
);

create table if not exists public.notify_notifications (
  id               uuid primary key default gen_random_uuid(),
  user_id          text not null,
  type             text,
  category         text not null check (category in ('transactional','marketing')),
  title            text not null check (char_length(title) <= 200),
  body             text not null check (char_length(body) <= 2000),
  link             text,
  idempotency_key  text,
  broadcast_id     uuid references public.notify_broadcasts(id) on delete set null,
  hidden           boolean not null default false,            -- true = user turned in-app off (row kept for email tracking)
  read_at          timestamptz,
  created_at       timestamptz not null default now(),
  unique (user_id, idempotency_key)                           -- duplicate sends with the same key are impossible
);
create index if not exists notify_notifications_inbox_idx on public.notify_notifications (user_id, created_at desc);

create table if not exists public.notify_deliveries (
  id               uuid primary key default gen_random_uuid(),
  notification_id  uuid not null references public.notify_notifications(id) on delete cascade,
  channel          text not null check (channel in ('email')),
  status           text not null default 'pending' check (status in ('pending','sending','sent','failed','skipped')),
  attempts         integer not null default 0,
  claimed_at       timestamptz,
  last_error       text,
  sent_at          timestamptz,
  created_at       timestamptz not null default now(),
  unique (notification_id, channel)
);

-- ---------- Row Level Security ----------
alter table public.notify_preferences   enable row level security;
alter table public.notify_broadcasts    enable row level security;
alter table public.notify_notifications enable row level security;
alter table public.notify_deliveries    enable row level security;

-- Browser roles get nothing by default. The kit's server uses the service-role key, which bypasses RLS.
revoke all on public.notify_preferences, public.notify_broadcasts, public.notify_notifications, public.notify_deliveries from anon, authenticated;

-- OPTIONAL defence in depth: lets a signed-in Supabase Auth user read their OWN rows directly.
-- (The React kit talks to your server instead, so you can delete this block if you don't want direct access.)
grant select on public.notify_notifications to authenticated;
grant update (read_at) on public.notify_notifications to authenticated;   -- only the read flag, nothing else
grant select on public.notify_preferences to authenticated;

drop policy if exists notify_notifications_select_own on public.notify_notifications;
create policy notify_notifications_select_own on public.notify_notifications
  for select to authenticated using (user_id = auth.uid()::text and hidden = false);

drop policy if exists notify_notifications_mark_read_own on public.notify_notifications;
create policy notify_notifications_mark_read_own on public.notify_notifications
  for update to authenticated using (user_id = auth.uid()::text) with check (user_id = auth.uid()::text);

drop policy if exists notify_preferences_select_own on public.notify_preferences;
create policy notify_preferences_select_own on public.notify_preferences
  for select to authenticated using (user_id = auth.uid()::text);
-- notify_deliveries and notify_broadcasts have NO policies: only the server (service role) can touch them.
