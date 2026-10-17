# J.A.R.V.I.S. Security Audit — Initial Findings

Date: 2026-10-17
Scope: Read-only review of the `main` branch source. No production requests, database policy inspection, secret-value retrieval, or live penetration tests were performed.

## Confirmed from source

### Critical — `api/token.js` has no application authentication check
- The endpoint accepts GET and requests a Gemini ephemeral auth token using the server-side `GEMINI_API_KEY`.
- There is no `requireAuth` call, per-user authorization, input validation, or rate limiting in this handler.
- Risk: an unauthenticated caller may trigger token creation and consume quota, subject to upstream API behavior and deployment controls.
- Recommended fix: require a valid Supabase session; use POST; add strict rate limiting and generic error responses; set `Cache-Control: no-store`; validate the upstream response before returning only the intended ephemeral token. Confirm the browser actually uses this endpoint before changing its contract.

### High — user text is written to server logs
- `api/gemini.js` logs extracted user text and search queries.
- These can contain personal or confidential conversation content.
- Recommended fix: remove raw user text/query logging; keep only safe operational metadata such as request ID, duration, status, provider, and result counts.

### High — missing input bounds / rate limits in expensive API routes
- `api/gemini.js` checks whether text is present but the inspected handler does not apply a maximum input length or per-user request quota before search/model calls.
- `api/tts.js` checks whether text is present but the inspected handler does not apply a maximum text length or per-user request quota before calling ElevenLabs.
- Recommended fix: enforce type and byte/character limits, reject empty/oversized values, and add per-user rate/usage limits before paid upstream requests.

### Medium — upstream error details may be exposed
- `api/token.js` forwards upstream error JSON and exposes `error.message` on caught exceptions.
- `api/tts.js` forwards provider-derived error messages and exception messages.
- Recommended fix: return stable, generic client-facing error messages; log sanitized error codes/status server-side.

### Medium — TTS voice settings are logged
- `api/tts.js` logs the voice settings response. This is not obviously personal data, but is unnecessary operational detail.
- Recommended fix: remove the settings fetch/log unless it is an intentional diagnostic operation; never run it before checking that the API key is configured.

### Positive controls observed
- `api/gemini.js`, `api/memory.js`, and `api/tts.js` call the shared `requireAuth` helper.
- `api/memory.js` filters reads and writes by the authenticated user's ID in its REST queries.
- `api/auth-config.js` returns a Supabase public/anonymous key, not a service-role key. Public anon/publishable keys are expected to be client-visible; database policies must still prevent unauthorized access.

## Not yet verified
- Supabase RLS policies and grants on `memories` and `api_usage`.
- Vercel production/preview environment variable names and scopes (values must not be exposed).
- Whether each endpoint is protected by deployment-level controls.
- Live behavior for three accounts, cross-account data isolation, logout/session expiry, input limits, API failures, and billing/rate controls.
- Full source/build configuration and automated test results.

## Recommended order
1. Fix `api/token.js` authentication and abuse controls after confirming its caller and intended flow.
2. Remove raw user-content/query logs and sanitize error responses.
3. Add bounded input validation and per-user quotas to Gemini/TTS/search/token routes.
4. Verify Supabase RLS with the actual schema and policies; do not infer policy correctness from application filters alone.
5. Run functional and security tests on a Preview deployment, then promote only after passing.
