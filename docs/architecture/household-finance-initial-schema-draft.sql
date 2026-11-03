-- Household finance v1 schema draft
-- Target: Supabase project cykqyrlgepzzgktrxhcx
-- Branch: perf/response-speed-memory-cache
-- DRAFT ONLY: do not apply without explicit approval of this exact SQL.
-- No household/member seed rows are inserted by this migration.

begin;

create table public.finance_households (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  timezone text not null default 'Asia/Tokyo',
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id)
);

create table public.finance_household_members (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.finance_households(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete restrict,
  role text not null check (role in ('owner','admin','member','read_only')),
  status text not null default 'active' check (status in ('active','revoked')),
  invited_by uuid references auth.users(id) on delete restrict,
  joined_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, user_id),
  unique (household_id, user_id, id),
  check ((status = 'active' and revoked_at is null) or (status = 'revoked' and revoked_at is not null))
);
create unique index finance_household_one_active_owner
  on public.finance_household_members(household_id)
  where status = 'active' and role = 'owner';

create table public.finance_accounts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.finance_households(id) on delete restrict,
  label text not null check (char_length(btrim(label)) between 1 and 80),
  account_type text not null check (account_type in ('cash','bank','credit_card','e_money','other')),
  owner_user_id uuid,
  is_active boolean not null default true,
  display_order integer not null default 0,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, id),
  foreign key (household_id, owner_user_id)
    references public.finance_household_members(household_id, user_id) on delete restrict
);
create unique index finance_accounts_active_label
  on public.finance_accounts(household_id, lower(label)) where is_active;

create table public.finance_categories (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.finance_households(id) on delete restrict,
  transaction_kind text not null check (transaction_kind in ('income','expense')),
  name text not null check (char_length(btrim(name)) between 1 and 60),
  display_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, id),
  unique (household_id, transaction_kind, name)
);
create unique index finance_categories_name_ci
  on public.finance_categories(household_id, transaction_kind, lower(name));

create table public.finance_documents (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.finance_households(id) on delete restrict,
  uploader_user_id uuid not null,
  subject_user_id uuid,
  document_type text not null check (document_type in ('payslip','receipt','invoice','other')),
  source_attachment_id text,
  status text not null default 'candidate' check (status in ('candidate','confirmed','rejected','expired')),
  linked_transaction_id uuid,
  confirmed_by uuid references auth.users(id) on delete restrict,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  unique (household_id, id),
  foreign key (household_id, uploader_user_id)
    references public.finance_household_members(household_id, user_id) on delete restrict,
  foreign key (household_id, subject_user_id)
    references public.finance_household_members(household_id, user_id) on delete restrict,
  check ((status = 'confirmed' and confirmed_by is not null and confirmed_at is not null)
      or status <> 'confirmed')
);

create table public.finance_transactions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.finance_households(id) on delete restrict,
  kind text not null check (kind in ('income','expense','transfer','refund','adjustment')),
  status text not null default 'planned' check (status in ('planned','confirmed','void')),
  amount_jpy bigint not null check (amount_jpy > 0),
  occurred_on date,
  due_on date,
  confirmed_at timestamptz,
  voided_at timestamptz,
  category_id uuid,
  subject_user_id uuid,
  source_account_id uuid,
  destination_account_id uuid,
  payment_method text check (payment_method in ('cash','bank_transfer','credit_card','debit_card','e_money','other')),
  description text check (description is null or char_length(description) <= 500),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 160),
  reverses_transaction_id uuid,
  source_document_id uuid,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, id),
  unique (household_id, idempotency_key),
  foreign key (household_id, category_id)
    references public.finance_categories(household_id, id) on delete restrict,
  foreign key (household_id, subject_user_id)
    references public.finance_household_members(household_id, user_id) on delete restrict,
  foreign key (household_id, source_account_id)
    references public.finance_accounts(household_id, id) on delete restrict,
  foreign key (household_id, destination_account_id)
    references public.finance_accounts(household_id, id) on delete restrict,
  foreign key (household_id, reverses_transaction_id)
    references public.finance_transactions(household_id, id) on delete restrict,
  check (
    (kind = 'income' and source_account_id is null and category_id is not null)
    or (kind = 'expense' and destination_account_id is null and category_id is not null)
    or (kind = 'transfer' and source_account_id is not null and destination_account_id is not null
        and source_account_id <> destination_account_id and category_id is null and subject_user_id is null)
    or (kind in ('refund','adjustment'))
  ),
  check ((status = 'planned' and confirmed_at is null and voided_at is null)
      or (status = 'confirmed' and occurred_on is not null and confirmed_at is not null and voided_at is null)
      or (status = 'void' and voided_at is not null))
);
create index finance_transactions_household_occurred
  on public.finance_transactions(household_id, occurred_on desc);
create index finance_transactions_planned_due
  on public.finance_transactions(household_id, due_on) where status = 'planned';
create index finance_transactions_kind_status_date
  on public.finance_transactions(household_id, kind, status, occurred_on);
create index finance_transactions_subject_date
  on public.finance_transactions(household_id, subject_user_id, occurred_on desc);

-- Add the reverse document link after both tables exist.
alter table public.finance_documents
  add constraint finance_documents_linked_transaction_fk
  foreign key (household_id, linked_transaction_id)
  references public.finance_transactions(household_id, id) on delete restrict;
alter table public.finance_transactions
  add constraint finance_transactions_source_document_fk
  foreign key (household_id, source_document_id)
  references public.finance_documents(household_id, id) on delete restrict;

create table public.finance_payroll_details (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.finance_households(id) on delete restrict,
  transaction_id uuid not null unique,
  subject_user_id uuid not null,
  pay_period_start date,
  pay_period_end date,
  gross_jpy bigint not null check (gross_jpy >= 0),
  net_jpy bigint not null check (net_jpy > 0),
  expected_pay_date date,
  actual_pay_date date,
  deposit_account_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, id),
  foreign key (household_id, transaction_id)
    references public.finance_transactions(household_id, id) on delete restrict,
  foreign key (household_id, subject_user_id)
    references public.finance_household_members(household_id, user_id) on delete restrict,
  foreign key (household_id, deposit_account_id)
    references public.finance_accounts(household_id, id) on delete restrict,
  check (pay_period_start is null or pay_period_end is null or pay_period_start <= pay_period_end)
);

create table public.finance_payroll_deductions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.finance_households(id) on delete restrict,
  payroll_detail_id uuid not null,
  deduction_code text,
  label text not null check (char_length(btrim(label)) between 1 and 80),
  amount_jpy bigint not null check (amount_jpy >= 0),
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  foreign key (household_id, payroll_detail_id)
    references public.finance_payroll_details(household_id, id) on delete restrict
);

create table public.finance_recurring_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.finance_households(id) on delete restrict,
  kind text not null check (kind in ('income','expense')),
  label text not null check (char_length(btrim(label)) between 1 and 100),
  amount_jpy bigint check (amount_jpy is null or amount_jpy > 0),
  is_estimate boolean not null default false,
  recurrence_rule text not null check (char_length(recurrence_rule) between 1 and 200),
  next_due_on date,
  account_id uuid,
  responsible_user_id uuid,
  is_active boolean not null default true,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, id),
  foreign key (household_id, account_id)
    references public.finance_accounts(household_id, id) on delete restrict,
  foreign key (household_id, responsible_user_id)
    references public.finance_household_members(household_id, user_id) on delete restrict
);

create table public.finance_balance_snapshots (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.finance_households(id) on delete restrict,
  account_id uuid not null,
  balance_jpy bigint not null,
  as_of_at timestamptz not null,
  reported_by uuid not null,
  note text check (note is null or char_length(note) <= 300),
  created_at timestamptz not null default now(),
  foreign key (household_id, account_id)
    references public.finance_accounts(household_id, id) on delete restrict,
  foreign key (household_id, reported_by)
    references public.finance_household_members(household_id, user_id) on delete restrict
);
create index finance_balance_snapshots_latest
  on public.finance_balance_snapshots(household_id, account_id, as_of_at desc);

create table public.finance_audit_events (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.finance_households(id) on delete restrict,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  target_table text not null check (target_table in (
    'finance_households','finance_household_members','finance_accounts','finance_categories',
    'finance_transactions','finance_payroll_details','finance_payroll_deductions',
    'finance_recurring_items','finance_balance_snapshots','finance_documents'
  )),
  target_id uuid not null,
  action text not null check (action in ('created','updated','confirmed','voided','revoked','snapshot_reported')),
  before_data jsonb,
  after_data jsonb,
  reason text check (reason is null or char_length(reason) <= 300),
  created_at timestamptz not null default now()
);
create index finance_audit_events_household_created
  on public.finance_audit_events(household_id, created_at desc);

-- Keep audit history append-only, including against accidental privileged application writes.
create or replace function public.finance_reject_audit_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception 'finance_audit_events is append-only';
end;
$$;
create trigger finance_audit_events_no_update_delete
before update or delete on public.finance_audit_events
for each row execute function public.finance_reject_audit_mutation();

-- Ensure payroll detail always describes a confirmed income ledger entry with matching net pay.
create or replace function public.finance_validate_payroll_detail()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  txn_kind text;
  txn_status text;
  txn_amount bigint;
begin
  select kind, status, amount_jpy
    into txn_kind, txn_status, txn_amount
    from public.finance_transactions
   where household_id = new.household_id and id = new.transaction_id;

  if not found or txn_kind <> 'income' or txn_status <> 'confirmed' or txn_amount <> new.net_jpy then
    raise exception 'Payroll detail must match a confirmed income transaction net amount';
  end if;
  return new;
end;
$$;
create trigger finance_payroll_details_validate
before insert or update on public.finance_payroll_details
for each row execute function public.finance_validate_payroll_detail();

-- Keep payroll ledger invariants valid when the linked transaction is edited later.
create or replace function public.finance_validate_transaction_payroll_link()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $finance$
declare
  payroll_net bigint;
begin
  select net_jpy
    into payroll_net
    from public.finance_payroll_details
   where household_id = old.household_id
     and transaction_id = old.id;

  if found and (
       new.kind <> 'income'
       or new.status <> 'confirmed'
       or new.amount_jpy <> payroll_net
       or new.household_id <> old.household_id
       or new.id <> old.id
     ) then
    raise exception 'Transaction is linked to payroll detail; kind, status, amount, household and id must remain consistent';
  end if;

  return new;
end;
$finance$;
create trigger finance_transactions_validate_payroll_link
before update on public.finance_transactions
for each row execute function public.finance_validate_transaction_payroll_link();

-- Finance tables are server-only. No browser role gets Data API privileges.
alter table public.finance_households enable row level security;
alter table public.finance_household_members enable row level security;
alter table public.finance_accounts enable row level security;
alter table public.finance_categories enable row level security;
alter table public.finance_transactions enable row level security;
alter table public.finance_payroll_details enable row level security;
alter table public.finance_payroll_deductions enable row level security;
alter table public.finance_recurring_items enable row level security;
alter table public.finance_balance_snapshots enable row level security;
alter table public.finance_documents enable row level security;
alter table public.finance_audit_events enable row level security;

revoke all on table
  public.finance_households,
  public.finance_household_members,
  public.finance_accounts,
  public.finance_categories,
  public.finance_transactions,
  public.finance_payroll_details,
  public.finance_payroll_deductions,
  public.finance_recurring_items,
  public.finance_balance_snapshots,
  public.finance_documents,
  public.finance_audit_events
from anon, authenticated;

grant all on table
  public.finance_households,
  public.finance_household_members,
  public.finance_accounts,
  public.finance_categories,
  public.finance_transactions,
  public.finance_payroll_details,
  public.finance_payroll_deductions,
  public.finance_recurring_items,
  public.finance_balance_snapshots,
  public.finance_documents,
  public.finance_audit_events
to service_role;

-- Trigger functions are not intended as callable RPC endpoints.
revoke all on function public.finance_reject_audit_mutation() from public, anon, authenticated;
revoke all on function public.finance_validate_payroll_detail() from public, anon, authenticated;
revoke all on function public.finance_validate_transaction_payroll_link() from public, anon, authenticated;

commit;
