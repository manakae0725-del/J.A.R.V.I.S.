const test = require("node:test");
const assert = require("node:assert/strict");

const authPath = require.resolve("../api/_auth");
const limiterPath = require.resolve("../api/_rateLimit");
const memoryPath = require.resolve("../api/memory");

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

async function runMemory({ method = "GET", user = { id: "user-A" }, body = {}, rows = [], dbStatus = 200 } = {}) {
  const originalFetch = global.fetch;
  const env = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY
  };
  const originalModules = new Map([authPath, limiterPath, memoryPath].map(path => [path, require.cache[path]]));
  const requests = [];
  let quotaCalls = 0;

  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "test-service-secret";
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: { requireAuth: async (_req, res) => {
      if (!user) { res.status(401).json({ error: "Authentication required" }); return null; }
      return user;
    } }
  };
  require.cache[limiterPath] = {
    id: limiterPath, filename: limiterPath, loaded: true,
    exports: { enforceRateLimit: async () => { quotaCalls++; return true; } }
  };
  delete require.cache[memoryPath];

  global.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return {
      ok: dbStatus >= 200 && dbStatus < 300,
      status: dbStatus,
      async json() { return rows; },
      async text() { return "database error"; }
    };
  };

  try {
    const handler = require("../api/memory");
    const res = makeRes();
    await handler({ method, headers: { authorization: "Bearer test" }, body }, res);
    return { res, requests, quotaCalls };
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const path of [authPath, limiterPath, memoryPath]) {
      delete require.cache[path];
      if (originalModules.get(path)) require.cache[path] = originalModules.get(path);
    }
  }
}

test("GET returns only the authenticated user's active conversation memories", async () => {
  const rows = [{ id: 1, category: "personal", content: "private" }];
  const { res, requests, quotaCalls } = await runMemory({ rows });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, memories: rows });
  assert.equal(quotaCalls, 2);
  const url = new URL(requests[0].url);
  assert.equal(url.searchParams.get("user_id"), "eq.user-A");
  assert.equal(url.searchParams.get("is_active"), "eq.true");
  assert.equal(url.searchParams.get("category"), "in.(personal,preference,work,family,goal)");
  assert.equal(requests[0].options.headers.Authorization, "Bearer test-service-secret");
});

test("GET refuses unauthenticated requests before rate limiting or database access", async () => {
  const { res, requests, quotaCalls } = await runMemory({ user: null });
  assert.equal(res.statusCode, 401);
  assert.equal(requests.length, 0);
  assert.equal(quotaCalls, 0);
});

test("POST saves through the atomic owner-scoped RPC", async () => {
  const rows = [{ id: 8, category: "work", content: "saved" }];
  const { res, requests, quotaCalls } = await runMemory({
    method: "POST",
    body: { category: " work ", content: " saved ", importance: 4 },
    rows
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, memories: rows });
  assert.equal(quotaCalls, 2);
  assert.ok(requests[0].url.endsWith("/rest/v1/rpc/save_memory_atomic"));
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    p_user_id: "user-A",
    p_category: "work",
    p_content: "saved",
    p_importance: 4
  });
});

test("POST rejects invalid data before calling the database", async () => {
  const { res, requests } = await runMemory({
    method: "POST",
    body: { category: "work", content: "x", importance: 9 }
  });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: "Invalid memory data" });
  assert.equal(requests.length, 0);
});

test("POST rejects oversized content before calling the database", async () => {
  const { res, requests } = await runMemory({
    method: "POST",
    body: { category: "work", content: "x".repeat(4001), importance: 3 }
  });
  assert.equal(res.statusCode, 413);
  assert.equal(requests.length, 0);
});

test("POST replacement uses the atomic replace RPC and authenticated owner ID", async () => {
  const { res, requests } = await runMemory({
    method: "POST",
    body: { action: "replace", memoryId: 8, category: "work", content: "updated", importance: 5 },
    rows: [{ id: 9 }]
  });
  assert.equal(res.statusCode, 200);
  assert.ok(requests[0].url.endsWith("/rest/v1/rpc/replace_memory_atomic"));
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    p_user_id: "user-A",
    p_memory_id: 8,
    p_category: "work",
    p_content: "updated",
    p_importance: 5
  });
});

test("memory storage errors return a sanitized failure", async () => {
  const { res } = await runMemory({
    method: "POST",
    body: { category: "work", content: "save", importance: 2 },
    dbStatus: 503
  });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: "Failed to save memory" });
});
