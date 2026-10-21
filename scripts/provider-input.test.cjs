const test = require("node:test");
const assert = require("node:assert/strict");

const authPath = require.resolve("../api/_auth");
const ratePath = require.resolve("../api/_rateLimit");
const geminiPath = require.resolve("../api/gemini");

async function runGemini(body, providerResponse) {
  const originalFetch = global.fetch;
  const envKeys = ["SUPABASE_URL", "SUPABASE_SECRET_KEY", "GEMINI_API_KEY", "SERPER_API_KEY", "TAVILY_API_KEY"];
  const originalEnv = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
  const modules = new Map([authPath, ratePath, geminiPath].map(k => [k, require.cache[k]]));
  const requests = [];
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "test-secret";
  process.env.GEMINI_API_KEY = "test-gemini";
  delete process.env.SERPER_API_KEY;
  delete process.env.TAVILY_API_KEY;
  require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: { requireAuth: async () => ({ id: "user-A" }) } };
  require.cache[ratePath] = { id: ratePath, filename: ratePath, loaded: true, exports: { consumeRateLimit: async () => true } };
  delete require.cache[geminiPath];
  global.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).includes("/rest/v1/api_usage")) return { ok: true, status: 201, async json() { return {}; } };
    if (String(url).includes("/v1/interactions") && providerResponse) {\n      if (providerResponse instanceof Error) throw providerResponse;\n      return providerResponse;\n    }
    throw new Error("Unexpected outbound request");
  };
  try {
    const handler = require("../api/gemini");
    const res = { statusCode: 200, body: undefined, headers: {}, setHeader(k,v) { this.headers[k]=v; }, status(code) { this.statusCode=code; return this; }, json(body) { this.body=body; return this; } };
    await handler({ method: "POST", headers: { authorization: "Bearer test" }, body }, res);
    return { res, requests };
  } finally {
    global.fetch = originalFetch;
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    for (const key of [authPath, ratePath, geminiPath]) {
      delete require.cache[key];
      if (modules.get(key)) require.cache[key] = modules.get(key);
    }
  }
}

test("Gemini text above 12000 characters is rejected before provider calls", async () => {
  const { res, requests } = await runGemini({ text: "x".repeat(12001) });
  assert.equal(res.statusCode, 413);
  assert.deepEqual(res.body, { error: "Text input is too long." });
  assert.equal(requests.length, 0);
});

test("Gemini memory context above 12000 characters is rejected before provider calls", async () => {
  const { res, requests } = await runGemini({ text: "valid", memoryContext: "x".repeat(12001) });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: "Invalid memory context." });
  assert.equal(requests.length, 0);
});

test("Gemini previous interaction ID above 200 characters is rejected before provider calls", async () => {
  const { res, requests } = await runGemini({ text: "valid", previousInteractionId: "x".repeat(201) });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: "Invalid conversation state." });
  assert.equal(requests.length, 0);
});

test("TTS rejects text above 3000 characters before calling paid provider", async () => {
  const originalFetch = global.fetch;
  const envKeys = ["SUPABASE_URL", "SUPABASE_SECRET_KEY", "ELEVENLABS_API_KEY"];
  const originalEnv = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
  const modules = new Map([authPath, ratePath].map(k => [k, require.cache[k]]));
  const requests = [];
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "test-secret";
  process.env.ELEVENLABS_API_KEY = "test-elevenlabs";
  require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: { requireAuth: async () => ({ id: "user-A" }) } };
  require.cache[ratePath] = { id: ratePath, filename: ratePath, loaded: true, exports: { consumeRateLimit: async () => true } };
  global.fetch = async (url, options = {}) => { requests.push({ url: String(url), options }); throw new Error("Paid provider must not be called"); };
  try {
    const { default: handler } = await import("../api/tts.js");
    const res = { statusCode: 200, body: undefined, headers: {}, setHeader(k,v) { this.headers[k]=v; }, status(code) { this.statusCode=code; return this; }, json(body) { this.body=body; return this; } };
    await handler({ method: "POST", headers: { authorization: "Bearer test" }, body: { text: "x".repeat(3001) } }, res);
    assert.equal(res.statusCode, 413);
    assert.deepEqual(res.body, { error: "Text input is too long." });
    assert.equal(requests.length, 0);
  } finally {
    global.fetch = originalFetch;
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    for (const key of [authPath, ratePath]) {
      delete require.cache[key];
      if (modules.get(key)) require.cache[key] = modules.get(key);
    }
  }
});


test("Gemini non-OK response with non-JSON body returns sanitized 502", async () => {
  const providerResponse = {
    ok: false,
    status: 500,
    async json() { throw new Error("private provider response"); }
  };
  const { res } = await runGemini({ text: "hello" }, providerResponse);
  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.body, { error: "AI service unavailable." });
});

test("Gemini successful HTTP response with invalid JSON returns sanitized 502", async () => {
  const providerResponse = {
    ok: true,
    status: 200,
    async json() { throw new Error("private provider response"); }
  };
  const { res } = await runGemini({ text: "hello" }, providerResponse);
  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.body, { error: "AI service returned an invalid response." });
});


test("Gemini network failure returns a sanitized 502 and logs only safe metadata", async () => {
  const { res, requests } = await runGemini({ text: "private prompt text" });
  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.body, { error: "Gemini connection failed" });

  const logRequest = requests.find(request => request.url.includes("/rest/v1/api_usage"));
  assert.ok(logRequest, "usage log request should be attempted");
  const logBody = JSON.parse(logRequest.options.body);
  assert.equal(logBody.user_id, "user-A");
  assert.equal(logBody.provider, "gemini");
  assert.equal(logBody.service, "generation");
  assert.equal(logBody.success, false);
  assert.equal(logBody.status_code, null);
  assert.deepEqual(logBody.metadata, { failureType: "request_failed" });
  assert.equal(JSON.stringify(logBody).includes("private prompt text"), false);
});

test("Gemini timeout returns a sanitized 504 and logs a failed request", async () => {
  const timeout = new Error("private timeout detail");
  timeout.name = "AbortError";
  const { res, requests } = await runGemini({ text: "timeout test" }, timeout);
  assert.equal(res.statusCode, 504);
  assert.deepEqual(res.body, { error: "Gemini request timed out" });
  const logRequest = requests.find(request => request.url.includes("/rest/v1/api_usage"));
  assert.ok(logRequest, "usage log request should be attempted");
  const logBody = JSON.parse(logRequest.options.body);
  assert.equal(logBody.success, false);
  assert.equal(logBody.status_code, null);
  assert.deepEqual(logBody.metadata, { failureType: "request_failed" });
  assert.equal(JSON.stringify(logBody).includes("private timeout detail"), false);
});
