# Memory Ownership Check — 2026-10-18

Read-only query executed by the project owner:
`SELECT id, category, is_active, scope, user_id FROM public.memories ORDER BY id;`

## Observed rows

- Seven rows were returned, IDs 2 through 8.
- IDs 2, 3, 4, 5, 6, and 7 have `user_id IS NULL`.
- ID 8 has `user_id = 3d4c0913-b271-454c-a856-f950f44537cf`.
- All seven rows show `is_active = true` and `scope = personal`.
- The screenshot does not show memory content, so this check does not independently verify the exact content of ID 7.

## Next safe step

Before running the already prepared ownership migration, take a backup/export of these seven rows and verify ID 7's content without sharing private memory text unnecessarily. The migration is not applied. The six NULL-owned rows should not be reassigned until the backup and row identity are confirmed.

No database writes were performed by this check.