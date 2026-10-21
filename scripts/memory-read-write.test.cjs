const test = require("node:test");
const assert = require("node:assert/strict");

const authPath = require.resolve("../api/_auth");
const memoryPath = require.resolve("../api/memory");

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; }
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

async function runMemory({ method, user = { id: "user-A" }, body = {}, db = [], dbStatuses = [], query = {} }) {
  const originalFetch = global.fetch;
  const originalUrl = process.env.SUPABASE_URL;
  const originalSecret = process.env.SUPABASE_SECRET_KEY;
  const originalAuth = require.cache[authPath];
  const originalMemory = require.cache[memoryPath];
  const requests = [];
  let call = 0;

  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "test-secret";
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
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
    const index = call++;
    return response(db[index] ?? [], dbStatuses[index] ?? 200);
  };

  try {
    const handler = require("../api/memory");
    const res = makeRes();
    await handler({ method, body, query }, res);
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

test("GET returns only active memories owned by the authenticated user", async () => {
  const { res, requests } = await runMemory({
    method: "GET",
    db: [[{ id: 1, user_id: "user-A", content: "private" }]]
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.deepEqual(res.body, { ok: true, memories: [{ id: 1, user_id: "user-A", content: "private" }] });
  const url = new URL(requests[0].url);
  assert.equal(url.searchParams.get("user_id"), "eq.user-A");
  assert.equal(url.searchParams.get("is_active"), "eq.true");
  assert.equal(requests[0].options.headers.Authorization, "Bearer test-secret");
});

test("GET does not access the database without an authenticated user", async () => {
  const { res, requests } = await runMemory({ method: "GET", user: null });
  assert.equal(res.statusCode, 401);
  assert.equal(requests.length, 0);
});

test("POST rejects invalid memory data before database access", async () => {
  const { res, requests } = await runMemory({
    method: "POST",
    body: { category: "note", content: "valid text", importance: 6 }
  });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: "Invalid memory data" });
  assert.equal(requests.length, 0);
});

test("POST inserts a new memory with the authenticated owner and normalized content", async () => {
  const inserted = [{ id: 22, user_id: "user-A", category: "note", content: "keep this", importance: 3 }];
  const { res, requests } = await runMemory({
    method: "POST",
    body: { category: " note ", content: " keep this ", importance: 3 },
    db: [[], inserted]
  });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body, { ok: true, memories: inserted });
  assert.equal(requests.length, 2);
  const duplicateCheck = new URL(requests[0].url);
  assert.equal(duplicateCheck.searchParams.get("user_id"), "eq.user-A");
  assert.equal(duplicateCheck.searchParams.get("category"), "eq.note");
  assert.equal(duplicateCheck.searchParams.get("content"), "eq.keep this");
  assert.equal(duplicateCheck.searchParams.get("is_active"), "eq.true");
  const insertBody = JSON.parse(requests[1].options.body);
  assert.equal(requests[1].options.method, "POST");
  assert.equal(insertBody.user_id, "user-A");
  assert.equal(insertBody.category, "note");
  assert.equal(insertBody.content, "keep this");
  assert.equal(insertBody.importance, 3);
});

test("POST duplicate lookup and update are both scoped to the authenticated owner", async () => {
  const updated = [{ id: 7, user_id: "user-A", category: "note", content: "same", importance: 5 }];
  const { res, requests } = await runMemory({
    method: "POST",
    body: { category: "note", content: "same", importance: 5 },
    db: [[{ id: 7 }], updated]
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, memories: updated });
  assert.equal(requests.length, 2);
  const lookup = new URL(requests[0].url);
  const update = new URL(requests[1].url);
  assert.equal(lookup.searchParams.get("user_id"), "eq.user-A");
  assert.equal(update.searchParams.get("id"), "eq.7");
  assert.equal(update.searchParams.get("user_id"), "eq.user-A");
  assert.equal(requests[1].options.method, "PATCH");
});

test("POST sanitizes database errors during duplicate lookup", async () => {
  const { res } = await runMemory({
    method: "POST",
    body: { category: "note", content: "same", importance: 2 },
    db: [[]],
    dbStatuses: [500]
  });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: "Failed to save memory" });
});
