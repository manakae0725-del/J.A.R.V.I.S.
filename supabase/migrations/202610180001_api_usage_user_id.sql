-- J.A.R.V.I.S. security migration: attribute new API usage rows to authenticated users.
-- Review before applying. This is additive and leaves existing rows unchanged.
-- Do not add RLS policies until the app's intended access model is finalized.

ALTER TABLE public.api_usage
  ADD COLUMN IF NOT EXISTS user_id uuid
  REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS api_usage_user_id_created_at_idx
  ON public.api_usage (user_id, created_at DESC);
