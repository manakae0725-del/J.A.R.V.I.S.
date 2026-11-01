# J.A.R.V.I.S. Background Task Architecture

Status: Preview implementation, 2026-11-02.

## Goal

Allow J.A.R.V.I.S. to accept a long-running analysis task, return control to the conversation immediately, and continue the task independently. The first release is read-only analysis: it does not write to Google services, send messages, alter accounts, or modify files.

## Runtime

- The existing authenticated `/api/gemini` handler remains the API entry point; no additional Vercel function is introduced.
- Supabase Postgres stores tasks, steps, events, leases, progress, and results.
- `pg_cron` invokes `pg_net` once per minute.
- `pg_net` calls the stable Vercel Preview branch alias with a dedicated secret header.
- The worker claims one task atomically and executes one bounded Gemini stage per invocation.
- A persisted lease allows a later worker to reclaim a task after a process timeout or crash.
- The Vercel Preview environment variable and Vault secret are scoped to the development worker. Production code and environment variables are not changed.

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
- Worker authentication uses a separate random secret, stored in Vercel Preview env and Supabase Vault. It is not committed to Git.
- Worker route is Preview-only.
- AI output is treated as untrusted data.
- Initial release performs analysis only. External writes and irreversible actions require a separate capability/confirmation design.
- The worker uses Gemini only by default; it does not silently add paid providers or Claude.
- Each AI stage has a 25-second timeout and bounded output.
- Verification can add at most two corrective steps.

## Scheduling and cost

The scheduler runs once per minute while the Supabase project is active. It uses existing Supabase Free-plan extensions `pg_cron` and `pg_net`; no new package or paid service is introduced. Supabase Free Edge Function limits are not involved because this implementation calls the existing Vercel API directly.

## Production boundary

All task API modes and worker execution are gated to `VERCEL_ENV=preview`. The scheduler calls only the stable Preview branch alias. Production deployment code, environment variables, and aliases are not modified.

## Known limitations for first release

- One task stage is executed per worker tick; a multi-step task can take several minutes.
- Worker scheduling is minute-granularity.
- The first release is analysis-only and does not invoke Google/other write capabilities.
- UI progress and cancellation are implemented separately from the worker core.
