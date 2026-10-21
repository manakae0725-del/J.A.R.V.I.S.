const test = require("node:test");
const assert = require("node:assert/strict");

const limiterPath = require.resolve("../api/_rateLimit");

function makeRes() {
  return {
    headers: {},
    statusCode: 200,
    body: undefined,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

async function runLimit({ userId = "user-A", service = "gemini", status = 200, allowed = true, networkError, configuredLimit } = {}) {
  const originalFetch = global.fetch;
  const originalEnv = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
    JARVIS_GEMINI_RPM: process.env.JARVIS_GEMINI_RPM
  };
  const originalModule = require.cache[limiterPath];
  const requests = [];

  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "test-service-secret";
  if (configuredLimit === undefined) delete process.env.JARVIS_GEMINI_RPM;
  else process.env.JARVIS_GEMINI_RPM = String(configuredLimit);
  delete require.cache[limiterPath];

  global.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    if (networkError) throw networkError;
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() { return allowed; }
    };
  };

  try {
    const { consumeRateLimit } = require("../api/_rateLimit");
    const res = makeRes();
    const result = await consumeRateLimit(userId, service, res);
    return { result, res, requests };
  } finally {
    global.fetch = originalFetch;
    for (const key of Object.keys(originalEnv)) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    delete require.cache[limiterPath];
    if (originalModule) require.cache[limiterPath] = originalModule;
  }
}

test("quota RPC allow returns true and sends authenticated user/service/limit", async () => {
  const { result, res, requests } = await runLimit({ userId: "user-A", service: "gemini", allowed: true, configuredLimit: 12 });
  assert.equal(result, true);
  assert.equal(res.statusCode, 200);
  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.endsWith("/rest/v1/rpc/consume_api_quota"));
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    p_user_id: "user-A",
    p_service: "gemini",
    p_limit: 12
  });
});

test("quota RPC denial returns 429 with retry and no-store headers", async () => {
  const { result, res } = await runLimit({ allowed: false });
  assert.equal(result, false);
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers["Retry-After"], "60");
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.deepEqual(res.body, { error: "Rate limit exceeded. Try again shortly." });
});

test("quota RPC HTTP failure fails closed with 503", async () => {
  const { result, res } = await runLimit({ status: 500 });
  assert.equal(result, false);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: "Usage protection unavailable" });
});

test("quota RPC network failure fails closed with 503", async () => {
  const { result, res } = await runLimit({ networkError: new Error("private network detail") });
  assert.equal(result, false);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: "Usage protection unavailable" });
});

test("different users are passed as independent quota keys", async () => {
  const first = await runLimit({ userId: "user-A", allowed: true });
  const second = await runLimit({ userId: "user-B", allowed: true });
  assert.equal(JSON.parse(first.requests[0].options.body).p_user_id, "user-A");
  assert.equal(JSON.parse(second.requests[0].options.body).p_user_id, "user-B");
});

test("unexpected non-boolean quota response is denied", async () => {
  const { result, res } = await runLimit({ allowed: "true" });
  assert.equal(result, false);
  assert.equal(res.statusCode, 429);
});
