const test = require("node:test");
const assert = require("node:assert/strict");

const tokenPath = require.resolve("../api/token");
const authPath = require.resolve("../api/_auth");
const rateLimitPath = require.resolve("../api/_rateLimit");

function makeRes() {
  return {
    headers: {},
    statusCode: 200,
    body: undefined,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function runToken({ method = "POST", authorization, authStatus = 200, quotaStatus = 200, quotaAllowed = true } = {}) {
  const originalFetch = global.fetch;
  const originalEnv = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  };
  const originalModules = new Map(
    [tokenPath, authPath, rateLimitPath].map((id) => [id, require.cache[id]])
  );
  const requests = [];

  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_ANON_KEY = "test-anon-key";
  process.env.SUPABASE_SECRET_KEY = "test-service-secret";
  process.env.GEMINI_API_KEY = "test-gemini-key";

  delete require.cache[authPath];
  delete require.cache[rateLimitPath];
  delete require.cache[tokenPath];

  global.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith("/auth/v1/user")) {
      return {
        ok: authStatus >= 200 && authStatus < 300,
        status: authStatus,
        async json() { return { id: "user-A" }; },
      };
    }
    if (String(url).includes("/rest/v1/rpc/consume_api_quota")) {
      return { ok: quotaStatus >= 200 && quotaStatus < 300, status: quotaStatus, async json() { return quotaAllowed; } };
    }
    if (String(url).includes("/v1beta/auth_tokens")) {
      return {
        ok: true,
        status: 200,
        async json() { return { name: "test-ephemeral-token" }; },
      };
    }
    throw new Error("Unexpected outbound request");
  };

  try {
    const handler = require("../api/token");
    const req = { method, headers: {} };
    if (authorization) req.headers.authorization = authorization;
    const res = makeRes();
    await handler(req, res);
    return { res, requests };
  } finally {
    global.fetch = originalFetch;
    for (const key of Object.keys(originalEnv)) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    for (const id of [tokenPath, authPath, rateLimitPath]) {
      delete require.cache[id];
      if (originalModules.get(id)) require.cache[id] = originalModules.get(id);
    }
  }
}

test("token endpoint rejects methods other than POST", async () => {
  const { res, requests } = await runToken({ method: "GET" });
  assert.equal(res.statusCode, 405);
  assert.deepEqual(res.body, { error: "Method not allowed" });
  assert.equal(res.headers.Allow, "POST");
  assert.equal(requests.length, 0);
});

test("token endpoint rejects a request without a bearer token", async () => {
  const { res, requests } = await runToken({ method: "POST" });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: "Authentication required" });
  assert.equal(requests.length, 0);
});

test("token endpoint rejects an invalid session without calling Gemini", async () => {
  const { res, requests } = await runToken({
    method: "POST",
    authorization: "Bearer invalid-session",
    authStatus: 401,
  });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: "Invalid or expired session" });
  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.endsWith("/auth/v1/user"));
});

test("token endpoint issues a token only after session authentication", async () => {
  const { res, requests } = await runToken({
    method: "POST",
    authorization: "Bearer valid-session",
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { token: "test-ephemeral-token" });
  assert.equal(requests.length, 3);
  assert.ok(requests[0].url.endsWith("/auth/v1/user"));
  assert.ok(requests[1].url.includes("/rest/v1/rpc/consume_api_quota"));
  assert.ok(requests[2].url.includes("/v1beta/auth_tokens"));
  assert.equal(requests[2].options.method, "POST");
});

test("token endpoint does not call Gemini when quota is exceeded", async () => {
  const { res, requests } = await runToken({
    method: "POST",
    authorization: "Bearer valid-session",
    quotaAllowed: false
  });
  assert.equal(res.statusCode, 429);
  assert.deepEqual(res.body, { error: "Rate limit exceeded. Try again shortly." });
  assert.equal(res.headers["Retry-After"], "60");
  assert.equal(requests.length, 2);
  assert.ok(requests[1].url.includes("/rest/v1/rpc/consume_api_quota"));
});

test("token endpoint fails closed when quota service is unavailable", async () => {
  const { res, requests } = await runToken({
    method: "POST",
    authorization: "Bearer valid-session",
    quotaStatus: 503
  });
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: "Usage protection unavailable" });
  assert.equal(requests.length, 2);
  assert.ok(requests[1].url.includes("/rest/v1/rpc/consume_api_quota"));
});
