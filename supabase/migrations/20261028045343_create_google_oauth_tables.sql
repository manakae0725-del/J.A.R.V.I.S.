-- Reconstructed from the linked database catalog on 2026-11-02.
-- The original migration SQL was not recoverable from repository history.
-- Definitions below match the observed columns, constraints, indexes, and
-- server-only access model. OAuth tokens remain encrypted application values.
create table if not exists public.google_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  google_subject text not null,
  google_email text,
  scopes text[] not null default '{}'::text[],
  access_token_ciphertext text,
  refresh_token_ciphertext text,
  token_expires_at timestamptz,
  token_key_version integer not null default 1,
  status text not null default 'connected'
    check (status in ('connected','reauth_required','revoked','error')),
  connected_at timestamptz not null default now(),
  last_used_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint google_connections_user_subject_key unique (user_id, google_subject)
);

create index if not exists google_connections_user_id_idx
  on public.google_connections using btree (user_id);

create table if not exists public.google_oauth_states (
  state_hash text primary key
    check (state_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  requested_scopes text[] not null default '{}'::text[],
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint google_oauth_states_expiry_after_creation check (expires_at > created_at)
);

create index if not exists google_oauth_states_user_id_idx
  on public.google_oauth_states using btree (user_id);
create index if not exists google_oauth_states_expires_at_idx
  on public.google_oauth_states using btree (expires_at);

alter table public.google_connections enable row level security;
alter table public.google_oauth_states enable row level security;
revoke all on public.google_connections, public.google_oauth_states from public, anon, authenticated;
grant all on public.google_connections, public.google_oauth_states to service_role;
