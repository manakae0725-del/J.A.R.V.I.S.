const test = require("node:test");
const assert = require("node:assert/strict");

const authPath = require.resolve("../api/_auth");

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

async function runAuth({ authorization = "Bearer test-session", status = 200, payload = { id: "user-A" }, networkError } = {}) {
  const originalFetch = global.fetch;
  const originalEnv = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
    SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY
  };
  const originalModule = require.cache[authPath];
  const requests = [];

  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_ANON_KEY = "test-anon-key";
  delete process.env.SUPABASE_PUBLISHABLE_KEY;
  delete require.cache[authPath];

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
    const { requireAuth } = require("../api/_auth");
    const res = makeRes();
    const req = { headers: authorization ? { authorization } : {}, url: "/api/test?secret=1", method: "POST" };
    const user = await requireAuth(req, res);
    return { user, res, requests };
  } finally {
    global.fetch = originalFetch;
    for (const key of Object.keys(originalEnv)) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    delete require.cache[authPath];
    if (originalModule) require.cache[authPath] = originalModule;
  }
}

test("missing bearer token returns 401 without calling Supabase", async () => {
  const { user, res, requests } = await runAuth({ authorization: null });
  assert.equal(user, null);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: "Authentication required" });
  assert.equal(requests.length, 0);
});

test("invalid session returns 401", async () => {
  const { user, res, requests } = await runAuth({ status: 401 });
  assert.equal(user, null);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: "Invalid or expired session" });
  assert.equal(requests.length, 1);
});

test("Supabase 5xx returns 503 rather than misclassifying the session", async () => {
  const { user, res } = await runAuth({ status: 503 });
  assert.equal(user, null);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: "Authentication service unavailable" });
});

test("network failure returns 503", async () => {
  const { user, res } = await runAuth({ networkError: new Error("network details must not be returned") });
  assert.equal(user, null);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: "Authentication service unavailable" });
});

test("successful response without a string user ID returns 401", async () => {
  const { user, res } = await runAuth({ payload: { id: 123 } });
  assert.equal(user, null);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: "Invalid session" });
});

test("valid session returns authenticated user", async () => {
  const expected = { id: "user-A" };
  const { user, res, requests } = await runAuth({ payload: expected });
  assert.deepEqual(user, expected);
  assert.equal(res.statusCode, 200);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.headers.Authorization, "Bearer test-session");
});

test("authorization header must use the Bearer scheme with a single token", async () => {
  for (const authorization of ["Basic test-session", "Bearer", "Bearer one two", "Bearer\ttoken extra"]) {
    const { user, res, requests } = await runAuth({ authorization });
    assert.equal(user, null, authorization);
    assert.equal(res.statusCode, 401, authorization);
    assert.deepEqual(res.body, { error: "Authentication required" }, authorization);
    assert.equal(requests.length, 0, authorization);
  }
});

test("publishable key is used when anon key is not configured", async () => {
  const originalFetch = global.fetch;
  const originalEnv = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
    SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY
  };
  const originalModule = require.cache[authPath];
  const requests = [];
  process.env.SUPABASE_URL = "https://example.supabase.co";
  delete process.env.SUPABASE_ANON_KEY;
  process.env.SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
  delete require.cache[authPath];
  global.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return { ok: true, status: 200, async json() { return { id: "user-A" }; } };
  };
  try {
    const { requireAuth } = require("../api/_auth");
    const res = makeRes();
    const user = await requireAuth({
      headers: { authorization: "Bearer test-session" },
      url: "/api/test",
      method: "GET"
    }, res);
    assert.deepEqual(user, { id: "user-A" });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.headers.apikey, "test-publishable-key");
  } finally {
    global.fetch = originalFetch;
    for (const key of Object.keys(originalEnv)) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    delete require.cache[authPath];
    if (originalModule) require.cache[authPath] = originalModule;
  }
});
