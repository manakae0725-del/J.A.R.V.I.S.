# Household Finance — Source Review and Implementation Plan

Review date: 2026-11-03
Branch: `perf/response-speed-memory-cache`
Status: design and schema specification; no household-finance application code or live database changes have been made.

## Verified current architecture

### Authentication
- API routes call `requireAuth` in `api/_auth.js`.
- `requireAuth` validates the Supabase bearer token using `/auth/v1/user`.
- Access is then restricted by `JARVIS_ALLOWED_USER_IDS`. A second Supabase Auth account cannot use J.A.R.V.I.S. until its user ID is explicitly allowlisted.
- This allowlist is application access control, not household membership authorization.
- Finance authorization must derive the caller from the validated user object and check an active membership row for every finance operation. Never trust request-supplied user IDs, roles, or household IDs as authorization evidence.

### Chat attachments — current implementation status
- The chat composer supports image, PDF, and plain-text attachments, up to 5 files and 20 MB total.
- The attachment UI and request flow are implemented on the current development branch. An iPhone layout issue with long filenames hiding the remove control was fixed in commit `6f9e5d1c3a8418b91755170d8f1610ec76572bcf`; the user elected to skip further attachment-specific testing after the fix.
- Video attachment support is not implemented and is explicitly deferred.
- The generic attachment flow is distinct from finance import: the presence of a file in chat does not create or confirm a finance record.
- The finance importer must use only the authenticated uploader's attachment and must require the relevant salary owner / expense confirmer to approve extracted candidate fields before ledger writes.
- Keep source document bytes temporary by default. Persist only minimal metadata when a confirmed finance record needs provenance, unless the user explicitly requests document retention.

### Serverless/API constraints
- The Vercel Hobby deployment limit is 12 Serverless Functions. The exact current deployed function count must be measured from the source tree/deployment before implementation.
- Prefer extending an existing authenticated route with a strict action allowlist and a shared server-side finance module.
- Do not add a new `api/**` route until the exact function count and route build behavior are confirmed.
- Do not place financial persistence in the browser or personal-memory records.

### Database and existing data access
- Existing app server code accesses Supabase using the server-side secret key through REST calls.
- The current auth helper validates the session with the public/anon or publishable key, then enforces the server-side allowlist.
- Finance tables are planned in `public` for compatibility with the existing server-side REST access pattern, but must have RLS enabled and no grants to `anon` or `authenticated`. They are server-only; do not expose them through Data API or Realtime.
- Because the server-side secret key bypasses RLS, RLS alone does not authorize finance requests. A shared server helper must explicitly check active household membership on every operation before any finance read or write.
- No finance schema, migration, API, or UI exists yet. No live database changes are authorized by this planning step.

## Confirmed product decisions

- Manato and Kaede use separate J.A.R.V.I.S. accounts.
- One shared household finance space is accessible to both active members.
- Both members' confirmed salary data, income, expenses, account labels, balances, recurring obligations, and reports are shared.
- Each person uploads their own files/images through their own authenticated J.A.R.V.I.S. session. Google Drive is not the household document intake path.
- Parsed payslip values remain unconfirmed until the salary owner checks and confirms them. Confirmed and explicitly shared salary data becomes visible to both active household members.
- Conversations, personal memories, Google connections, and unrelated attachments remain private.
- No bank login, account numbers, card numbers, credentials, scraping, or automatic bank transactions.
- No Production deploy, main merge, or live database migration without separate explicit approval.

## Proposed implementation sequence

### Gate 1 — Household identity and membership
1. Manato is the proposed initial household owner.
2. Initial Kaede membership will be provisioned by a controlled server/admin-side operation after her J.A.R.V.I.S. Supabase Auth user ID is verified. Do not ask for or exchange passwords, access tokens, or session cookies.
3. Do not implement email invitations or public self-service household creation in the first version. This avoids introducing invitation-token and account-enumeration risks before the core ledger exists.
4. Implement a shared server-side helper that receives only the validated auth user object, loads the household membership, and checks active status and role for the requested operation.
5. The client must not choose or spoof `created_by`, owner identity, membership role, or the authenticated member identity.
6. Add two-user/two-household permission tests before enabling finance operations.

### Gate 2 — Finance storage and ledger
1. Use the detailed schema specification in `docs/architecture/household-finance-schema-spec.md`.
2. Use positive integer JPY transaction amounts; use signed integer values only for account balance snapshots.
3. Keep payroll gross pay, net pay, and itemized deductions normalized; the ledger income amount must equal confirmed net pay.
4. Planned and confirmed transactions are separate states. Parsed but unconfirmed values remain document candidates and are not ledger transactions.
5. Transfers are linked source/destination account movements and excluded from income/expense totals. Card purchases are expenses; later card repayment is a transfer.
6. Corrections and voids must preserve audit history. Use idempotency keys to prevent duplicate writes.
7. Produce migration SQL and a security review for approval before touching the live Supabase project.

### Gate 3 — Conversational entry and reporting
1. Extend the existing conversation route with a finance-intent contract and strict operation schema.
2. Ask for clarification when amount, date, payer, category, payment method, account label, or certainty is ambiguous.
3. Require explicit confirmation before committing inferred or bulk operations.
4. Implement correction, void, search, monthly summaries, category aggregates, and chart-ready data.
5. Keep credit-card purchases and later settlement from being counted twice.

### Gate 4 — Finance import through chat attachments
1. Reuse the existing image/PDF/text chat attachment flow; do not build a second upload subsystem.
2. The finance-specific server path must revalidate the authenticated uploader and attachment ownership before parsing.
3. Parse gross pay, itemized deductions, net pay, pay period, pay date, and destination label only when explicitly present.
4. Parse receipt merchant, date, total, and likely category as candidate fields.
5. Require the relevant owner to confirm extracted salary/expense values before writing finance records.
6. Store normalized confirmed fields and minimal attachment metadata; temporary file bytes are deleted after processing unless the user explicitly saves the document.
7. Keep video support out of the initial scope.

### Gate 5 — Balances, forecast, dashboard, reminders
1. Use manually reported, timestamped balances as actual baselines.
2. Calculate forecasts separately and show the baseline date and assumptions.
3. Add dashboard only after ledger and calculation tests pass.
4. Reuse existing background-task scheduling for the monthly balance reminder only after verifying delivery semantics.

## Required test matrix

- Each member authenticates independently and is allowlisted.
- Both can read/write shared household records according to role.
- Neither can access a different household's records.
- Revoked membership loses access immediately.
- Client-supplied `user_id`, `created_by`, household ID, role, or visibility cannot elevate access.
- No browser role can select, insert, update, or delete finance tables.
- A server request without active membership is denied even when its caller is otherwise allowlisted.
- Unconfirmed payroll candidates are excluded from confirmed income totals.
- Confirmed salaries are visible to both active members.
- Payroll net pay equals the linked ledger income amount; deduction rows reconcile to gross minus net.
- Card purchase plus card settlement is counted once.
- Forecast never overwrites or misrepresents reported balances.
- Corrections/voids preserve audit history and prevent duplicate entry.
- Finance parsing cannot access another user's attachment.
- No attachment content, OCR text, salary values, signed URLs, or tokens appear in logs.

## Deferred user decisions

- Confirmed by user on 2026-11-03: Manato is the initial household owner and Kaede is the second member. This approves the proposed role model only; no membership rows have been provisioned.
- Confirm Kaede's Auth user ID through an authorized admin-side process before allowlisting/provisioning.
- Any live database migration requires separate approval after exact SQL, security model, and Preview/test plan are presented.
