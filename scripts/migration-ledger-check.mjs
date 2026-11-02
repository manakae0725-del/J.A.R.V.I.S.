import { readdirSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const migrationDir = join(root, "../supabase/migrations");
const expected = [
  "20261025124528_add_memories_user_id_index.sql",
  "20261028045343_create_google_oauth_tables.sql",
  "20261101154218_create_jarvis_background_task_system.sql",
  "20261101154349_enable_background_task_scheduler.sql",
  "20261101154912_add_background_task_pause_resume.sql",
  "20261101155011_harden_background_task_pause_leases.sql",
  "20261101162504_background_task_immediate_dispatch.sql",
  "20261101164406_background_task_fast_bounded_retry.sql",
  "20261101164448_background_task_zero_delay_recovery.sql",
  "20261101175018_add_conversation_memory_lookup_index.sql"
].sort();

const actual = readdirSync(migrationDir).filter(name => name.endsWith(".sql")).sort();
assert.deepEqual(actual, expected, "Migration files must match the applied Supabase ledger exactly");

const versions = actual.map(name => name.slice(0, 14));
assert.equal(new Set(versions).size, versions.length, "Migration version prefixes must be unique");

for (const name of actual) {
  const sql = readFileSync(join(migrationDir, name), "utf8");
  assert.ok(sql.trim().length > 0, `${name} must not be empty`);
  assert.ok(!/\b(drop\s+table|truncate\s+table)\b/i.test(sql), `${name} contains a destructive table operation`);
  console.log(`PASS migration source present: ${name}`);
}

const retryMarker = readFileSync(join(migrationDir, "20261101164406_background_task_fast_bounded_retry.sql"), "utf8");
assert.match(retryMarker, /original intermediate SQL unavailable/i);
const retryFinal = readFileSync(join(migrationDir, "20261101164448_background_task_zero_delay_recovery.sql"), "utf8");
assert.match(retryFinal, /greatest\(0, least\(coalesce\(p_retry_delay_seconds, 0\), 60\)\)/);
assert.match(retryFinal, /p_retry_delay_seconds integer default 0/);

const scheduler = readFileSync(join(migrationDir, "20261101154349_enable_background_task_scheduler.sql"), "utf8");
assert.match(scheduler, /cron\.schedule/);
assert.match(scheduler, /jarvis_background_worker_secret/);
assert.match(scheduler, /jarvis_vercel_protection_bypass/);
console.log("PASS migration version ledger and critical safety assertions");
