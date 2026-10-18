# Supabase Preflight Results — 2026-10-18

This note records the project owner's screenshots from the Supabase SQL Editor. No database writes or migrations were executed during these checks.

## Observed results

1. `memories` and `api_usage` both report RLS enabled; `force_rls` is false for both.
2. Querying `pg_policies` for these two tables returned zero rows. There are currently no RLS policies for either table.
3. `has_table_privilege` returned `true` for `SELECT` for roles `anon`, `authenticated`, and `service_role` on both tables.

## Interpretation

- The `anon` and `authenticated` database roles have table-level SELECT privileges, but the absence of RLS policies means ordinary requests subject to RLS do not get row access through these tables. This should not be treated as a complete least-privilege configuration.
- The service-role credential bypasses RLS. The active server-side memory API must continue to enforce ownership using the authenticated user's ID in every read/update/deactivation query; source inspection shows owner filters are present. Live cross-account tests are still outstanding.
- Do not add broad RLS policies or revoke grants blindly. First confirm all access paths and the intended access model, then make a reviewed least-privilege migration and validate the app in Preview.

## Not yet verified

- Actual memory row IDs, ownership and exact content.
- `api_usage` schema migration and user attribution in the live database.
- Runtime isolation between accounts, persistence across restart, and memory deletion behavior.
- Durable rate-limit migration and its function/table grants. The `api_rate_limits` table does not exist yet; the earlier preflight script incorrectly queried it before migration and was corrected to exclude post-migration checks.

## State

- The checks above were read-only.
- No migration has been applied and no production data was modified.
- PR #2 remains unmerged. Static checks and mocked memory DELETE API tests passed in GitHub Actions; these do not replace live Supabase/Preview testing.