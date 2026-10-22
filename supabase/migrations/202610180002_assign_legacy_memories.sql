-- J.A.R.V.I.S. legacy memory ownership migration.
-- Approved by the owner on 2026-10-18: assign the six NULL-owned legacy rows to their account.
-- The account UUID is taken from the supplied Supabase dashboard screenshot.
-- Correct the misspelled full-name memory to the account owner's known name.
-- REVIEW BEFORE APPLYING; this file does not execute automatically.

BEGIN;

UPDATE public.memories
SET user_id = '3d4c0913-b271-454c-a856-f950f44537cf'::uuid
WHERE id IN (2, 3, 4, 5, 6, 7)
  AND user_id IS NULL;

UPDATE public.memories
SET content = 'フルネームは達口真人である',
    updated_at = NOW()
WHERE id = 7
  AND user_id = '3d4c0913-b271-454c-a856-f950f44537cf'::uuid
  AND content = 'フルネームは龍口真人である';

COMMIT;
