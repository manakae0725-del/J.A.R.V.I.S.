# Household Finance Management — Design

Status: design draft only. No database schema, API, UI, or automation has been deployed.

## Product intent

J.A.R.V.I.S. records, retains, calculates, displays, and answers questions using only information explicitly supplied by the household or extracted from household-provided documents. It is not a bank monitor and must not connect to bank accounts or request banking credentials.

Small differences from real-world balances are acceptable. Safety, explicit provenance, and transparent uncertainty take priority over real-time accuracy.

## Scope

### Phase 1 — Core ledger
- Income: person, source, gross amount, deductions, net amount, expected/pay date, actual receipt date, destination account label, source document reference, status (planned/confirmed).
- Expenses: transaction date, amount, merchant/description, category, payer, payment method, account/card label, notes, status (planned/confirmed).
- Accounts: user-defined display label only, optional opening/baseline balance, reported balance, report timestamp. Never store account number, branch/account identifiers, credentials, card numbers, or authentication data.
- Recurring obligations: label, amount or estimated amount, due date/rule, funding account label, recurrence, active flag.
- Corrections: preserve an audit trail; do not silently overwrite financial facts.

### Phase 2 — Conversational operations
- Natural-language expense and income entry.
- Ask for clarification when amount, date, category, payer, account label, or certainty is ambiguous.
- Confirm parsed values before committing high-impact or ambiguous entries.
- Edit, void, and search entries with ownership checks and an audit trail.
- Prevent duplicate entries using explicit idempotency keys and source references.

### Phase 3 — Payslip and receipt import through J.A.R.V.I.S. chat attachments
- Manato and Kaede each upload their own payslips, receipts, invoices, and supporting images directly from their device through their own authenticated J.A.R.V.I.S. account.
- Google Drive is not the household document intake path. Neither member needs access to the other's Drive, and finance processing must not search either member's Drive.
- Use the generic chat attachment flow: private temporary Storage, signed upload, server-side ownership validation, multimodal Gemini processing, and automatic cleanup.
- Extract payslip gross pay, itemized deductions, net pay, pay period, pay date, and a deposit destination label only when explicitly displayed.
- Extract receipt merchant, transaction date, total, and likely category as candidate fields.
- Identify the salary subject separately from the uploader and the person who confirms the record.
- Treat all extracted values as unverified candidates until the relevant owner reviews and confirms them. Do not create finance records from model extraction alone.
- Store normalized confirmed fields and minimal attachment metadata. Temporary file bytes are deleted after processing unless the user explicitly asks to save the document.
- Both members' confirmed and explicitly shared salary data are household-shared finance data, visible to both active household members. Conversations, personal memories, and unrelated attachments remain private.
- Do not infer a bank account or deposit destination when the document does not explicitly identify one.

### Phase 4 — Balance snapshots and cash-flow forecast
- User reports each account's real balance after the relevant withdrawals; that report becomes a dated baseline snapshot.
- Forecast from the latest reported baseline plus/minus only known, non-duplicated planned and confirmed events after that timestamp.
- Separate actual reported balance from calculated/projected balance.
- Credit-card purchases are expenses when recorded; later card settlement is a transfer/settlement, not a second expense.
- Mark overdue or uncertain events as unconfirmed; never state that a withdrawal actually completed unless the user confirms it.
- Display the baseline timestamp and forecast assumptions with every balance estimate.

### Phase 5 — Analysis and UI
- Monthly income/expense/net totals, category breakdown, month-over-month comparison, account forecast, upcoming payments, and charts.
- Answers must distinguish actual, user-reported, imported-but-unconfirmed, planned, and estimated figures.
- Add a household finance dashboard to the existing J.A.R.V.I.S. UI only after core data and calculations pass tests.

### Phase 6 — Reminders (after core completion)
- At the user-defined final monthly withdrawal/check date, send a reminder asking the user to report each account's balance.
- This is a scheduled reminder, not a bank event detector.
- Use the existing background-task/notification architecture only after verifying its scheduling and delivery semantics. Do not create a new API function if it would exceed the Vercel Hobby 12-function limit.
- Require explicit user configuration for reminder day/time, timezone, and target account labels.

## Security and data rules

- No bank integrations, bank scraping, account credentials, account numbers, card numbers, or automatic transaction retrieval.
- All household finance tables must use strict authenticated ownership/household access controls and RLS. Do not copy broad policies from unrelated tables.
- Server-side access only where appropriate; never expose service-role/secret keys to the browser.
- Validate currency as integer yen; reject negative amounts unless represented as a typed refund/adjustment.
- Use immutable event history or explicit correction records for financial edits.
- Minimize salary/receipt document retention; retain only confirmed normalized data and minimal source metadata unless the user explicitly chooses otherwise.
- No Production deployment or live database migration without separate explicit approval.

## Verified implementation baseline (2026-11-03)

- Supabase project is active on PostgreSQL 17.6.1.
- Current public tables are limited to J.A.R.V.I.S. memories, API usage/rate limits, Google OAuth connections/state, and background tasks/steps/events. No household-finance tables exist.
- Existing public tables have RLS enabled; the current `pg_policies` inspection returned no public-table policies. Existing application access is server-side and uses the Supabase secret key. Finance operations must therefore perform explicit household authorization in the server layer and must never expose the secret key.
- Supabase Auth currently contains two users. This confirms two accounts exist, but does not by itself confirm which account belongs to which household member or whether both are allowlisted by the current J.A.R.V.I.S. deployment.
- Current API authentication validates the bearer token with Supabase Auth and then checks `JARVIS_ALLOWED_USER_IDS`. Household membership must be checked separately after authentication; allowlisting alone is not household authorization.
- No database schema, migration, finance API, or UI has been created for this feature.
- Supabase changed Data API exposure defaults: new public tables are not automatically exposed to the Data API. Keep finance tables server-only unless a later design explicitly requires client access, and verify grants/settings before enabling any exposure.

## Proposed logical data model (design only; not SQL)

1. `finance_households`: household identity, display name, timezone (default Asia/Tokyo), created_by.
2. `finance_household_members`: household_id, auth user_id, role, active/revoked status, invited_by, joined_at. Unique active membership per user/household. This is the authoritative sharing boundary.
3. `finance_accounts`: household_id, user-defined display label, account type (cash/bank/card/e-money/other), currency (JPY), active flag. No account numbers or credentials.
4. `finance_categories`: household_id, transaction kind, category name, display order, active flag. Seed common categories but allow household customization.
5. `finance_transactions`: household_id, type (income/expense/transfer/refund/adjustment), positive integer amount_jpy, transaction/due dates, category, payer/recipient member, source and destination account labels, payment method, planned/confirmed/void status, description, idempotency key, created_by, source document reference.
6. `finance_payroll_details`: transaction_id, salary subject member, pay period, gross amount, itemized deductions (structured JSON or child rows), net amount, expected pay date, actual receipt date. The ledger cash-flow amount is the confirmed net amount; gross and deductions remain separately analyzable.
7. `finance_recurring_items`: household_id, income/expense type, label, amount or estimate, recurrence rule, next due date, account, responsible member, active flag.
8. `finance_balance_snapshots`: household_id, account_id, reported integer balance, as-of timestamp, reported_by, note. Snapshots are immutable; a new report creates a new row.
9. `finance_documents`: household_id, uploader user_id, document subject member, document type, minimal source metadata, parse/confirmation status, linked transaction_id, confirmed_by/at. Do not store file bytes or full extracted OCR text by default.
10. `finance_audit_events`: household_id, actor user_id, target table/row, action, before/after minimal JSON, reason, created_at. Append-only; corrections and voids are new events, not silent destructive edits.

### Core relationship and accounting rules

- Every finance row is household-scoped. The server derives the caller from the validated Supabase session and checks active membership on every operation. Never trust client-supplied user_id, household_id, role, created_by, or visibility.
- Manato and Kaede remain separate Auth users. Their household membership grants access to shared finance rows; it does not grant access to each other's conversations, memories, Google connections, or unrelated files.
- Member identity (who the income/expense belongs to) is distinct from the actor (who entered or confirmed it).
- Use positive integer yen amounts; the transaction type determines the accounting direction. Refunds and corrections are explicit typed records.
- Transfers are linked source/destination account movements and are excluded from income/expense totals. Credit-card purchases count as expenses; later card settlement is a transfer/settlement, not a second expense.
- A salary record's cash-flow amount is net pay. Gross pay and deductions are retained as payroll detail for analysis.
- Planned, confirmed, imported-unconfirmed, and voided records must remain distinguishable in queries and UI.
- Balance snapshots are reported facts. Forecasts are calculated separately from the latest snapshot and future known events.


1. `finance_people`: household members / payer identity.
2. `finance_accounts`: display labels and account type only; no bank identifiers.
3. `finance_transactions`: income, expense, transfer, refund, adjustment; amount, date, category, person, account/card label, status, source, idempotency key.
4. `finance_recurring_items`: recurring income and obligations.
5. `finance_balance_snapshots`: manually reported account balance and as-of timestamp.
6. `finance_documents`: uploader, document subject/person, document type, temporary attachment reference or minimal saved-file metadata, parse status, confirmation metadata; no PDF/image binary in the database.
7. `finance_audit_log`: append-only record of creation, confirmation, correction, and voiding.

Final schema must be reconciled with existing auth/user model and current Supabase RLS patterns before any migration.

## Accounting invariants

- A transfer between household accounts is not income or expense.
- Credit-card purchase is counted once as an expense; card repayment is a settlement/transfer.
- Salary is counted as household income using the confirmed net deposit amount for cash-flow; gross and deductions remain available for analysis.
- Both household members' confirmed salary figures are shared with both active members.
- Planned and confirmed amounts are never mixed without labels.
- A balance forecast is an estimate, not a bank balance.
- Every answer involving balances states the last user-reported baseline date.

## Implementation gates

Before coding:
1. Inspect the full current branch source, existing chat attachment implementation, and current auth/user model.
2. Inspect private Storage bucket configuration, signed-upload handling, object ownership validation, Gemini multimodal handling, and cleanup behavior.
3. Confirm separate authenticated accounts and shared household access (decision confirmed).
4. Design RLS policies and tests.
5. Check Vercel function count before adding endpoints.

Before database changes:
1. Produce migration SQL and explain every table/policy.
2. Test against a non-production database or isolated test schema.
3. Obtain explicit user approval for live Supabase migration.

Before release:
1. Unit/integration tests for calculations, duplicate prevention, card settlement, corrections, permissions, attachment ownership, and cleanup.
2. Verify no secrets, attachment contents, OCR text, or sensitive payroll values enter logs.
3. Deploy Preview only; do not merge to main or deploy Production without explicit approval.
