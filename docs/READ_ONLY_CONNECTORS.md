# Read-only external connectors

The connector API is server-side and read-only. It uses the existing J.A.R.V.I.S. Supabase session authentication and per-user rate limiter. Provider tokens are never returned by the API.

## Vercel Preview environment variables

Add the following to the **Preview** target for branch `perf/response-speed-memory-cache` only:

| Variable | Value |
|---|---|
| `GITHUB_READ_TOKEN` | GitHub fine-grained PAT with read-only access to repository metadata, contents, pull requests, issues, and commit statuses |
| `GITHUB_REPOSITORY` | `manakae0725-del/J.A.R.V.I.S.` (optional; this is the default) |
| `VERCEL_READ_TOKEN` | Vercel access token with read access to the J.A.R.V.I.S. project and deployments |
| `VERCEL_PROJECT_ID` | Existing Vercel project ID (optional; the current J.A.R.V.I.S. project ID is the default) |
| `VERCEL_TEAM_ID` | Vercel team ID (optional; current team ID is the default) |
| `SUPABASE_MANAGEMENT_TOKEN` | Supabase Management API personal access token with project read access |
| `SUPABASE_PROJECT_REF` | Supabase project reference (the subdomain in the project URL) |

Do not use a Supabase service-role key or database password as the Management API token. Do not add any token to client-side variables (for example, `NEXT_PUBLIC_*`). Do not paste token values into chat, GitHub issues, source files, or logs.

## API

All routes require the existing authenticated J.A.R.V.I.S. session. Only GET is accepted.

- `GET /api/google/status?provider=status` — reports whether each credential is configured; it never returns credential values.
- `GET /api/google/status?provider=github&action=overview|branches|commits|pulls|issues`
- `GET /api/google/status?provider=vercel&action=project|deployments`
- `GET /api/google/status?provider=supabase&action=project`

Unsupported providers/actions are rejected. The endpoint does not accept arbitrary URLs, does not proxy user-supplied destinations, and does not expose write operations. Upstream calls have a 10-second timeout and response-size cap.

## Rollout

1. Add credentials to the Preview environment only.
2. Wait for the Preview deployment to become Ready.
3. Sign in to the Preview app and call the status endpoint.
4. Verify each provider's read-only overview.
5. Keep Production and the Supabase database unchanged until separate approval.
