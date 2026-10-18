import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const auth = read("../api/_auth.js");
const gemini = read("../api/gemini.js");
const tts = read("../api/tts.js");
const memory = read("../api/memory.js");
const token = read("../api/token.js");
const limiter = read("../api/_rateLimit.js");
const quotaSql = read("../supabase/migrations/202610180003_durable_api_rate_limits.sql");
const usageSql = read("../supabase/migrations/202610180001_api_usage_user_id.sql");

const checks = [
  ["shared auth validates Supabase session", /\/auth\/v1\/user/.test(auth) && /if \(!response\.ok\)/.test(auth)],
  ["Gemini requires auth and quota", /requireAuth\(req, res\)/.test(gemini) && /consumeRateLimit\(user\.id, "gemini", res\)/.test(gemini)],
  ["search quota is enforced", /consumeRateLimit\(user\.id, "search", res\)/.test(gemini)],
  ["Gemini input and context bounds exist", /text\.length > 12000/.test(gemini) && /memoryContext\.length > 12000/.test(gemini)],
  ["TTS requires auth, quota, and text bound", /requireAuth\(req, res\)/.test(tts) && /consumeRateLimit\(user\.id, "tts", res\)/.test(tts) && /text\.length > 3000/.test(tts)],
  ["memory queries are scoped to authenticated user", (memory.match(/user_id: `eq\.\$\{user\.id\}`/g) || []).length >= 3 && /user_id: user\.id/.test(memory)],
  ["token endpoint requires auth and quota", /requireAuth\(req, res\)/.test(token) && /consumeRateLimit\(user\.id, "token", res\)/.test(token)],
  ["rate limiter fails closed and has timeout", /status\(503\)/.test(limiter) && /AbortSignal\.timeout\(3000\)/.test(limiter)],
  ["rate-limit SQL restricts RPC grants", /SECURITY DEFINER/.test(quotaSql) && /REVOKE ALL ON FUNCTION public\.consume_api_quota\(uuid, text, integer\) FROM PUBLIC, anon, authenticated/.test(quotaSql) && /GRANT EXECUTE ON FUNCTION public\.consume_api_quota\(uuid, text, integer\) TO service_role/.test(quotaSql)],
  ["usage attribution migration adds user_id", /ADD COLUMN IF NOT EXISTS user_id uuid/.test(usageSql)]
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
  console.log(`All ${checks.length} static security checks passed.`);
}
