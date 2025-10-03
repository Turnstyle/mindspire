-- Store OAuth tokens without Vault
create table if not exists user_token (
  user_id uuid primary key references app_user(id) on delete cascade,
  access_token text,
  refresh_token text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_user_token_updated_at on user_token;
create trigger set_user_token_updated_at
before update on user_token
for each row execute function public.set_updated_at();

alter table user_credentials
  alter column google_access_token_vault_id drop not null;
