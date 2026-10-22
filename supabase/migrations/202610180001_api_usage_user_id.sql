-- J.A.R.V.I.S. security migration: attribute new API usage rows to authenticated users.
-- Review before applying. Existing rows remain unchanged and user_id stays nullable.
-- This migration also repairs environments where the column/index already exist but
-- the auth.users foreign key is missing. Do not add RLS policies until the app's
-- intended access model is finalized.

ALTER TABLE public.api_usage
  ADD COLUMN IF NOT EXISTS user_id uuid;

DO $$
DECLARE
  user_id_attnum smallint;
BEGIN
  SELECT attnum
    INTO user_id_attnum
  FROM pg_attribute
  WHERE attrelid = 'public.api_usage'::regclass
    AND attname = 'user_id'
    AND NOT attisdropped;

  IF user_id_attnum IS NULL THEN
    RAISE EXCEPTION 'public.api_usage.user_id column is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = 'public.api_usage'::regclass
      AND c.contype = 'f'
      AND c.confrelid = 'auth.users'::regclass
      AND c.conkey = ARRAY[user_id_attnum]::smallint[]
  ) THEN
    ALTER TABLE public.api_usage
      ADD CONSTRAINT api_usage_user_id_fkey
      FOREIGN KEY (user_id)
      REFERENCES auth.users(id)
      ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS api_usage_user_id_created_at_idx
  ON public.api_usage (user_id, created_at DESC);
