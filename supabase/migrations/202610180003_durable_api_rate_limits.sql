-- J.A.R.V.I.S. durable per-user API rate limits.
-- Apply only after review and before deploying code that calls consume_api_quota.
-- Defaults are supplied by the API; the database enforces an atomic per-user/service minute window.

CREATE TABLE IF NOT EXISTS public.api_rate_limits (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  service text NOT NULL CHECK (service IN ('gemini', 'search', 'tts', 'token')),
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  PRIMARY KEY (user_id, service, window_start)
);

CREATE INDEX IF NOT EXISTS api_rate_limits_window_start_idx
  ON public.api_rate_limits (window_start);

ALTER TABLE public.api_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.api_rate_limits FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.consume_api_quota(
  p_user_id uuid,
  p_service text,
  p_limit integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_window_start timestamptz;
  v_count integer;
BEGIN
  IF p_user_id IS NULL
     OR p_service IS NULL
     OR p_service NOT IN ('gemini', 'search', 'tts', 'token')
     OR p_limit IS NULL
     OR p_limit < 1
     OR p_limit > 1000 THEN
    RAISE EXCEPTION 'Invalid quota request';
  END IF;

  v_window_start := date_trunc('minute', now());

  INSERT INTO public.api_rate_limits (user_id, service, window_start, request_count)
  VALUES (p_user_id, p_service, v_window_start, 1)
  ON CONFLICT (user_id, service, window_start)
  DO UPDATE SET request_count = public.api_rate_limits.request_count + 1
  WHERE public.api_rate_limits.request_count < p_limit
  RETURNING request_count INTO v_count;

  IF v_count IS NULL THEN
    RETURN false;
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_api_quota(uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_api_quota(uuid, text, integer) TO service_role;

-- Retention note: old minute windows are not needed for quota enforcement.
-- After validating the project has no scheduled maintenance job, configure a
-- reviewed scheduled DELETE for rows older than 2 days, or run manually:
-- DELETE FROM public.api_rate_limits WHERE window_start < now() - interval '2 days';
