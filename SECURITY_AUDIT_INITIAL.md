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
