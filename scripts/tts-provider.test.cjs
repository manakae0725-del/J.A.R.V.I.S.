const test = require("node:test");
const assert = require("node:assert/strict");

const authPath = require.resolve("../api/_auth");
const ratePath = require.resolve("../api/_rateLimit");
const originalAuth = require.cache[authPath];
const originalRate = require.cache[ratePath];

require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: { requireAuth: async () => ({ id: "user-A" }) }
};
require.cache[ratePath] = {
  id: ratePath,
  filename: ratePath,
  loaded: true,
  exports: { consumeRateLimit: async () => true }
};

let handlerPromise;
async function getHandler() {
  if (!handlerPromise) handlerPromise = import("../api/tts.js").then(mod => mod.default);
  return handlerPromise;
}

async function runTts(providerFetch) {
  const originalFetch = global.fetch;
  const keys = ["SUPABASE_URL", "SUPABASE_SECRET_KEY", "ELEVENLABS_API_KEY"];
  const originalEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const requests = [];

  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "test-secret";
  process.env.ELEVENLABS_API_KEY = "test-elevenlabs";

  global.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).includes("/rest/v1/api_usage")) {
      return { ok: true, status: 201 };
    }
    return providerFetch(url, options);
  };

  try {
    const handler = await getHandler();
    const res = {
      statusCode: 200,
      body: undefined,
      headers: {},
      setHeader(key, value) { this.headers[key] = value; },
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    };
    await handler({
      method: "POST",
      headers: { authorization: "Bearer test" },
      body: { text: "Test speech" }
    }, res);
    return { res, requests };
  } finally {
    global.fetch = originalFetch;
    for (const key of keys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }
}

test("TTS provider non-OK response returns a sanitized 502", async () => {
  const { res } = await runTts(async () => ({
    ok: false,
    status: 429,
    async text() { return "private provider details"; }
  }));
  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.body, { error: "TTS service unavailable." });
});

test("TTS provider network failure returns a sanitized 502", async () => {
  const { res } = await runTts(async () => {
    throw new Error("private network/provider details");
  });
  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.body, { error: "TTS service unavailable." });
});

test("TTS success returns audio and does not expose provider credentials", async () => {
  const { res, requests } = await runTts(async () => ({
    ok: true,
    status: 200,
    async arrayBuffer() { return Uint8Array.from([1, 2, 3]).buffer; }
  }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { audio: "AQID" });
  assert.equal(JSON.stringify(res.body).includes("test-elevenlabs"), false);
  const providerRequest = requests.find(request => request.url.includes("api.elevenlabs.io"));
  assert.ok(providerRequest);
  assert.equal(providerRequest.options.headers["xi-api-key"], "test-elevenlabs");
});
