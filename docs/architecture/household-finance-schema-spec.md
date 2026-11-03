# Household Finance — Database Schema Specification

Date: 2026-11-03
Branch: `perf/response-speed-memory-cache`
Status: proposed schema only. This document does not apply SQL or modify the live Supabase project.

## 1. Design decisions

- Use 11 normalized tables in the existing `public` schema to preserve compatibility with the current server-side Supabase REST access pattern.
- Keep every finance table server-only: enable RLS, revoke all table privileges from `anon` and `authenticated`, do not add them to Realtime publication, and do not expose them to browser code.
- The application server currently uses the Supabase secret key for database REST access. That key bypasses RLS; therefore every finance operation must first run explicit application-level household membership authorization. RLS is defense in depth, not the authorization mechanism for privileged server calls.
- No direct browser database access, no client-side finance writes, and no public RPC/SECURITY DEFINER functions.
- UUID primary keys; `timestamptz` for event times; `date` for accounting dates; `bigint` for yen.
- Transaction amounts are strictly positive. The transaction type determines accounting meaning. Balance snapshots may be signed to represent asset/liability balance semantics.
- Do not store account numbers, card numbers, bank identifiers, credentials, full OCR text, or uploaded binary documents.

## 2. Tables and columns

### 2.1 `finance_households`
| Column | Type | Rules |
|---|---|---|
| id | uuid | PK, gen_random_uuid() |
| name | text | NOT NULL, trimmed, 1–80 chars |
| timezone | text | NOT NULL, default `Asia/Tokyo`; validate against supported IANA timezone names in application |
| created_by | uuid | NOT NULL, references auth.users(id), ON DELETE RESTRICT |
| created_at | timestamptz | NOT NULL, default now() |
| updated_at | timestamptz | NOT NULL, default now() |

One household initially. Multi-household support is retained for isolation tests and future expansion.

### 2.2 `finance_household_members`
| Column | Type | Rules |
|---|---|---|
| id | uuid | PK |
| household_id | uuid | NOT NULL, FK households(id), ON DELETE RESTRICT |
| user_id | uuid | NOT NULL, FK auth.users(id), ON DELETE RESTRICT |
| role | text | NOT NULL, CHECK in owner/admin/member/read_only |
| status | text | NOT NULL, CHECK in active/revoked |
| invited_by | uuid | nullable FK auth.users(id) |
| joined_at | timestamptz | NOT NULL, default now() |
| revoked_at | timestamptz | nullable |
| created_at | timestamptz | NOT NULL, default now() |
| updated_at | timestamptz | NOT NULL, default now() |

- Unique `(household_id, user_id)`; reactivation updates the existing membership row and records an audit event rather than inserting duplicates.
- Exactly one active owner per household, enforced by a partial unique index on `household_id WHERE status='active' AND role='owner'`.
- First version uses controlled admin-side provisioning; no email invitations or self-service household creation.
- Authorization always checks `status='active'` and the required role.

### 2.3 `finance_accounts`
| Column | Type | Rules |
|---|---|---|
| id | uuid | PK |
| household_id | uuid | NOT NULL, FK households(id) |
| label | text | NOT NULL, trimmed, 1–80 chars |
| account_type | text | NOT NULL, CHECK in cash/bank/credit_card/e_money/other |
| owner_user_id | uuid | nullable; FK to member by composite (household_id,user_id) |
| is_active | boolean | NOT NULL, default true |
| display_order | integer | NOT NULL, default 0 |
| created_by | uuid | NOT NULL, FK auth.users(id) |
| created_at | timestamptz | NOT NULL, default now() |
| updated_at | timestamptz | NOT NULL, default now() |

- Unique `(household_id, id)` for composite references and unique active label `(household_id, lower(label)) WHERE is_active`.
- Labels only. No bank name/branch/number, card number, login, or credential fields.
- For credit-card accounts, reported balance is the amount owed (positive liability); purchases increase the liability and settlement transfers reduce it.

### 2.4 `finance_categories`
| Column | Type | Rules |
|---|---|---|
| id | uuid | PK |
| household_id | uuid | NOT NULL, FK households(id) |
| transaction_kind | text | NOT NULL, CHECK in income/expense |
| name | text | NOT NULL, trimmed, 1–60 chars |
| display_order | integer | NOT NULL, default 0 |
| is_active | boolean | NOT NULL, default true |
| created_at | timestamptz | NOT NULL, default now() |
| updated_at | timestamptz | NOT NULL, default now() |

Unique `(household_id, transaction_kind, lower(name))`. Categories are not used to classify transfers or adjustments.

### 2.5 `finance_transactions`
| Column | Type | Rules |
|---|---|---|
| id | uuid | PK |
| household_id | uuid | NOT NULL, FK households(id) |
| kind | text | NOT NULL, CHECK in income/expense/transfer/refund/adjustment |
| status | text | NOT NULL, CHECK in planned/confirmed/void |
| amount_jpy | bigint | NOT NULL, CHECK > 0 |
| occurred_on | date | nullable for planned items until date is known |
| due_on | date | nullable |
| confirmed_at | timestamptz | nullable; required when status=confirmed |
| voided_at | timestamptz | nullable; required when status=void |
| category_id | uuid | nullable; composite FK to category in same household |
| subject_user_id | uuid | nullable; composite FK to household member; person the income/expense belongs to |
| source_account_id | uuid | nullable; composite FK to account in same household |
| destination_account_id | uuid | nullable; composite FK to account in same household |
| payment_method | text | nullable, CHECK in cash/bank_transfer/credit_card/debit_card/e_money/other |
| description | text | nullable, max 500 chars |
| idempotency_key | text | NOT NULL, 8–160 chars |
| reverses_transaction_id | uuid | nullable; FK to transaction in same household |
| source_document_id | uuid | nullable; FK to finance_documents in same household |
| created_by | uuid | NOT NULL, FK auth.users(id) |
| created_at | timestamptz | NOT NULL, default now() |
| updated_at | timestamptz | NOT NULL, default now() |

Constraints and semantics:
- Unique `(household_id, idempotency_key)`.
- Income: category and destination account may be set; source account must be null.
- Expense: category and source account may be set; destination account must be null.
- Transfer: source and destination accounts are both required and must differ; category and subject are null.
- Refund: must reference an original confirmed expense; it reduces net expense totals and is never silently treated as income.
- Adjustment: account correction only; excluded from income/expense totals and requires an audit reason. Do not use it to disguise ordinary income/expense.
- Planned transactions may have a due date and no occurred date. Confirmed transactions require `occurred_on` and `confirmed_at`. Voided rows remain stored and require `voided_at`.
- The server creates and updates these rows only after membership/role checks. Client-supplied `household_id`, `subject_user_id`, `created_by`, status transitions, and confirmation timestamps are never trusted.
- Confirmed financial facts are not hard-deleted. Corrections use a void/replacement or typed adjustment with audit reason.
- Indexes: `(household_id, occurred_on DESC)`, `(household_id, due_on) WHERE status='planned'`, `(household_id, kind, status, occurred_on)`, `(household_id, subject_user_id, occurred_on DESC)`.

### 2.6 `finance_payroll_details`
| Column | Type | Rules |
|---|---|---|
| id | uuid | PK |
| household_id | uuid | NOT NULL |
| transaction_id | uuid | NOT NULL, unique; composite FK to transaction in same household |
| subject_user_id | uuid | NOT NULL; composite FK to household member |
| pay_period_start | date | nullable |
| pay_period_end | date | nullable |
| gross_jpy | bigint | NOT NULL, CHECK >= 0 |
| net_jpy | bigint | NOT NULL, CHECK > 0 |
| expected_pay_date | date | nullable |
| actual_pay_date | date | nullable |
| deposit_account_id | uuid | nullable; composite FK to account in same household |
| created_at | timestamptz | NOT NULL, default now() |
| updated_at | timestamptz | NOT NULL, default now() |

- Linked transaction must be an income transaction.
- `net_jpy = finance_transactions.amount_jpy`; enforce through a transaction-safe database trigger or a single server-side transaction/RPC. Do not rely on two independent client requests.
- The payroll subject is the salary recipient, not necessarily the uploader or confirmer.
- Payroll detail is created only when the owner confirms the payslip candidate.

### 2.7 `finance_payroll_deductions`
| Column | Type | Rules |
|---|---|---|
| id | uuid | PK |
| household_id | uuid | NOT NULL |
| payroll_detail_id | uuid | NOT NULL; composite FK to payroll detail |
| deduction_code | text | nullable, normalized code if known |
| label | text | NOT NULL, 1–80 chars |
| amount_jpy | bigint | NOT NULL, CHECK >= 0 |
| display_order | integer | NOT NULL, default 0 |
| created_at | timestamptz | NOT NULL, default now() |

- Child rows are used instead of JSONB so deductions can be queried and aggregated safely.
- Sum of deduction rows should reconcile with gross minus net. Because some payslips include non-deduction adjustments or rounding, enforce reconciliation in application confirmation logic and record any explicitly identified non-deduction adjustment separately; do not silently force equality.
- No raw OCR strings or full payslip text in this table.

### 2.8 `finance_recurring_items`
| Column | Type | Rules |
|---|---|---|
| id | uuid | PK |
| household_id | uuid | NOT NULL, FK households(id) |
| kind | text | NOT NULL, CHECK in income/expense |
| label | text | NOT NULL, 1–100 chars |
| amount_jpy | bigint | nullable, CHECK > 0 when present |
| is_estimate | boolean | NOT NULL, default false |
| recurrence_rule | text | NOT NULL, constrained application-level recurrence syntax; do not accept arbitrary executable expressions |
| next_due_on | date | nullable |
| account_id | uuid | nullable; composite FK to account |
| responsible_user_id | uuid | nullable; composite FK to household member |
| is_active | boolean | NOT NULL, default true |
| created_by | uuid | NOT NULL, FK auth.users(id) |
| created_at | timestamptz | NOT NULL, default now() |
| updated_at | timestamptz | NOT NULL, default now() |

Recurring definitions generate candidate/planned transactions; they are not themselves actual ledger events. Generation must be idempotent per recurring item and due date.

### 2.9 `finance_balance_snapshots`
| Column | Type | Rules |
|---|---|---|
| id | uuid | PK |
| household_id | uuid | NOT NULL |
| account_id | uuid | NOT NULL; composite FK to account |
| balance_jpy | bigint | NOT NULL; signed allowed |
| as_of_at | timestamptz | NOT NULL |
| reported_by | uuid | NOT NULL; composite FK to household member |
| note | text | nullable, max 300 chars |
| created_at | timestamptz | NOT NULL, default now() |

- Append-only: a new report creates a new snapshot; never overwrite an earlier reported balance.
- Index `(household_id, account_id, as_of_at DESC)`.
- Forecasts are calculated separately from the latest snapshot and subsequent known events. Forecast output is never persisted as a reported balance.

### 2.10 `finance_documents`
| Column | Type | Rules |
|---|---|---|
| id | uuid | PK |
| household_id | uuid | NOT NULL |
| uploader_user_id | uuid | NOT NULL; composite FK to household member |
| subject_user_id | uuid | nullable; composite FK to household member |
| document_type | text | NOT NULL, CHECK in payslip/receipt/invoice/other |
| source_attachment_id | text | nullable; opaque attachment reference, never arbitrary Storage path |
| status | text | NOT NULL, CHECK in candidate/confirmed/rejected/expired |
| linked_transaction_id | uuid | nullable; composite FK to transaction |
| confirmed_by | uuid | nullable; FK auth.users(id) |
| confirmed_at | timestamptz | nullable |
| created_at | timestamptz | NOT NULL, default now() |
| expires_at | timestamptz | nullable |

- Store minimal metadata only. Do not store file bytes, signed URLs, full OCR text, or unredacted model output.
- The application verifies the source attachment belongs to the authenticated uploader before parsing. The attachment reference is not itself an authorization token.
- Keep confirmed normalized payroll/receipt data in the appropriate finance tables; document metadata is provenance only.
- Default retention is metadata-only with an expiry policy. The source attachment bytes remain governed by the existing temporary attachment cleanup flow.

### 2.11 `finance_audit_events`
| Column | Type | Rules |
|---|---|---|
| id | uuid | PK |
| household_id | uuid | NOT NULL, FK households(id) |
| actor_user_id | uuid | NOT NULL, FK auth.users(id) |
| target_table | text | NOT NULL, allowlisted table name |
| target_id | uuid | NOT NULL |
| action | text | NOT NULL, CHECK in created/updated/confirmed/voided/revoked/snapshot_reported |
| before_data | jsonb | nullable; allowlisted, minimized fields only |
| after_data | jsonb | nullable; allowlisted, minimized fields only |
| reason | text | nullable, max 300 chars |
| created_at | timestamptz | NOT NULL, default now() |

- Append-only. Application role must not expose update/delete operations. Add a trigger rejecting UPDATE/DELETE as defense in depth.
- Do not include credentials, account identifiers, attachment bytes, signed URLs, full OCR text, or unnecessary sensitive fields in JSON.
- Record who acted, not merely which household member the transaction concerns.

## 3. Cross-table integrity

- Add composite unique keys `(household_id, id)` to parent tables and composite foreign keys from all household-scoped child tables. This prevents accidental cross-household references even if an application query omits a predicate.
- Add a composite foreign key from member references to `finance_household_members(household_id,user_id)`.
- Use `ON DELETE RESTRICT` for financial records. No cascade deletion of households, members, accounts, transactions, payroll, snapshots, or audit history.
- Household membership revocation changes status and records an audit event; it does not delete data.
- Category/account deactivation is preferred to deletion once referenced.
- Use database constraints for basic invariants and server-side transaction logic for multi-row accounting invariants.

## 4. Access-control design

### Browser roles
- RLS enabled on every finance table.
- Revoke all privileges on all finance tables from `anon` and `authenticated`.
- No policies granting browser access; no Data API grants, no Realtime publication, no public views, no public RPC.
- Verify actual grants and Data API exposure settings after migration. RLS and Data API exposure are separate controls.

### Application server
- Authenticate with existing `requireAuth`; it returns the validated Supabase Auth user after checking `JARVIS_ALLOWED_USER_IDS`.
- Add a shared `requireHouseholdAccess(user, householdId, capability)` helper. It must query membership using the server secret key and require `status='active'`; role/capability mapping is explicit.
- Never derive authorization from client-supplied user ID, role, owner, or membership status.
- Because secret/service role access bypasses RLS, every handler and internal helper must call the household guard before any finance data read/write. No direct unguarded PostgREST calls from feature handlers.
- Use one server-side database transaction for multi-row writes (transaction + payroll details + deductions + audit event). If PostgREST cannot guarantee atomicity for the chosen operation, use a narrowly scoped database function with a fixed search_path and carefully reviewed grants; do not create a SECURITY DEFINER function in the exposed public schema.
- Do not send service-role/secret keys to the browser or include them in logs.

### Initial role matrix
| Capability | owner | admin | member | read_only |
|---|---:|---:|---:|---:|
| Read shared household finance | yes | yes | yes | yes |
| Create planned/confirmed records | yes | yes | yes | no |
| Confirm own payslip | yes | yes | yes | no |
| Confirm another member's payslip | yes | yes | no | no |
| Correct/void records | yes | yes | request only | no |
| Manage accounts/categories/recurring items | yes | yes | no | no |
| Manage membership | yes | no | no | no |
| Revoke owner / delete household | no self-service | no | no | no |

All capabilities are checked server-side. The initial two-person household may use owner/member roles only; the full matrix is reserved for future expansion.

## 5. Accounting rules

- Income totals use confirmed income transaction amounts. For payroll, that amount equals net pay, never gross pay.
- Expense totals use confirmed expenses minus linked confirmed refunds.
- Transfers and adjustments are excluded from income and expense totals.
- Planned records are shown separately and excluded from actual totals.
- Imported candidates are not transactions and are excluded from all ledger totals.
- Card purchases are expenses against the credit-card account. Card repayment is a transfer from the funding account to the credit-card account.
- Reported balances are immutable snapshots. Forecasts use the latest snapshot plus/minus confirmed and eligible planned movements after the snapshot timestamp; each forecast states its baseline timestamp and assumptions.
- A void does not erase history; voided records are excluded from current totals and remain visible in audit history.

## 6. Migration and verification gates

Before live migration:
1. Review the final SQL, including all composite foreign keys, partial unique indexes, RLS, grants, and append-only enforcement.
2. Test migration in an isolated/non-production database or test schema.
3. Test two-user sharing, cross-household denial, revoked membership, browser-role denial, and server-side authorization bypass attempts.
4. Test payroll reconciliation, transfer/card settlement, refunds, idempotency, corrections, and snapshots.
5. Run Supabase security and performance advisors.
6. Obtain explicit user approval for the exact migration SQL and target project.

No SQL has been applied. No tables, policies, grants, functions, Storage buckets, or API routes have been created for household finance.
