# API Usage Schema Verification — 2026-10-18

Live Supabase SQL Editor query: `SELECT COUNT(*) AS total_rows, COUNT(user_id) AS rows_with_user_id FROM public.api_usage;`

Observed result:
- `total_rows = 339`
- `rows_with_user_id = 0`

The query succeeded, confirming that `user_id` exists on `public.api_usage` and all 339 pre-existing rows remain present with null user attribution. This is expected; no historical ownership was inferred or assigned.

Next: confirm table-level privileges before choosing the least-privilege grant change. No further database change was made in this verification.