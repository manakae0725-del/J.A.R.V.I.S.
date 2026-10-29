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
  anthropicModel: process.env.JARVIS_ANTHROPIC_MODEL
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
  assert.deepEqual(result.results[0], {
    ok: false,
    provider: "openai",
    error: "CONFIGURATION_MISSING",
    statusCode: null
  });
  assert.equal(calls, 0);
});
