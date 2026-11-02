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

async function runLimit({ user = { id: "user-A" }, bucket = "gemini-minute", limit = 30, windowSeconds = 60, status = 200, payload = [{ allowed: true, retry_after_seconds: 0 }], networkError, configured = true } = {}) {
  const originalFetch = global.fetch;
  const originalEnv = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY
  };
  const originalModule = require.cache[limiterPath];
  const requests = [];

  if (configured) {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SECRET_KEY = "test-service-secret";
  } else {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;
  }
  delete require.cache[limiterPath];

  global.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    if (networkError) throw networkError;
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() { return payload; }
    };
  };

  try {
    const { enforceRateLimit } = require("../api/_rateLimit");
    const res = makeRes();
    const result = await enforceRateLimit(res, user, bucket, limit, windowSeconds);
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

test("quota RPC allow sends the authenticated user and bucket", async () => {
  const { result, res, requests } = await runLimit();
  assert.equal(result, true);
  assert.equal(res.statusCode, 200);
  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.endsWith("/rest/v1/rpc/jarvis_check_rate_limit"));
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    p_user_id: "user-A",
    p_bucket: "gemini-minute",
    p_limit: 30,
    p_window_seconds: 60
  });
  assert.equal(requests[0].options.signal?.aborted, false);
});

test("quota denial returns 429 with retry information", async () => {
  const { result, res } = await runLimit({ payload: [{ allowed: false, retry_after_seconds: 17 }] });
  assert.equal(result, false);
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers["Retry-After"], "17");
  assert.deepEqual(res.body, { error: "Rate limit exceeded", retryAfterSeconds: 17 });
});

test("quota service HTTP failure fails closed", async () => {
  const { result, res } = await runLimit({ status: 503 });
  assert.equal(result, false);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: "Usage limit service unavailable" });
});

test("quota service network failure fails closed", async () => {
  const { result, res } = await runLimit({ networkError: new Error("private network detail") });
  assert.equal(result, false);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: "Usage limit service unavailable" });
});

test("invalid quota payload fails closed", async () => {
  const { result, res } = await runLimit({ payload: [{ allowed: "true" }] });
  assert.equal(result, false);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: "Usage limit service unavailable" });
});

test("missing Supabase configuration fails closed without an outbound request", async () => {
  const { result, res, requests } = await runLimit({ configured: false });
  assert.equal(result, false);
  assert.equal(res.statusCode, 503);
  assert.equal(requests.length, 0);
});
