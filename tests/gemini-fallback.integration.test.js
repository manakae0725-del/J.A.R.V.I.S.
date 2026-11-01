const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

test("OpenAI 503 does not block the real /api/gemini handler from returning Gemini's final response", async () => {
  const root = process.cwd();
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;
  const originalLoad = Module._load;
  const calls = { openai: 0, gemini: 0 };

  Object.assign(process.env, {
    VERCEL_ENV: "preview",
    GEMINI_API_KEY: "mock-gemini-key",
    OPENAI_API_KEY: "mock-openai-key",
    JARVIS_OPENAI_MODEL: "gpt-4.1-mini",
    JARVIS_AUTO_COMMANDER_ENABLED: "true",
    JARVIS_AI_COUNCIL_ENABLED: "true",
    JARVIS_AI_COUNCIL_PAID_PROVIDERS_ENABLED: "true",
    JARVIS_AUTO_COMMANDER_PARALLEL_ENABLED: "false"
  });
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SECRET_KEY;
  delete process.env.SERPER_API_KEY;
  delete process.env.TAVILY_API_KEY;

  Module._load = function(request, parent, isMain) {
    if (parent && parent.filename === path.join(root, "api/gemini.js")) {
      if (request === "./_auth") return { requireAuth: async () => ({ id: "sandbox-test-user" }) };
      if (request === "./_rateLimit") return { enforceRateLimit: async () => true };
      if (request === "./_google/tokenStore") return { listConnectionsForUser: async () => [] };
      if (request === "./_google/client") return { googleApiRequest: async () => ({ ok: true, data: {} }) };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  global.fetch = async (url) => {
    const target = String(url);
    if (target.includes("api.openai.com")) {
      calls.openai += 1;
      const body = JSON.stringify({ error: { message: "mock provider outage" } });
      return {
        ok: false,
        status: 503,
        text: async () => body,
        json: async () => JSON.parse(body)
      };
    }
    if (target.includes("generativelanguage.googleapis.com/v1/interactions")) {
      calls.gemini += 1;
      const output = {
        reply: "OpenAI側の応答が得られなかったため、Gemini単独で回答を生成しました。",
        speechText: "Geminiによる回答です。",
        memory: { shouldSave: false, category: "personal", content: "", importance: 1 },
        visualization: { type: "none", title: "", labels: [], values: [], steps: [] }
      };
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "mock-gemini-interaction-id", output_text: JSON.stringify(output) })
      };
    }
    throw new Error("Unexpected outbound request in isolated test: " + target);
  };

  try {
    const handlerPath = path.join(root, "api/gemini.js");
    delete require.cache[require.resolve(handlerPath)];
    const handler = require(handlerPath);
    const text = "このAPI構成のセキュリティを分析し、潜在的なリスクを整理して、優先順位付きで改善案を比較してください。".repeat(2);
    const req = { method: "POST", body: { text, autoCommander: true } };
    const res = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    };

    await handler(req, res);

    assert.equal(calls.openai, 1, "the specialist OpenAI request should be attempted once");
    assert.equal(calls.gemini, 1, "Gemini final composition should still be called once");
    assert.equal(res.statusCode, 200, "the main endpoint should succeed despite OpenAI 503");
    assert.equal(res.body.text, "OpenAI側の応答が得られなかったため、Gemini単独で回答を生成しました。");
    assert.equal(res.body.interactionId, "mock-gemini-interaction-id");
    assert.equal(res.body.speechText, "Geminiによる回答です。");
  } finally {
    Module._load = originalLoad;
    global.fetch = originalFetch;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    const handlerPath = path.join(root, "api/gemini.js");
    delete require.cache[require.resolve(handlerPath)];
  }
});
