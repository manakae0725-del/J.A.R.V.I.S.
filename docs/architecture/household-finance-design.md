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

### Phase 3 — Payslip PDF import from Manato's Google Drive
- Manato's connected Google Drive is the household's designated payslip document source. Kaede does not need to connect her own Drive.
- Kaede gives her payslip PDF to Manato; Manato stores both his own and Kaede's payslip PDFs in his designated Drive folder.
- Search only that designated folder or an explicitly selected file. Do not search unrelated Drive files.
- Extract PDF text; use OCR only when the PDF is image-only.
- Parse gross pay, itemized deductions, net pay, pay period, pay date, and any displayed deposit destination.
- Identify whose payslip it is separately from who owns the Drive file. Treat parsed fields as unverified until checked/confirmed.
- Store normalized fields and Drive file ID/link metadata; do not duplicate the PDF into the database.
- Do not infer a bank account when the payslip does not explicitly identify one.
- Both Manato's and Kaede's confirmed salary data are household-shared finance data, visible to both active household members. Do not classify household salary figures as private by default.
- Keep the original PDF accessible only through Manato's authorized Drive connection; sharing parsed household data does not copy the file or change Drive permissions.

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
- Minimize salary PDF retention; retain only the source reference and confirmed normalized data unless the user explicitly chooses otherwise.
- No Production deployment or live database migration without separate explicit approval.

## Suggested logical data model (not SQL)

1. `finance_people`: household members / payer identity.
2. `finance_accounts`: display labels and account type only; no bank identifiers.
3. `finance_transactions`: income, expense, transfer, refund, adjustment; amount, date, category, person, account/card label, status, source, idempotency key.
4. `finance_recurring_items`: recurring income and obligations.
5. `finance_balance_snapshots`: manually reported account balance and as-of timestamp.
6. `finance_documents`: Drive file ID, Drive owner, payslip subject/person, document type, parse status, confirmation metadata; no PDF binary.
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
1. Inspect the full current branch source and current auth/user model.
2. Inspect Manato's existing Google Drive scopes and file-download implementation.
3. Confirm separate authenticated accounts and shared household access (decision confirmed).
4. Design RLS policies and tests.
5. Check Vercel function count before adding endpoints.

Before database changes:
1. Produce migration SQL and explain every table/policy.
2. Test against a non-production database or isolated test schema.
3. Obtain explicit user approval for live Supabase migration.

Before release:
1. Unit/integration tests for calculations, duplicate prevention, card settlement, corrections, and permissions.
2. Verify no secrets or PDF contents enter logs.
3. Deploy Preview only; do not merge to main or deploy Production without explicit approval.
