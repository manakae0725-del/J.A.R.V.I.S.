-- Reconstructed from the linked database catalog on 2026-11-02.
-- The original migration SQL was not present in Git history. This statement
-- recreates the observed index definition on a clean database.
create index if not exists memories_user_id_idx
  on public.memories using btree (user_id);
