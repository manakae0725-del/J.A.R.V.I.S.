# J.A.R.V.I.S. Security Audit — Initial Findings

Date: 2026-10-17
Scope: Read-only review of the `main` branch source. No production requests, database policy inspection, secret-value retrieval, or live penetration tests were performed.

## Initial changes applied on the audit branch (not yet runtime-tested)
- `api/token.js`: now requires a valid Supabase session, accepts POST only, disables caching, times out the upstream request, validates the response, and returns generic errors. A source scan of `public/index.html` did not find a caller for `/api/token`; confirm whether this endpoint is obsolete before relying on it.
- `api/gemini.js`: added input bounds, removed direct logs of raw search results and sanitized provider exceptions, added 10-second search timeouts and a 3-second usage-log timeout, and stopped returning invalid model output to the browser. Confirmed the Tavily request still sends the required `query` field.
- `api/tts.js`: added text type/empty/length checks (3,000 characters), a 20-second upstream timeout, removed the voice-settings fetch/log, corrected usage-log metadata, and sanitized unexpected error responses.
- `api/_auth.js`: added an 8-second timeout to Supabase session verification.
- `api/gemini.js`, `api/tts.js`, and `api/memory.js`: set `Cache-Control: no-store` for authenticated responses.
- `api/memory.js`: added 10-second timeouts to database requests, set `Cache-Control: no-store`, and kept reads/writes filtered by the authenticated user's ID.
- `lib/searchManager.js`: added 10-second timeouts and removed raw exception objects from search failure logs. This helper does not appear to be imported by the current UI/API path, but is hardened for future use.

These changes are committed only to `security-audit-baseline-2026-10-17`. No production deployment was triggered by these branch commits. Runtime/build tests have not yet been run.

## Findings from the original `main` baseline (before branch fixes)

### Critical — `api/token.js` had no application authentication check (branch fix applied; runtime test pending)
- The endpoint accepts GET and requests a Gemini ephemeral auth token using the server-side `GEMINI_API_KEY`.
- There is no `requireAuth` call, per-user authorization, input validation, or rate limiting in this handler.
- Risk: an unauthenticated caller may trigger token creation and consume quota, subject to upstream API behavior and deployment controls.
- Recommended fix: require a valid Supabase session; use POST; add strict rate limiting and generic error responses; set `Cache-Control: no-store`; validate the upstream response before returning only the intended ephemeral token. Confirm the browser actually uses this endpoint before changing its contract.

### High — user text was written to server logs (raw-text logs removed on branch; runtime test pending)
- `api/gemini.js` logs extracted user text and search queries.
- These can contain personal or confidential conversation content.
- Recommended fix: remove raw user text/query logging; keep only safe operational metadata such as request ID, duration, status, provider, and result counts.

### High — expensive API routes lacked input bounds / rate limits (input bounds added; durable rate limits remain outstanding)
- `api/gemini.js` checks whether text is present but the inspected handler does not apply a maximum input length or per-user request quota before search/model calls.
- `api/tts.js` checks whether text is present but the inspected handler does not apply a maximum text length or per-user request quota before calling ElevenLabs.
- Recommended fix: enforce type and byte/character limits, reject empty/oversized values, and add per-user rate/usage limits before paid upstream requests.

### Medium — upstream error details could be exposed (generic error responses added to token/TTS/Gemini paths; runtime test pending)
- `api/token.js` forwards upstream error JSON and exposes `error.message` on caught exceptions.
- `api/tts.js` forwards provider-derived error messages and exception messages.
- Recommended fix: return stable, generic client-facing error messages; log sanitized error codes/status server-side.

### Medium — TTS voice settings were logged (diagnostic fetch/log removed on branch)
- `api/tts.js` logs the voice settings response. This is not obviously personal data, but is unnecessary operational detail.
- Recommended fix: remove the settings fetch/log unless it is an intentional diagnostic operation; never run it before checking that the API key is configured.

### Positive controls observed
- `api/gemini.js`, `api/memory.js`, and `api/tts.js` call the shared `requireAuth` helper.
- `api/memory.js` filters reads and writes by the authenticated user's ID in its REST queries.
- `api/auth-config.js` returns a Supabase public/anonymous key, not a service-role key. Public anon/publishable keys are expected to be client-visible; database policies must still prevent unauthorized access.

## Remaining risks / not yet verified
- Durable per-user rate/usage limits are not implemented. Input limits and upstream timeouts do not prevent repeated authenticated calls from consuming quota.
- Supabase RLS policies and grants on `memories` and `api_usage` have not been inspected. The memory route uses `SUPABASE_SECRET_KEY`, which bypasses RLS; application-level `user_id` filters are therefore security-critical.
- The `api_usage` writes have no visible user ID in the inspected code and may fail if the deployed table requires additional columns or policies.
- Vercel production/preview environment variable names and scopes (values must not be exposed).
- `lib/searchManager.js` does not appear to be imported by the current UI/API path; its future intended use remains unclear.
- Whether each endpoint is protected by deployment-level controls.
- Live behavior for three accounts, cross-account data isolation, logout/session expiry, input limits, API failures, and billing/rate controls.
- Full source/build configuration and automated test results.

## Recommended next steps
1. Confirm whether `/api/token` is still used by the current UI; if unused, decide whether to remove it rather than maintain a dormant endpoint.
2. Inspect the actual Supabase schema, grants, and RLS policies for `memories` and `api_usage`; verify the intended three-account model before implementing shared-family data.
3. Design and implement durable per-user quotas for Gemini, TTS, and search using a confirmed schema or a dedicated rate-limit store. Do not use in-memory counters on serverless functions as an enforcement boundary.
4. Verify Vercel Preview environment-variable names/scopes without exposing values.
5. Run build/syntax checks and authenticated/unauthenticated, cross-account, oversized-input, timeout, and provider-failure tests on Preview. Promote only after the tests pass.

## Verification status
- No automated build/test run or live security test has been completed by this audit. Current Vercel Preview builds are still running for the latest commits; previous READY states are not functional test results.
- Vercel Preview deployments previously reported READY, which confirms deployment completion only; it does not establish runtime correctness.
- This branch has not been merged to `main`; production has not been intentionally changed by these commits.


## Follow-up source review (2026-10-18)
- Confirmed `public/index.html` obtains the Supabase session access token and sends it as a Bearer token to `/api/gemini`, `/api/tts`, and `/api/memory`. The browser source does not call `/api/token`; the endpoint is currently dormant from the inspected client path, so it should not be treated as part of the active voice flow.
- The active client does not visibly call `lib/searchManager.js` or `/api/token` in the inspected source. This is a source-scan result, not proof that no external caller exists.
- Tightened `api/_auth.js` failure logging so the request path is stripped of query strings before logging; bearer tokens remain unlogged.
- Remaining limitation: durable per-user rate limiting cannot safely be added until the database schema or a dedicated store is confirmed. Do not use in-memory counters as an enforcement boundary on serverless functions.


## Supabase dashboard evidence supplied by project owner (2026-10-18)
- The dashboard shows two public tables: `memories` (9 columns, estimated 4 rows) and `api_usage` (8 columns, estimated 339 rows).
- The Policies page shows RLS enabled on both tables and no policies created for either table. This means ordinary Data API access is denied by RLS unless a policy is added, while server requests using the Supabase secret/service-role credential bypass RLS. Keep the secret key server-only and maintain explicit owner filters in server code.
- The Auth settings shown have email and Google providers enabled; new signups are enabled and email confirmation is enabled. Only one user is visible in the supplied user-list screenshot. This is a snapshot, not proof that no other user exists in another page/environment.
- The current `api/memory.js` GET, duplicate lookup, PATCH, and INSERT all constrain memory records by the authenticated user's ID (the PATCH is additionally constrained by the looked-up record ID). This is useful application-level isolation but still needs live cross-account tests.
- At the time of this dashboard review, the usage logger did not include authenticated `user_id`; subsequent branch changes now add it to each Gemini/TTS usage-log call. The database migration is still pending, so per-user usage reporting is not active in the deployed schema.
- Before enabling additional family accounts, decide whether public sign-up should remain enabled. If the intended system is limited to three family members, a safer design is controlled account provisioning and no open sign-ups, after confirming the sign-in/onboarding flow will still work.


## API usage attribution and metadata minimization (2026-10-18)
- Updated `api/gemini.js` and `api/tts.js` to attach the authenticated Supabase user ID to every usage-log call and to persist only an allowlist of low-risk metadata fields. Raw search queries and user text are no longer included in usage metadata by these helpers.
- Added `supabase/migrations/202610180001_api_usage_user_id.sql`. It adds nullable `user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL` and an index on `(user_id, created_at DESC)`. It preserves historical rows with NULL user IDs.
- IMPORTANT: this migration has only been committed to the review branch; it has NOT been applied to Supabase. The updated API usage logger will fail to insert rows until the migration is applied, because the current table does not yet have the `user_id` column. Apply only after reviewing the SQL and when ready to coordinate deployment.
- The usage logger remains best-effort, but branch code now checks Supabase HTTP response status and logs a sanitized rejection status; both Gemini and TTS usage-log requests have a 3-second timeout. This has been source-verified only, not runtime-tested.
- No production merge, Supabase schema change, or end-to-end test was performed as part of this update.


## Legacy memory ownership decision (2026-10-18)
- Owner approved assigning the six legacy memory rows with NULL `user_id` to their own account.
- Prepared `supabase/migrations/202610180002_assign_legacy_memories.sql` to assign rows 2–7 to the account UUID visible in the supplied dashboard screenshot, and correct the row 7 full-name typo to the account owner's known spelling.
- This is a review-branch migration only. It has NOT been applied to Supabase. Verify row IDs/content and take a backup before applying; the SQL includes conditions on NULL ownership and the old misspelled content to reduce accidental changes.


## Follow-up verification (2026-10-18, latest branch review)
- Source re-check confirmed the usage-log helper in both `api/gemini.js` and `api/tts.js` checks `logResponse.ok`, emits only the HTTP status on rejection, and applies a 3-second timeout.
- Source re-check confirmed the shared auth helper rejects missing/invalid bearer sessions and applies an 8-second timeout to Supabase session verification. `api/memory.js` restricts reads, duplicate checks, updates, and inserts by the authenticated user ID.
- GitHub repository inspection did not find a root `package.json` or `.github/workflows` directory on this branch, so no repository-defined automated build/test workflow was available through those paths. Vercel deployment READY status is not a substitute for runtime tests.
- PR #2 remains open as a draft and has not been merged. Do not merge/deploy until the `api_usage.user_id` migration is coordinated with the code, the memory migration is reviewed against actual row contents, and runtime checks pass.


## Durable per-user rate limiting (2026-10-18, review branch only)
- Added `api/_rateLimit.js`, which calls a database RPC before paid provider use. It fails closed with HTTP 503 if quota enforcement is unavailable and returns HTTP 429 when a quota is exhausted.
- Added `supabase/migrations/202610180003_durable_api_rate_limits.sql`: an atomic minute-window counter keyed by authenticated user ID and service; RLS is enabled on the backing table and direct grants are revoked from anon/authenticated roles. The RPC is executable only by service_role.
- Wired the limiter into `api/gemini.js` (30 requests/minute default), search requests (20/minute), `api/tts.js` (10/minute), and `api/token.js` (5/minute). Optional Vercel environment overrides are `JARVIS_GEMINI_RPM`, `JARVIS_SEARCH_RPM`, `JARVIS_TTS_RPM`, and `JARVIS_TOKEN_RPM`; each is capped at 1000/minute.
- These are initial request-rate limits, not a monthly spend cap or full billing budget. They do not prevent a user from consuming their full per-minute allowance repeatedly across many minutes. Revisit thresholds after real usage/cost review.
- DEPLOYMENT ORDER MATTERS: the new API paths fail closed until the rate-limit migration is applied. Do not deploy/merge the branch to production before reviewing and applying the SQL migration and coordinating the API usage column migration. The migration has not been applied; no live quota behavior has been tested.
- Remaining: cleanup/retention for old `api_rate_limits` windows, three-account runtime tests, and verification of actual database grants/RPC execution in the target Supabase project.


## Rate-limit implementation review correction (2026-10-18)
- Source review caught and corrected a URL-normalization regex in `api/_rateLimit.js`; without this correction, a Supabase URL ending in `/` could form an invalid RPC URL. The fix is committed on the review branch.
- The quota migration now explicitly revokes direct table privileges from `PUBLIC`, `anon`, and `authenticated`, in addition to enabling RLS. This hardening is source-reviewed only; the SQL has not been applied or exercised against Supabase.


## Pre-deployment checklist
- Added `SECURITY_PREDEPLOY_CHECKLIST.md` with the required migration order, backup/row-verification gates, Preview test matrix, and rollback conditions.
- This checklist is not evidence that tests passed. Supabase migrations remain unapplied and production remains unchanged.


## Read-only Supabase preflight queries (2026-10-18)
- Added `supabase/validation/20261018_preflight_checks.sql` with read-only queries to verify legacy memory row IDs/ownership, actual `api_usage` columns, RLS/policies, quota RPC grants, and quota-table privileges.
- Run the first four sections before migrations; run the last two only after the quota migration has been applied. These queries do not modify data.
- The duplicate quota-table privilege revoke statement in the migration was removed and the resulting file was fetched back to verify exactly one table revoke remains.
