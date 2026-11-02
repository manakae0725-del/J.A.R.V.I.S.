import { readFileSync, existsSync } from "node:fs";
import assert from "node:assert/strict";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const auth = read("../api/_auth.js");
const gemini = read("../api/gemini.js");
const tts = read("../api/tts.js");
const memory = read("../api/memory.js");
const limiter = read("../api/_rateLimit.js");
const background = read("../lib/backgroundTasks.js");
const taskMigration = read("../supabase/migrations/20261101154218_create_jarvis_background_task_system.sql");

const keyGuard = tts.indexOf("if (!apiKey)");
const settingsCall = tts.indexOf("const settingsResponse");

const checks = [
  ["auth validates bearer sessions against Supabase", /\/auth\/v1\/user/.test(auth) && /Authorization: `Bearer \\${match\[1\]}`/.test(auth)],
  ["auth session verification has an 8-second timeout", /AbortSignal\.timeout\(8000\)/.test(auth)],
  ["auth access is restricted by explicit user allowlist", /JARVIS_ALLOWED_USER_IDS/.test(auth) && /allowedUserIds\.includes\(user\.id\)/.test(auth)],
  ["Gemini requires authentication", /requireAuth\(req, res\)/.test(gemini)],
  ["Gemini applies per-user rate limits", /enforceRateLimit\(res, user, "gemini-minute"/.test(gemini) && /enforceRateLimit\(res, user, "gemini-day"/.test(gemini)],
  ["TTS requires authentication and rate limits", /requireAuth\(req, res\)/.test(tts) && /enforceRateLimit\(res, user, "tts-minute"/.test(tts)],
  ["TTS checks API key before voice-settings request", keyGuard >= 0 && settingsCall > keyGuard],
  ["memory requires authentication and rate limits", /requireAuth\(req, res\)/.test(memory) && /enforceRateLimit\(res, user, "memory-minute"/.test(memory)],
  ["memory reads and writes use authenticated user ID", /user_id: `eq\.\$\{user\.id\}`/.test(memory) && /p_user_id: user\.id/.test(memory)],
  ["rate limiter uses the current atomic RPC and fails closed", /jarvis_check_rate_limit/.test(limiter) && /status\(503\)/.test(limiter) && /typeof decision\.allowed !== "boolean"/.test(limiter)],
  ["background task storage uses owner-scoped queries", /user_id: "eq\." \+ userId/.test(background) && /jarvis_enqueue_background_task/.test(background)],
  ["background task base migration defines RLS and service-role-only grants", /enable row level security/i.test(taskMigration) && /revoke all on public\.jarvis_background_tasks.*anon,authenticated/is.test(taskMigration) && /to service_role/i.test(taskMigration)],
  ["obsolete ephemeral token endpoint is absent", !existsSync(new URL("../api/token.js", import.meta.url))]
];

let failures = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) failures++;
}
if (failures) {
  console.error(`${failures} static security check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log(`All ${checks.length} current-source security checks passed.`);
}
