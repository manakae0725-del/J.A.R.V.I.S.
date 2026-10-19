# J.A.R.V.I.S. Security Pre-deployment Checklist

Status: review branch only. No production merge or Supabase migration has been executed.

## Blocking order

1. Confirm the Vercel project and environment scope for Preview and Production. Never expose environment variable values.
2. In Supabase SQL Editor, inspect the exact columns, row IDs, content, ownership, grants, and RLS state for `public.memories` and `public.api_usage`. Export a backup before any data update.
3. Review `202610180002_assign_legacy_memories.sql` against the actual rows. It assumes IDs 2–7 are the six NULL-owned rows and that ID 7 contains the misspelled name. Do not run it if either assumption is false.
4. Review and apply `202610180001_api_usage_user_id.sql` before deploying code that writes `api_usage.user_id`.
5. Review and apply `202610180003_durable_api_rate_limits.sql`. This is required before deploying the code that calls `rpc/consume_api_quota`; otherwise paid API endpoints will fail closed with HTTP 503.
6. Review and apply `202610180004_revoke_direct_client_table_access.sql` only after confirming all intended access paths use the server API.
7. Review and apply `202610190001_cleanup_api_rate_limits.sql` after the rate-limit table exists. It creates a bounded cleanup function but does not schedule or execute it.
8. Only after the database migrations succeed, deploy to Preview and run the tests below. Do not merge to main until all blocking tests pass.

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
- Database migrations are additive except the explicit legacy memory ownership/content update; review that update separately.
- If Preview fails, do not promote. Capture status codes and sanitized logs only; never paste tokens, keys, or personal conversation contents.

## Current known limitations

- These checks have not been run against the live Supabase/Vercel environment.
- Rate limits are per-minute request ceilings, not daily/monthly spend caps.
- Retention cleanup is implemented as a database function, but no schedule has been created and no cleanup has been run. Before enabling it, check whether `pg_cron` is installed:
  ```sql
  SELECT extname FROM pg_extension WHERE extname = 'pg_cron';
  ```
  If it is installed, inspect existing jobs first:
  ```sql
  SELECT jobid, jobname, schedule, command
  FROM cron.job
  WHERE jobname = 'cleanup-api-rate-limits-daily';
  ```
  If no job exists and a daily 03:17 UTC run is suitable for the project, schedule it with:
  ```sql
  SELECT cron.schedule(
    'cleanup-api-rate-limits-daily',
    '17 3 * * *',
    $$SELECT public.cleanup_api_rate_limits();$$
  );
  ```
  Confirm the project's cron timezone and monitor `cron.job_run_details` after scheduling. If `pg_cron` is unavailable, use an approved external scheduler or a reviewed manual run of `SELECT public.cleanup_api_rate_limits();`. These are instructions only; no production SQL has been executed.
- The `/api/token` endpoint has no caller in the inspected browser source; confirm there is no external caller before removing it.
