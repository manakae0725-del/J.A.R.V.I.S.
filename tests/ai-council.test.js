const test = require("node:test");
const assert = require("node:assert/strict");
const { runAiCouncil } = require("../api/_aiCouncil");

const originalFetch = global.fetch;
const originalEnv = {
  enabled: process.env.JARVIS_AI_COUNCIL_ENABLED,
  geminiKey: process.env.GEMINI_API_KEY,
  openaiKey: process.env.OPENAI_API_KEY,
  openaiModel: process.env.JARVIS_OPENAI_MODEL,
  anthropicKey: process.env.ANTHROPIC_API_KEY,
  anthropicModel: process.env.JARVIS_ANTHROPIC_MODEL,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_SECRET_KEY
};

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test.afterEach(() => {
  global.fetch = originalFetch;
  restoreEnv("JARVIS_AI_COUNCIL_ENABLED", originalEnv.enabled);
  restoreEnv("GEMINI_API_KEY", originalEnv.geminiKey);
  restoreEnv("OPENAI_API_KEY", originalEnv.openaiKey);
  restoreEnv("JARVIS_OPENAI_MODEL", originalEnv.openaiModel);
  restoreEnv("ANTHROPIC_API_KEY", originalEnv.anthropicKey);
  restoreEnv("JARVIS_ANTHROPIC_MODEL", originalEnv.anthropicModel);
  restoreEnv("SUPABASE_URL", originalEnv.supabaseUrl);
  restoreEnv("SUPABASE_SECRET_KEY", originalEnv.supabaseKey);
});

test("council is disabled unless explicitly enabled", async () => {
  delete process.env.JARVIS_AI_COUNCIL_ENABLED;
  await assert.rejects(
    runAiCouncil({ userInput: "test" }),
    error => error.code === "COUNCIL_DISABLED"
  );
});

test("rejects unknown or duplicate providers before making requests", async () => {
  process.env.JARVIS_AI_COUNCIL_ENABLED = "true";
  let calls = 0;
  global.fetch = async () => { calls++; throw new Error("should not be called"); };
  await assert.rejects(
    runAiCouncil({ userInput: "test", providers: ["unknown"] }),
    error => error.code === "INVALID_PROVIDER_SELECTION"
  );
  await assert.rejects(
    runAiCouncil({ userInput: "test", providers: ["gemini", "gemini"] }),
    error => error.code === "INVALID_PROVIDER_SELECTION"
  );
  assert.equal(calls, 0);
});

test("uses a mocked Gemini response and never needs a live API call", async () => {
  process.env.JARVIS_AI_COUNCIL_ENABLED = "true";
  process.env.GEMINI_API_KEY = "test-key-not-real";
  let captured;
  global.fetch = async (url, options) => {
    captured = { url, options };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ output_text: "mocked answer" })
    };
  };
  const result = await runAiCouncil({
    userInput: "test task",
    providers: ["gemini"],
    timeoutMs: 2000,
    maxOutputTokens: 100
  });
  assert.equal(captured.url, "https://generativelanguage.googleapis.com/v1/interactions");
  assert.equal(captured.options.headers["x-goog-api-key"], "test-key-not-real");
  assert.equal(result.providerCount, 1);
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[0].text, "mocked answer");
});

test("reports missing OpenAI configuration without calling the network", async () => {
  process.env.JARVIS_AI_COUNCIL_ENABLED = "true";
  delete process.env.OPENAI_API_KEY;
  delete process.env.JARVIS_OPENAI_MODEL;
  let calls = 0;
  global.fetch = async () => { calls++; throw new Error("should not be called"); };
  const result = await runAiCouncil({ userInput: "test", providers: ["openai"] });
  assert.equal(result.results[0].ok, false);
  assert.equal(result.results[0].provider, "openai");
  assert.equal(result.results[0].error, "CONFIGURATION_MISSING");
  assert.equal(result.results[0].statusCode, null);
  assert.equal(typeof result.results[0].durationMs, "number");
  assert.equal(calls, 0);
});


test("normalizes provider rate limits without leaking response details", async () => {
  process.env.JARVIS_AI_COUNCIL_ENABLED = "true";
  process.env.GEMINI_API_KEY = "test-key-not-real";
  global.fetch = async () => ({
    ok: false,
    status: 429,
    text: async () => JSON.stringify({ error: { message: "private provider detail" } })
  });
  const result = await runAiCouncil({ userInput: "test", providers: ["gemini"] });
  assert.equal(result.results[0].ok, false);
  assert.equal(result.results[0].error, "RATE_LIMITED");
  assert.equal(result.results[0].statusCode, 429);
  assert.equal("text" in result.results[0], false);
});

test("normalizes request timeout and rejects oversized input before network access", async () => {
  process.env.JARVIS_AI_COUNCIL_ENABLED = "true";
  process.env.GEMINI_API_KEY = "test-key-not-real";
  let calls = 0;
  global.fetch = async (_url, options) => {
    calls++;
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  };
  const timeoutResult = await runAiCouncil({ userInput: "test", providers: ["gemini"] });
  assert.equal(timeoutResult.results[0].error, "TIMEOUT");
  await assert.rejects(
    runAiCouncil({ userInput: "x".repeat(24001), providers: ["gemini"] }),
    error => error.code === "INVALID_INPUT"
  );
  assert.equal(calls, 1);
});


test("continues with OpenAI when the parallel Gemini analyst fails", async () => {
  process.env.JARVIS_AI_COUNCIL_ENABLED = "true";
  process.env.GEMINI_API_KEY = "test-key-not-real";
  process.env.OPENAI_API_KEY = "test-key-not-real";
  process.env.JARVIS_OPENAI_MODEL = "test-model";
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SECRET_KEY;
  global.fetch = async url => {
    if (String(url).includes("generativelanguage.googleapis.com")) {
      return { ok: false, status: 503, text: async () => JSON.stringify({ error: { message: "simulated Gemini outage" } }) };
    }
    if (String(url).includes("api.openai.com")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ output_text: "OpenAI analysis survived" }) };
    }
    throw new Error("Unexpected network target");
  };
  const result = await runAiCouncil({ userInput: "test", providers: ["gemini", "openai"] });
  assert.equal(result.results[0].ok, false);
  assert.equal(result.results[0].provider, "gemini");
  assert.equal(result.results[0].error, "PROVIDER_UNAVAILABLE");
  assert.equal(result.results[1].ok, true);
  assert.equal(result.results[1].provider, "openai");
  assert.equal(result.results[1].text, "OpenAI analysis survived");
});

test("continues with Gemini when the parallel OpenAI analyst fails", async () => {
  process.env.JARVIS_AI_COUNCIL_ENABLED = "true";
  process.env.GEMINI_API_KEY = "test-key-not-real";
  process.env.OPENAI_API_KEY = "test-key-not-real";
  process.env.JARVIS_OPENAI_MODEL = "test-model";
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SECRET_KEY;
  global.fetch = async url => {
    if (String(url).includes("generativelanguage.googleapis.com")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ output_text: "Gemini analysis survived" }) };
    }
    if (String(url).includes("api.openai.com")) {
      return { ok: false, status: 503, text: async () => JSON.stringify({ error: { message: "simulated OpenAI outage" } }) };
    }
    throw new Error("Unexpected network target");
  };
  const result = await runAiCouncil({ userInput: "test", providers: ["gemini", "openai"] });
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[0].provider, "gemini");
  assert.equal(result.results[0].text, "Gemini analysis survived");
  assert.equal(result.results[1].ok, false);
  assert.equal(result.results[1].provider, "openai");
  assert.equal(result.results[1].error, "PROVIDER_UNAVAILABLE");
});

test("returns both provider failures without rejecting the entire council request", async () => {
  process.env.JARVIS_AI_COUNCIL_ENABLED = "true";
  process.env.GEMINI_API_KEY = "test-key-not-real";
  process.env.OPENAI_API_KEY = "test-key-not-real";
  process.env.JARVIS_OPENAI_MODEL = "test-model";
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SECRET_KEY;
  global.fetch = async () => ({
    ok: false,
    status: 503,
    text: async () => JSON.stringify({ error: { message: "simulated provider outage" } })
  });
  const result = await runAiCouncil({ userInput: "test", providers: ["gemini", "openai"] });
  assert.equal(result.providerCount, 2);
  assert.equal(result.results.length, 2);
  assert.equal(result.results.every(item => item.ok === false), true);
  assert.deepEqual(result.results.map(item => item.provider), ["gemini", "openai"]);
  assert.equal(result.results.every(item => item.error === "PROVIDER_UNAVAILABLE"), true);
});
