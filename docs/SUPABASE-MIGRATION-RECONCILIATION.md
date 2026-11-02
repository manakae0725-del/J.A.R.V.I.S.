# Supabase migration reconciliation

Audit date: 2026-11-02  
Project: `cykqyrlgepzzgktrxhcx` (Tokyo)  
Application branch audited: `perf/response-speed-memory-cache`

## Scope and safety

This document records a read-only comparison of the repository migration directory and the linked database migration ledger/catalog. No SQL was applied and no database objects, rows, cron jobs, or Vault secrets were changed during this audit.

Do not run `supabase db reset`, re-apply the listed historical migrations, or mark migrations applied based only on this document. Reconcile each migration against its original SQL and the target database before any deployment.

## Repository files observed

The application branch contains these five files:

- `20261101154218_create_jarvis_background_task_system.sql`
- `20261101155000_add_background_task_pause_resume.sql`
- `20261101155500_harden_background_task_pause_leases.sql`
- `20261101160000_enable_background_task_scheduler.sql`
- `20261101163000_background_task_immediate_dispatch.sql`

## Database migration ledger observed

The linked database reports these ten applied versions:

| Version | Name | Repository status |
|---|---|---|
| 20261025124528 | add_memories_user_id_index | SQL file absent |
| 20261028045343 | create_google_oauth_tables | SQL file absent |
| 20261101154218 | create_jarvis_background_task_system | Exact version file present |
| 20261101154349 | enable_background_task_scheduler | Version differs from tracked 20261101160000 file |
| 20261101154912 | add_background_task_pause_resume | Version differs from tracked 20261101155000 file |
| 20261101155011 | harden_background_task_pause_leases | Version differs from tracked 20261101155500 file |
| 20261101162504 | background_task_immediate_dispatch | Version differs from tracked 20261101163000 file |
| 20261101164406 | background_task_fast_bounded_retry | SQL file absent |
| 20261101164448 | background_task_zero_delay_recovery | SQL file absent |
| 20261101175018 | add_conversation_memory_lookup_index | SQL file absent |

A timestamp/name mismatch is not proof that two SQL files are equivalent. In particular, the four later tracked files must not simply be renamed to match the ledger until their full SQL is compared with the original applied migration content.

## Live catalog observations

- Public schema has nine application tables; RLS is enabled on all nine.
- The OAuth tables exist with server-encrypted token columns and state-hash storage.
- Background task tables exist, including `verification_attempts`.
- Background task functions, immediate-dispatch triggers, and the one-minute `jarvis-background-worker` cron job exist.
- The live `jarvis_retry_background_task` function has bounded retry delay (0–60 seconds) and a retry-attempt cap.
- The catalog contains `memories_user_id_idx` and `memories_user_active_category_rank_idx`. The exact relationship of these indexes to the two memory-index migration names still needs original SQL confirmation.
- The database currently records the cron target as the Preview deployment URL for `perf/response-speed-memory-cache`. This must remain pointed at Preview while the worker implementation is not yet integrated into Production. After a verified main-branch deployment, the cron target and its Vault-backed protection configuration need an explicit cutover plan.

## Required reconciliation before main integration

1. Recover the exact original SQL for all absent ledger versions from commit history, branches, backups, or migration artifacts.
2. Compare each historical SQL file with the live catalog, including function definitions, grants, triggers, indexes, extensions, and cron configuration.
3. Restore the original versioned files without changing their version identifiers. Where exact source cannot be recovered, document the migration as an adopted baseline with evidence; do not fabricate historical SQL.
4. Check whether the five tracked files duplicate, supersede, or diverge from already-applied versions. Do not leave duplicate future migration versions that would replay the same DDL.
5. Verify a clean database can be built from the complete baseline plus ordered migrations in an isolated environment. Do not test by resetting the linked project.
6. Only after migration reconciliation and application tests pass, open/refresh a Draft PR to `main`. Keep Production unchanged until review and explicit deployment cutover.

## Separate code correction in this branch

`api/tts.js` now checks `ELEVENLABS_API_KEY` before making the voice-settings request. Previously, a missing key could cause an unnecessary unauthenticated request before the intended configuration error was returned. No provider call is made by this code edit itself.
