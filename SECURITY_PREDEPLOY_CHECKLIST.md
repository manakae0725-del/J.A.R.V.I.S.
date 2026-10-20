# J.A.R.V.I.S. Security Pre-deployment Checklist

Status: review branch only. No production merge or Vercel deployment has been executed. Supabase read-only inspection was performed on 2026-10-20; the `api_usage` foreign key was subsequently added and verified in Supabase SQL Editor on 2026-10-20.

## Verified Supabase state (read-only, 2026-10-20)

- `public.memories`: 8 rows; inspected rows already have a non-NULL owner. Do not run `202610180002_assign_legacy_memories.sql`; its legacy ownership/content assumptions do not match the live data.
- `public.api_usage`: 351 rows were observed with `user_id IS NULL`. The nullable UUID column and `api_usage_user_id_created_at_idx` already existed. The missing foreign key `api_usage_user_id_fkey` was added and then verified; its definition is `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL`. Historical NULL values were not changed.
- `public.api_rate_limits`: table exists with the expected four columns, checks, foreign key, primary key, and window index.
- `public.consume_api_quota(uuid,text,integer)`: function exists; it is SECURITY DEFINER with an empty search_path; EXECUTE is false for anon/authenticated and true for service_role.
- `public.cleanup_api_rate_limits()`: function exists; it is SECURITY DEFINER with an empty search_path; EXECUTE is false for anon/authenticated and true for service_role.
- `cron.job` resolves to NULL in this database, so the pg_cron job table is not available under that name. No scheduled cleanup was verified.
- RLS is enabled on `memories` and `api_usage`, but no policies were returned for either table. The screenshots showed direct table grants to anon/authenticated. Do not revoke those grants until backup and all access paths are confirmed.
- Browser source review found memory requests going through `/api/memory`; no direct browser REST access to `memories` or `api_usage` was found in the searched source. This is not a substitute for Preview tests or checking other clients.

## Blocking order

1. Confirm the correct Vercel project and Preview/Production environment scope. Never expose environment variable values.
2. Take/export a backup before any data-changing operation or privilege changes.
3. Do not run `202610180002_assign_legacy_memories.sql`; live memory ownership does not match its assumptions.
4. Completed: `api_usage_user_id_fkey` was added and verified in Supabase SQL Editor. Do not re-run migration 001 blindly; the live foreign key is already present.
5. The live schema already contains the expected table/function/privileges for `202610180003_durable_api_rate_limits.sql`; compare the migration definition with the live definitions before deciding whether reapplying is needed. The deployed code fails closed with HTTP 503 if the quota RPC is unavailable.
6. Apply `202610180004_revoke_direct_client_table_access.sql` only after backup and confirming all intended clients use server APIs. It removes direct privileges for PUBLIC, anon, and authenticated on `memories` and `api_usage`.
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
