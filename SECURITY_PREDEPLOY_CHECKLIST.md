# J.A.R.V.I.S. Security Pre-deployment Checklist

Status: review branch only. No production merge or Vercel deployment has been executed. Supabase read-only inspection was performed on 2026-10-20; the `api_usage` foreign key was subsequently added and verified in Supabase SQL Editor on 2026-10-20.

## Verified Supabase state (read-only, 2026-10-20)

- `public.memories`: 8 rows; inspected rows already have a non-NULL owner. Do not run `202610180002_assign_legacy_memories.sql`; its legacy ownership/content assumptions do not match the live data.
- `public.api_usage`: 351 rows were observed with `user_id IS NULL`. The nullable UUID column and `api_usage_user_id_created_at_idx` already existed. The missing foreign key `api_usage_user_id_fkey` was added and then verified; its definition is `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL`. Historical NULL values were not changed.
- `public.api_rate_limits`: table exists with the expected four columns, checks, foreign key, primary key, and window index.
- `public.consume_api_quota(uuid,text,integer)`: function exists; it is SECURITY DEFINER with an empty search_path; EXECUTE is false for anon/authenticated and true for service_role.
- `public.cleanup_api_rate_limits()`: function exists; it is SECURITY DEFINER with an empty search_path; EXECUTE is false for anon/authenticated and true for service_role.
- `cron.job` resolves to NULL in this database, so the pg_cron job table is not available under that name. No scheduled cleanup was verified.
- RLS is enabled on `memories` and `api_usage`, but no policies were returned for either table. The screenshots showed direct table grants to anon/authenticated. Per 真人さん’s instruction, backup is deferred until project completion; keep these grants unchanged for now and do not run privilege-changing SQL. Reassess after backup and confirmation of all access paths.
- Browser source review found memory requests going through `/api/memory`; no direct browser REST access to `memories` or `api_usage` was found in the searched source. This is not a substitute for Preview tests or checking other clients.

## Blocking order

1. Confirm the correct Vercel project and Preview/Production environment scope. Never expose environment variable values.
2. Backup is deferred until the project is complete, per 真人さん’s explicit instruction. Until then, continue only non-destructive code review, CI, and Preview checks; do not perform database data changes, privilege revocations, or other irreversible Supabase operations.
3. Do not run `202610180002_assign_legacy_memories.sql`; live memory ownership does not match its assumptions.
4. Completed: `api_usage_user_id_fkey` was added and verified in Supabase SQL Editor. Do not re-run migration 001 blindly; the live foreign key is already present.
5. The live schema already contains the expected table/function/privileges for `202610180003_durable_api_rate_limits.sql`; compare the migration definition with the live definitions before deciding whether reapplying is needed. The deployed code fails closed with HTTP 503 if the quota RPC is unavailable.
6. Deferred until project completion and backup: do not apply `202610180004_revoke_direct_client_table_access.sql` yet. Before that future step, confirm all intended clients use server APIs. The migration removes direct privileges for PUBLIC, anon, and authenticated on `memories` and `api_usage`.
7. The cleanup function from `202610190001_cleanup_api_rate_limits.sql` already exists. Do not schedule cleanup until the available scheduler, timezone, and existing jobs are confirmed. No cleanup job has been verified.
8. Run the required tests against the existing Vercel Preview deployment and record actual outcomes. The available remote request check was blocked, so these tests remain unverified. Do not merge to main until blockers pass.

## Required tests on Preview

- No Authorization header: `/api/gemini`, `/api/tts`, `/api/memory`, and `/api/token` return 401 without calling paid providers.
- Invalid/expired session: same endpoints reject the request.
- Valid session: normal chat, voice, memory read/write, and search work.
- User A cannot read, update, or duplicate-match User B's private memory; test with all intended family accounts.
- Oversized Gemini text (>12,000 chars), memory context (>12,000 chars), TTS text (>3,000 chars), and invalid memory payloads are rejected.
- Per-user quota: requests under limit succeed; over-limit requests return 429; a different user has an independent counter.
- Rate-limit RPC unavailable or DB schema missing: paid endpoints fail closed with 503 and do not call paid providers.
- Provider timeout/4xx/5xx: sanitized response, no raw prompt/query/text in logs, and bounded completion time.
- Usage log row records the correct authenticated user ID and allowlisted metadata only.
- Logout/session expiry and switching accounts do not reuse another user's memory.
- Check usage/cost after tests; do not treat per-minute limits as monthly spend caps.

## Deployment rollback

- Keep the previous production deployment available for rollback.
- Database changes should be additive except the explicit legacy memory ownership/content update; do not run that update against the current data.
- If Preview fails, do not promote. Capture status codes and sanitized logs only; never paste tokens, keys, or personal conversation contents.

## Current known limitations

- CI uses mocked tests and has not validated the live Supabase/Vercel environment.
- Rate limits are per-minute request ceilings, not daily/monthly spend caps.
- Cleanup function exists, but no schedule has been verified. First identify an approved scheduler and check existing jobs; never assume pg_cron is installed.
- The `/api/token` endpoint has no caller in the inspected browser source; confirm there is no external caller before removing it.
- Browser source review found no direct REST calls to `memories` or `api_usage`, but this must be rechecked against all clients before revoking table privileges.

## Automated checks updated 2026-10-21 (security branch only)

Latest confirmed successful GitHub Actions run: https://github.com/manakae0725-del/J.A.R.V.I.S./actions/runs/39535805612

Covered by CI mocks/static checks:
- Shared authentication: missing bearer token, invalid session, Supabase 5xx, network failure, malformed user payload, valid session.
- Rate limit: allow, deny/429 headers, RPC HTTP failure/network failure fail closed with 503, independent user keys, unexpected non-boolean response.
- Memory input boundaries: content at 5,000 characters, content over 5,000, category over 100, invalid importance values.
- Gemini/TTS boundaries: Gemini text over 12,000, memory context over 12,000, previous interaction ID over 200, TTS text over 3,000; invalid inputs must not call paid providers.
- Gemini provider response failures: malformed JSON and non-OK provider response return sanitized errors.
- Existing mocked memory API and token API tests continue to pass.
- Static source checks include auth failure classification, authenticated quota checks, memory owner scoping, bounded requests, function grants, and a source-level check that raw query/prompt variables are not directly passed to console logging.

These checks do not validate live Vercel Preview, live Supabase grants/RLS, real quota counter behavior, account separation, provider timeouts under live conditions, actual logs, or cost attribution.

## Current branch review notes (2026-10-21)

- api/gemini.js: provider HTTP non-OK is now checked before JSON parsing; malformed JSON from a successful provider response returns a sanitized 502. No direct logging of raw searchQuery, rawText, memoryContext, request body, or TTS spoken text was found by the current source-level check. Existing debug logs still emit endpoint/status/count/boolean/context-length metadata; remove or reduce these before Production if operationally unnecessary.
- Rate limits are checked before request-body validation on Gemini/TTS/token routes. This intentionally prevents repeated malformed requests from bypassing request quotas, but invalid requests can consume quota. Keep this as a documented behavior unless product requirements say otherwise.
- No live Preview requests were performed during this review. Do not mark the live checklist items complete based on CI.
- Kaede account isolation remains pending until both intended accounts are available.


## Backup timing decision (2026-10-21)

真人さん explicitly confirmed that Supabase backup cannot be performed now and must wait until project completion. This is a planned deferral, not an outstanding request to ask again. Continue safe, non-destructive review and testing meanwhile. No direct table grant revocations, cleanup scheduling, destructive migration, or Production merge/deployment is authorized by this timing decision.

## Additional review updates (2026-10-21, latest head `c01538eb9cb65dc08768256b00e4fd0d459a4682`)

- Added a client-side account-change handler: when the authenticated user ID changes, clear in-memory browser memories, reset `previousInteractionId`, and clear the text input. This reduces accidental reuse of user-scoped client state; it does not replace live account-isolation tests.
- Removed 22 `console.log` debug calls from `api/gemini.js`; a fresh source fetch confirmed no `console.log(` calls remain in that file. Sanitized `console.error` events remain for operational failures.
- Repository-wide GitHub code search for `"/api/token"` found no caller in indexed repository files. This does not rule out external clients or callers outside the repository; keep the endpoint until those are ruled out.
- CI passed for latest head `c01538eb9cb65dc08768256b00e4fd0d459a4682`: https://github.com/manakae0725-del/J.A.R.V.I.S./actions/runs/39562980806
- The PR remains draft and unmerged. No live Preview requests, Production deployment, or Supabase privilege/data changes were performed as part of these updates.

## Follow-up review (2026-10-21, head `9c5141d1c2f2e1c3ba80fbe6864aee5229f7e4e1`)

- Latest CI run for the checklist commit completed successfully: https://github.com/manakae0725-del/J.A.R.V.I.S./actions/runs/39563204632
- Re-reviewed the browser auth flow: the browser obtains a session token through `jarvisGetAccessToken`; auth-state changes clear the in-memory memories, prior Gemini interaction ID, and text input when the user ID changes (including sign-out). This is defense in depth only; live account switching still needs testing.
- Remaining browser console messages observed are generic UI/audio status messages; no transcript text is included in the speech-recognition success log. `api/gemini.js` has no remaining `console.log(` calls. Operational `console.error` calls remain in API handlers.
- `api/memory.js` scopes GET, duplicate lookup, update, insert, and soft-delete operations to the authenticated user ID; DELETE has mocked tests for owner scoping, malformed IDs, not-found, database failure, and unauthenticated access. GET/POST behavior is still primarily code-reviewed rather than comprehensively covered by dedicated mocked tests.
- No source change was made in this follow-up because the remaining high-value checks require either new test coverage or live environment/account access. Live Preview verification, Kaede account isolation, external `/api/token` caller confirmation, and Supabase permission changes remain outstanding/deferred. No Production merge/deployment or live database mutation was performed.

