-- Revoke direct client-role privileges from tables accessed through server APIs.
-- Apply only after reviewing application access paths and taking a database backup.
-- The server-side service_role used by the API is intentionally not revoked here.

REVOKE ALL PRIVILEGES ON TABLE public.memories FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.api_usage FROM PUBLIC, anon, authenticated;

-- RLS remains enabled. This migration does not grant new privileges.
