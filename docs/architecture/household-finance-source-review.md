# Household Finance — Source Review and Implementation Plan

Review date: 2026-11-02
Branch: `perf/response-speed-memory-cache`
Status: implementation planning; no application code or database has been changed for household finance.

## Verified current architecture

### Authentication
- API routes call `requireAuth` in `api/_auth.js`.
- `requireAuth` validates the Supabase bearer token using `/auth/v1/user`.
- Access is then restricted by `JARVIS_ALLOWED_USER_IDS`. A second household login cannot use the API until its Supabase auth user ID is explicitly allowlisted.
- Finance authorization must not be implemented by trusting request-supplied user IDs, user metadata, or client-side household IDs.

### Chat file and image attachments
- The chat composer is `#textInput` and `#sendButton` in `public/index.html`.
- `sendToGemini(text, options)` currently sends a JSON body to `/api/gemini`; no attachment picker or binary upload flow exists.
- The existing Google Drive integration is user-scoped and is not required for household finance.
- Manato and Kaede each upload their own payslip or receipt directly from their device through their own J.A.R.V.I.S. login. Neither account needs access to the other's Drive.
- The attachment design is documented in `docs/architecture/chat-attachments-design.md`: private temporary storage, signed upload, server-side ownership validation, multimodal Gemini processing, automatic cleanup, and explicit confirmation before finance writes.

### Serverless/API constraints
- The Vercel Hobby deployment limit is 12 Serverless Functions. Do not add a new `api/**` route until the exact current function count is established.
- Prefer extending an existing authenticated route with a strict action allowlist, or using existing `api/gemini.js` for conversational orchestration and a shared server-side finance module.
- Do not place financial persistence in the browser or in personal-memory records.

### Database and existing data access
- Existing app server code accesses Supabase with a server-side secret key; finance tables must remain inaccessible to browser clients.
- Existing tables are user-scoped, RLS-enabled, and have no direct authenticated policies in the observed project. Do not copy those patterns blindly.
- Household finance requires explicit household membership authorization on every operation. The final migration must include RLS, grants, constraints, and tested membership predicates.
- No live database changes are authorized by this planning step.

## Confirmed product decisions

- Manato and Kaede use separate J.A.R.V.I.S. accounts.
- One shared household finance space is accessible to both active members.
- Both members' confirmed salary data, income, expenses, account labels, balances, recurring obligations, and reports are shared.
- Google Drive is not the household document intake path. Each person sends their own files/images directly to J.A.R.V.I.S. from their device and their own account.
- Neither member needs to access the other's Drive.
- Parsed payslip values remain unconfirmed until the salary owner checks and confirms them. After confirmation and explicit sharing, both members can use and view the household salary data.
- Conversations, personal memories, and unrelated Drive data remain private.
- No bank login, account numbers, card numbers, credentials, scraping, or automatic bank transactions.
- No Production deploy, main merge, or live database migration without separate explicit approval.

## Implementation sequence

### Gate 1 — Authentication and household membership
1. Confirm current allowlisted account IDs and obtain Kaede's J.A.R.V.I.S. auth user ID through an authorized admin-side process; never ask for passwords or tokens.
2. Implement household creation, invitation/acceptance, membership revocation, and role checks.
3. Add a shared server-side authorization helper that derives the caller from the validated bearer token and checks active membership in the requested household.
4. Ensure the client cannot choose or spoof `created_by`, owner identity, membership role, or visibility.
5. Add two-user/two-household tests before enabling finance operations.

### Gate 2 — Finance storage and ledger
1. Design household-scoped tables for households/members, accounts (labels only), transactions, recurring items, balance snapshots, documents metadata, and append-only audit events.
2. Use integer JPY amounts, typed transaction kinds, planned/confirmed status, idempotency, and reversible void/correction history.
3. Keep salary person/subject separate from document owner and entry actor.
4. Implement strict RLS and least-privilege grants; test cross-household isolation, revoked membership, and shared household access.
5. Produce migration SQL and a security review for approval before touching the live Supabase project.

### Gate 3 — Conversational entry and reporting
1. Extend the existing conversation route with a finance-intent contract and a strict operation schema.
2. Ask a follow-up when amount, date, payer, category, payment method, account label, or confirmation state is ambiguous.
3. Require explicit confirmation before committing inferred or bulk operations.
4. Implement correction, void, search, monthly summaries, category aggregates, and chart-ready data.
5. Keep credit-card purchases and later settlement from being counted twice.

### Gate 4 — Payslip and receipt import through chat attachments
1. Implement the generic chat attachment flow first (images, PDFs, text files).
2. Each member uploads their own documents through their own authenticated session; no Drive sharing is required.
3. Use private temporary storage and server-controlled object ownership; validate MIME type and size server-side.
4. Parse gross pay, deductions, net pay, pay period, pay date, and destination label only when explicitly present.
5. Parse receipt merchant, date, total, and likely category as candidate fields.
6. Require the relevant owner to confirm extracted salary/expense values before writing finance records.
7. Store normalized confirmed fields and minimal attachment metadata; temporary file bytes are deleted after processing unless the user explicitly saves the document.
8. Make only confirmed and explicitly shared salary figures visible to both active household members.

### Gate 5 — Balances, forecast, dashboard, reminders
1. Use manually reported, timestamped balances as actual baselines.
2. Calculate forecasts separately and show the baseline date and assumptions.
3. Add dashboard only after ledger and calculation tests pass.
4. Reuse existing background-task scheduling for the monthly balance reminder only after verifying delivery semantics.

## Required test matrix

- Manato and Kaede can each authenticate independently.
- Both can read/write shared household ledger records according to role.
- Neither can access a different household's records.
- Revoked member loses access immediately.
- Client-supplied `user_id`, `created_by`, household ID, role, or visibility cannot elevate access.
- Manato's Drive connection is never exposed to Kaede's session.
- Only configured folder / selected PDF is discoverable.
- PDF size/type limits, malformed files, and OCR failure are handled safely.
- Unconfirmed parsed payroll is excluded from confirmed income totals.
- Confirmed salaries are visible to both members.
- Card purchase + card settlement is counted once.
- Forecast never overwrites or misrepresents reported balances.
- Corrections/voids preserve audit history and prevent duplicate entry.

## Current blockers / user input that may be needed later

- Kaede's Supabase auth user ID, obtained safely from the authenticated account/admin interface.
- The designated Google Drive folder for payslips (create/select after the Drive import code is ready).
- Confirmation of the exact household invitation mechanism and whether Manato is the initial household owner. Default implementation: Manato creates and invites Kaede.
- Any migration to the live Supabase project requires separate approval after the exact SQL and tests are presented.
