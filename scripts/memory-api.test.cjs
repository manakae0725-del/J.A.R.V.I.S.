const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const authPath = require.resolve("../api/_auth");
const memoryPath = require.resolve("../api/memory");

function makeResponse(rows = [], status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return rows; }
  };
}

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

async function runDelete({ id = "5", user = { id: "user-A" }, rows = [{ id: 5 }], dbStatus = 200 } = {}) {
  const originalFetch = global.fetch;
  const originalUrl = process.env.SUPABASE_URL;
  const originalSecret = process.env.SUPABASE_SECRET_KEY;
  const originalAuthModule = require.cache[authPath];
  const originalMemoryModule = require.cache[memoryPath];
  const requests = [];

  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "test-secret";
  require.cache[authPath] = {
    id: authPath,
    filename: authPath,
    loaded: true,
    exports: {
      requireAuth: async (_req, res) => {
        if (!user) {
          res.status(401).json({ error: "Unauthorized" });
          return null;
        }
        return user;
      }
    }
  };
  delete require.cache[memoryPath];

  global.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return makeResponse(rows, dbStatus);
  };

  try {
    const handler = require("../api/memory");
    const res = makeRes();
    await handler({ method: "DELETE", query: { id } }, res);
    return { res, requests };
  } finally {
    global.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalUrl;
    if (originalSecret === undefined) delete process.env.SUPABASE_SECRET_KEY;
    else process.env.SUPABASE_SECRET_KEY = originalSecret;
    delete require.cache[authPath];
    delete require.cache[memoryPath];
    if (originalAuthModule) require.cache[authPath] = originalAuthModule;
    if (originalMemoryModule) require.cache[memoryPath] = originalMemoryModule;
  }
}

test("DELETE soft-deactivates only the requested memory owned by the authenticated user", async () => {
  const { res, requests } = await runDelete();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(requests.length, 1);

  const request = requests[0];
  const url = new URL(request.url);
  assert.equal(request.options.method, "PATCH");
  assert.equal(url.searchParams.get("id"), "eq.5");
  assert.equal(url.searchParams.get("user_id"), "eq.user-A");
  assert.equal(url.searchParams.get("is_active"), "eq.true");
  assert.equal(url.searchParams.get("select"), "id");
  assert.deepEqual(JSON.parse(request.options.body).is_active, false);
  assert.ok(request.options.signal);
  assert.equal(request.options.headers.Authorization, "Bearer test-secret");
});

test("DELETE rejects malformed IDs before making a database request", async () => {
  const { res, requests } = await runDelete({ id: "5,6" });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: "Invalid memory id" });
  assert.equal(requests.length, 0);
});

test("DELETE returns 404 when no active memory owned by this user matches", async () => {
  const { res, requests } = await runDelete({ rows: [] });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: "Memory not found" });
  assert.equal(requests.length, 1);
});

test("DELETE sanitizes database failures", async () => {
  const { res } = await runDelete({ dbStatus: 500, rows: [] });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: "Failed to delete memory" });
});

test("DELETE does not access the database without an authenticated user", async () => {
  const { res, requests } = await runDelete({ user: null });
  assert.equal(res.statusCode, 401);
  assert.equal(requests.length, 0);
});
