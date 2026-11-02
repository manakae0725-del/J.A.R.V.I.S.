const test = require("node:test");
const assert = require("node:assert/strict");

const authPath = require.resolve("../api/_auth");
const limiterPath = require.resolve("../api/_rateLimit");
const handlerPath = require.resolve("../api/connectors");

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

async function invoke({ method = "GET", query = {}, auth = true } = {}) {
  const originals = [require.cache[authPath], require.cache[limiterPath], require.cache[handlerPath]];
  require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: { requireAuth: async (_req, res) => auth ? { id: "user-A" } : null } };
  require.cache[limiterPath] = { id: limiterPath, filename: limiterPath, loaded: true, exports: { enforceRateLimit: async () => true } };
  delete require.cache[handlerPath];
  try {
    const handler = require("../api/connectors");
    const res = makeRes();
    await handler({ method, query }, res);
    return res;
  } finally {
    for (const [i, path] of [authPath, limiterPath, handlerPath].entries()) {
      delete require.cache[path];
      if (originals[i]) require.cache[path] = originals[i];
    }
  }
}

test("connector status exposes configuration booleans but no credential values", async () => {
  const keys = ["GITHUB_READ_TOKEN", "VERCEL_READ_TOKEN", "SUPABASE_MANAGEMENT_TOKEN", "SUPABASE_PROJECT_REF"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  try {
    const res = await invoke();
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.connections.github.configured, false);
    assert.equal(res.body.connections.vercel.configured, false);
    assert.equal(res.body.connections.supabase.configured, false);
    assert.equal(JSON.stringify(res.body).includes("TOKEN"), false);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("connector endpoint rejects non-GET methods", async () => {
  const res = await invoke({ method: "POST" });
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, "GET");
});

test("connector endpoint rejects unknown providers without upstream calls", async () => {
  const res = await invoke({ query: { provider: "arbitrary-url", action: "overview" } });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { ok: false, error: "Unsupported connector" });
});

test("connector endpoint rejects unknown provider actions", async () => {
  const res = await invoke({ query: { provider: "github", action: "delete" } });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { ok: false, error: "Invalid connector action" });
});
