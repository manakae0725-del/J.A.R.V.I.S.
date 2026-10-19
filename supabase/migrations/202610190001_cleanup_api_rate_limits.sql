-- J.A.R.V.I.S. cleanup for durable per-user API rate limits.
-- Apply after 202610180003_durable_api_rate_limits.sql.
-- This migration defines the cleanup function only; it does not schedule or run it.

CREATE OR REPLACE FUNCTION public.cleanup_api_rate_limits()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_deleted bigint;
BEGIN
  DELETE FROM public.api_rate_limits
  WHERE window_start < now() - interval '2 days';

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_api_rate_limits() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_api_rate_limits() TO service_role;
