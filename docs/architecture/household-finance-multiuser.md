# Household Finance — Separate Account Access Model

Decision: Manato and Kaede will sign in with separate J.A.R.V.I.S. accounts.

This document extends `household-finance-design.md`. It is a design specification only; no database migration or application code is changed here.

## Required behavior

- Each person authenticates with their own J.A.R.V.I.S. account.
- Both accounts can access one explicitly shared household finance space after an invitation/acceptance flow.
- A user's private memories, conversations, and unrelated data must never become visible to the other household member. Manato's designated payslip folder is a narrowly scoped exception for household finance processing; it does not grant Kaede general Drive access.
- Household finance data is shared only within the household boundary.
- Each write records the authenticated actor (`created_by`) and the household (`household_id`).
- Removing a member revokes future access immediately; historical audit records remain attributable to the actor.
- No account may add a member or change roles without an authorized owner action.

## Proposed logical model

### `finance_households`
- `id` UUID primary key
- `name` text
- `created_by` UUID references auth.users
- timestamps

### `finance_household_members`
- `household_id` UUID
- `user_id` UUID references auth.users
- `role` constrained to owner/member
- `status` constrained to active/revoked
- `invited_by` UUID
- timestamps
- unique active membership per household/user

### Household-scoped records
All shared finance tables include:
- `household_id`
- `created_by`
- `created_at`, `updated_at`
- a strict foreign key to the household

This applies to transactions, account display labels, recurring items, balance snapshots, and shared document metadata.

## Privacy classification

Use explicit visibility on sensitive records:
- `household`: visible to active household members.
- `owner_only`: visible only to the record owner.

Salary records and payslip metadata should default to `owner_only`. The person whose payslip it is must explicitly confirm sharing the parsed salary details with the household before they become household-visible. A Drive PDF itself is never shared by copying it or changing Drive permissions automatically.

Each user connects their own Google Drive account. J.A.R.V.I.S. may read only files that the connected user has authorized and selected/designated. The file owner confirms the extracted fields. Sharing parsed salary figures with the household is a separate explicit action.

## RLS and authorization requirements

- Enable RLS on every household finance table.
- Do not grant broad `authenticated` access without household membership checks.
- Use a carefully reviewed `SECURITY DEFINER` membership predicate with a fixed `search_path` to avoid recursive RLS policy evaluation.
- Revoke direct table access from `anon`; authenticated policies must check active membership and visibility.
- Writes must set `created_by = auth.uid()` and validate household membership/role server-side or through database constraints/triggers.
- Owner-only salary rows must additionally check `owner_id = auth.uid()`.
- Membership creation, invitation acceptance, role changes, and revocation must be explicit, audited actions.
- Test cross-household isolation, revoked-member denial, owner-only salary privacy, and unauthorized writes.

## Open decisions to resolve before implementation

1. Whether the household should be created by Manato's account and Kaede invited, or vice versa.
2. Salary visibility: decided — both members' confirmed salary data is shared household finance data.
3. Whether both members may correct/delete shared transactions, or only the creator/household owner. Recommended: both may add and correct; deletion should be a reversible void with audit history.

## Implementation gates

- Inspect the current auth identity and Manato's Google Drive connection ownership model in source.
- Design migrations and RLS policies locally first.
- Test with two distinct test users and at least two households.
- Do not modify the live Supabase project until the user explicitly approves the exact migration.
- Do not deploy or merge to main without separate approval.
