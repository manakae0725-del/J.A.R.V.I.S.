-- Reconstructed from the linked database catalog on 2026-11-02.
-- This is the observed partial index used for per-user active memory lookup.
create index if not exists memories_user_active_category_rank_idx
  on public.memories using btree (user_id, category, importance desc, updated_at desc)
  where (is_active = true);
