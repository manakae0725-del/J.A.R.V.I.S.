const test = require("node:test");
const assert = require("node:assert/strict");

const authPath = require.resolve("../api/_auth");
const memoryPath = require.resolve("../api/memory");

async function runPost(body) {
  const originalFetch = global.fetch;
  const originalUrl = process.env.SUPABASE_URL;
  const originalSecret = process.env.SUPABASE_SECRET_KEY;
  const originalAuth = require.cache[authPath];
  const originalMemory = require.cache[memoryPath];
  const requests = [];

  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "test-secret";
  require.cache[authPath] = {
    id: authPath,
    filename: authPath,
    loaded: true,
    exports: { requireAuth: async () => ({ id: "user-A" }) }
  };
  delete require.cache[memoryPath];
  global.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return { ok: true, status: 200, async json() { return []; } };
  };

  try {
    const handler = require("../api/memory");
    const res = {
      statusCode: 200,
      body: undefined,
      headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      status(code) { this.statusCode = code; return this; },
      json(value) { this.body = value; return this; }
    };
    await handler({ method: "POST", body }, res);
    return { res, requests };
  } finally {
    global.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalUrl;
    if (originalSecret === undefined) delete process.env.SUPABASE_SECRET_KEY;
    else process.env.SUPABASE_SECRET_KEY = originalSecret;
    delete require.cache[authPath];
    delete require.cache[memoryPath];
    if (originalAuth) require.cache[authPath] = originalAuth;
    if (originalMemory) require.cache[memoryPath] = originalMemory;
  }
}

test("memory content at 5000 characters is accepted by input validation", async () => {
  const { res, requests } = await runPost({ category: "personal", content: "x".repeat(5000), importance: 3 });
  assert.notEqual(res.statusCode, 400);
  assert.equal(requests.length, 2);
  assert.ok(requests[0].url.includes("content=eq."));
  assert.equal(JSON.parse(requests[1].options.body).content.length, 5000);
});

test("memory content over 5000 characters is rejected before database access", async () => {
  const { res, requests } = await runPost({ category: "personal", content: "x".repeat(5001), importance: 3 });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: "Invalid memory data" });
  assert.equal(requests.length, 0);
});

test("memory category over 100 characters is rejected before database access", async () => {
  const { res, requests } = await runPost({ category: "c".repeat(101), content: "valid", importance: 3 });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: "Invalid memory data" });
  assert.equal(requests.length, 0);
});

test("memory importance outside integer range is rejected before database access", async () => {
  for (const importance of [0, 6, 2.5, "3"]) {
    const { res, requests } = await runPost({ category: "personal", content: "valid", importance });
    assert.equal(res.statusCode, 400);
    assert.equal(requests.length, 0);
  }
});
