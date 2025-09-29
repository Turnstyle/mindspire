-- Bootstrap core tables for Mindspire MVP. These statements are idempotent
-- so they can run safely where the schema already exists.

create table if not exists app_user (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  partner_user_id uuid references app_user(id) on delete set null,
  tz text not null,
  created_at timestamptz not null default now()
);

create table if not exists user_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_user(id) on delete cascade,
  google_access_token_vault_id uuid not null,
  google_refresh_token_vault_id uuid,
  needs_reauth boolean not null default false,
  last_history_id text
);

create table if not exists invite (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_user(id) on delete cascade,
  gmail_thread_id text not null,
  gmail_message_id text not null,
  source_subject text,
  parsed jsonb not null,
  status text not null default 'pending',
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists digest (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_user(id) on delete cascade,
  sent_at timestamptz not null,
  token text not null,
  items jsonb not null
);
