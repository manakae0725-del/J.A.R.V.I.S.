# Memory DELETE API verification — 2026-10-18

## Current result
- GitHub Actions static source checks passed on the earlier audited commit. This is source inspection, not runtime or live-database verification.
- `api/memory.js` exposes owner-scoped soft-delete using `user_id`, `is_active=true`, and a numeric memory ID.
- The frontend currently has no DELETE caller or memory-delete control; the API endpoint alone does not provide a user-facing delete workflow.
- Supabase policy/function inspection queries returned no rows for the selected filters. This does not prove all database permissions are safe; the quota table/function existence query returned NULL for both objects, and `api_usage.user_id` exists.
- No migration has been applied to the production database. No production data was modified.

## Next verification required
1. Inspect the full policy and function grant outputs from Supabase SQL Editor, including exact function signatures and grants to PUBLIC, anon, authenticated, and service_role.
2. Verify current table definitions and legacy memory rows before considering any data migration.
3. Add mocked runtime tests for DELETE: valid owner-scoped soft delete, invalid ID, other-user/not-found, database failure, and auth failure.
4. Run live memory save/read/delete/restart checks only after test account/data and rollback are confirmed.

## Safety
Do not run a migration or any SQL flagged as destructive until its exact SQL is reviewed. The read-only preflight checks should be run separately from migrations. Keep the security branch separate from `main`; do not merge the draft PR until runtime and permissions checks pass.
