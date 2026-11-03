# J.A.R.V.I.S. Background Task Architecture

Status: Production-enabled implementation, 2026-11-03.

## Goal

Allow J.A.R.V.I.S. to accept a long-running analysis task, return control to the conversation immediately, and continue the task independently. The first release is read-only analysis: it does not write to Google services, send messages, alter accounts, or modify files.

## Runtime

- The existing authenticated `/api/gemini` handler remains the API entry point; no additional Vercel function is introduced.
- Supabase Postgres stores tasks, steps, events, leases, progress, and results.
- `pg_cron` invokes `pg_net` once per minute.
- `pg_net` calls the Production Vercel alias with a dedicated secret header.
- The worker claims one task atomically and executes one bounded Gemini stage per invocation.
- A persisted lease allows a later worker to reclaim a task after a process timeout or crash.
- The worker is invoked through the Production alias. Production and the active Preview deployment each have their own `JARVIS_BACKGROUND_WORKER_SECRET`; the scheduler uses the matching secret stored in Supabase Vault.

## State model

`queued -> planning -> queued -> running -> queued -> verifying -> completed`

Verification may append up to two corrective steps. Terminal states are `completed`, `failed`, and `cancelled`. Tasks can also be paused or retried.

## Persistence

- `jarvis_background_tasks`: request, owner, status, plan, progress, lease, attempts, result, and errors.
- `jarvis_background_task_steps`: ordered step instructions and outputs.
- `jarvis_background_task_events`: task lifecycle and notification events.

RLS is enabled with no browser-facing policies. Tables and RPCs are accessible only to the server-side `service_role`. Every user-facing API operation first validates the Supabase session and the existing allowlist, then filters by the authenticated user ID.

## Execution safety

- Idempotency key is unique per user.
- Task claim uses row locking with `FOR UPDATE SKIP LOCKED`.
- Each claim has a bounded lease; expired leases are reclaimable.
- Worker authentication uses a separate random secret, stored in the target Vercel environment and Supabase Vault. It is not committed to Git.
- Worker route accepts only Preview or Production deployments and requires the timing-safe secret-header check.
- AI output is treated as untrusted data.
- Initial release performs analysis only. External writes and irreversible actions require a separate capability/confirmation design.
- The worker uses Gemini only by default; it does not silently add paid providers or Claude.
- Each AI stage has a 25-second timeout and bounded output.
- Verification can add at most two corrective steps.

## Scheduling and cost

The scheduler runs once per minute while the Supabase project is active. It uses existing Supabase Free-plan extensions `pg_cron` and `pg_net`; no new package or paid service is introduced. Supabase Free Edge Function limits are not involved because this implementation calls the existing Vercel API directly.

## Production boundary

User-facing task API modes are available in Preview and Production only after the existing session authentication and allowlist checks. Task ownership remains scoped to the authenticated user ID. Worker execution is available only in Preview or Production and requires the separate worker secret. The active Supabase Cron job calls the Production alias.

## Known limitations for first release

- One task stage is executed per worker tick; a multi-step task can take several minutes.
- Worker scheduling is minute-granularity.
- The first release is analysis-only and does not invoke Google/other write capabilities.
- UI progress and cancellation are implemented separately from the worker core.
