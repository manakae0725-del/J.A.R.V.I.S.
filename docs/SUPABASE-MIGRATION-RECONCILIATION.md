# Supabase migration reconciliation

Audit date: 2026-11-02  
Project: `cykqyrlgepzzgktrxhcx` (Tokyo)  
Application branch audited: `perf/response-speed-memory-cache`

## Safety

All Supabase inspection in this reconciliation was read-only. No SQL was applied to the linked database. No rows, grants, extensions, cron jobs, Vault secrets, or production deployment were changed.

Do not run `supabase db reset` against the linked project or replay its applied migrations. Validate the restored chain in an isolated environment first.

## Result: migration filenames now align with the live ledger

The linked database reports ten applied versions. The development branch now contains ten SQL files with matching version prefixes and names:

| Applied version | Migration | Source status |
|---|---|---|
| 20261025124528 | add_memories_user_id_index | Reconstructed from live index definition |
| 20261028045343 | create_google_oauth_tables | Reconstructed from live table/constraint/index catalog |
| 20261101154218 | create_jarvis_background_task_system | Existing tracked migration |
| 20261101154349 | enable_background_task_scheduler | Existing tracked SQL aligned to ledger version; cron job definition supplemented from live catalog |
| 20261101154912 | add_background_task_pause_resume | Existing tracked SQL moved to the applied ledger version |
| 20261101155011 | harden_background_task_pause_leases | Existing tracked SQL moved to the applied ledger version |
| 20261101162504 | background_task_immediate_dispatch | Existing tracked SQL moved to the applied ledger version |
| 20261101164406 | background_task_fast_bounded_retry | Deliberate no-op reconciliation marker; original intermediate SQL unavailable |
| 20261101164448 | background_task_zero_delay_recovery | Final retry function reconstructed from live `pg_proc` definition |
| 20261101175018 | add_conversation_memory_lookup_index | Reconstructed from live index definition |

The four provisional files whose timestamps did not match the database ledger were replaced by files using the applied version identifiers. Their old filenames were removed to prevent duplicate future migrations.

## Important provenance limits

The original SQL for several applied versions was not found in Git history or retained branches. The restored files are therefore not represented as exact historical copies:

- The memory and Google OAuth migrations recreate the observed catalog objects.
- The scheduler migration retains the tracked function/table changes and restores the current one-minute Preview worker job using Vault secret names only. It schedules the job only when both required secret entries exist. The linked project currently has both entries configured; secret values were not read or exposed.
- The 20261101164406 file is intentionally comment-only. The original intermediate retry implementation could not be recovered, so no speculative retry policy was invented.
- The 20261101164448 migration recreates the current retry function, including the 0–60 second delay clamp and zero-second default.

This restores a coherent versioned chain and its final observed database behavior, but it does not prove byte-for-byte historical fidelity. The comment-only intermediate migration also means a clean replay will reproduce the final state, not the unknown intermediate behavior that once existed between those versions.

## Live catalog facts used

- `memories_user_id_idx`: btree on `memories(user_id)`.
- `memories_user_active_category_rank_idx`: btree on `(user_id, category, importance DESC, updated_at DESC)`, partial predicate `is_active = true`.
- Google OAuth tables have server-only grants, RLS enabled, and no client policies. Token values are stored in ciphertext columns.
- Background task tables, pause/resume/lease functions, retry/correction functions, immediate-dispatch triggers, and the one-minute `jarvis-background-worker` cron job exist.
- The current cron job calls the Preview worker URL. Keep it Preview-only until a reviewed Production cutover is performed.
- The retry function currently clamps requested delay to 0–60 seconds and defaults to zero.

## Validation still required

1. Run a clean migration replay in an isolated Supabase/Postgres environment with the Supabase-managed schemas/extensions required by the migrations.
2. Compare resulting columns, constraints, indexes, function definitions, grants, triggers, and cron configuration with the linked database catalog.
3. Verify the cron job is created only when the two Vault secret names are provisioned, and verify its target remains Preview.
4. Run application CI and Preview smoke tests, including memory ownership, rate-limit failure paths, TTS provider failures, and background-task enqueue/claim/retry/recovery.
5. Only then prepare the consolidated Draft PR from the development branch to `main`.

## No linked-database migration was executed

The files in this branch are source-control reconciliation only. They have not been applied to Supabase and do not change the live migration ledger.
