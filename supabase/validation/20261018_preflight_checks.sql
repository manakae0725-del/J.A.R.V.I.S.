-- J.A.R.V.I.S. Supabase preflight checks (READ ONLY).
-- Run these queries in Supabase SQL Editor BEFORE applying any migration.
-- Review the returned data locally; do not paste private memory content or secrets into chat.

-- 1) Verify legacy memory row IDs and ownership before the owner-assignment migration.
SELECT id, category, importance, is_active, scope, user_id,
       CASE
         WHEN content = 'フルネームは龍口真人である' THEN '[expected legacy name typo]'
         ELSE left(content, 60)
       END AS content_preview
FROM public.memories
WHERE id BETWEEN 1 AND 10
ORDER BY id;

-- 2) Count NULL-owned memory rows and total rows.
SELECT
  count(*) AS total_memories,
  count(*) FILTER (WHERE user_id IS NULL) AS null_owner_memories,
  count(*) FILTER (WHERE user_id IS NOT NULL) AS owned_memories
FROM public.memories;

-- 3) Inspect actual api_usage columns before adding user_id.
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'api_usage'
ORDER BY ordinal_position;

-- 4) Inspect current RLS state and policies for the relevant tables.
SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS force_rls
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname IN ('memories', 'api_usage')
ORDER BY c.relname;

SELECT schemaname, tablename, policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename IN ('memories', 'api_usage')
ORDER BY tablename, policyname;

-- Quota-table/function checks are intentionally excluded here because the migration
-- has not been applied. Verify them only in a separate post-migration check.
