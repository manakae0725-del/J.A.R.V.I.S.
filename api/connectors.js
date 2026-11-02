const { requireAuth } = require("./_auth");
const { enforceRateLimit } = require("./_rateLimit");

const DEFAULT_GITHUB_REPOSITORY = "manakae0725-del/J.A.R.V.I.S.";
const DEFAULT_VERCEL_PROJECT_ID = "prj_5IrdTjFE7phE5toTeTUZfcoohSN5";
const MAX_RESPONSE_BYTES = 1024 * 1024;

function sendError(res, status, message) {
  return res.status(status).json({ ok: false, error: message });
}

function safeRepository(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(value)
    ? value
    : DEFAULT_GITHUB_REPOSITORY;
}

function configuredStatus() {
  return {
    github: {
      configured: Boolean(process.env.GITHUB_READ_TOKEN),
      repository: safeRepository(process.env.GITHUB_REPOSITORY || DEFAULT_GITHUB_REPOSITORY)
    },
    vercel: {
      configured: Boolean(process.env.VERCEL_READ_TOKEN),
      projectConfigured: Boolean(process.env.VERCEL_PROJECT_ID || DEFAULT_VERCEL_PROJECT_ID)
    },
    supabase: {
      configured: Boolean(process.env.SUPABASE_MANAGEMENT_TOKEN),
      projectConfigured: Boolean(process.env.SUPABASE_PROJECT_REF)
    }
  };
}

async function readJson(url, headers, label) {
  const response = await fetch(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(10000)
  });
  const raw = await response.text();
  if (raw.length > MAX_RESPONSE_BYTES) {
    const error = new Error(label + " response too large");
    error.status = 502;
    throw error;
  }
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch (_) {
    const error = new Error(label + " returned invalid JSON");
    error.status = 502;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(label + " request failed");
    error.status = response.status === 404 ? 404 : response.status === 401 || response.status === 403 ? 502 : 503;
    throw error;
  }
  return data;
}

async function github(action) {
  const paths = {
    overview: "",
    branches: "/branches?per_page=30",
    commits: "/commits?per_page=20",
    pulls: "/pulls?state=all&per_page=20",
    issues: "/issues?state=open&per_page=20"
  };
  if (!Object.prototype.hasOwnProperty.call(paths, action)) {
    const error = new Error("Unsupported GitHub action");
    error.status = 400;
    throw error;
  }
  const token = process.env.GITHUB_READ_TOKEN;
  if (!token) return { configured: false };
  const repository = safeRepository(process.env.GITHUB_REPOSITORY || DEFAULT_GITHUB_REPOSITORY);
  const base = "https://api.github.com/repos/" + repository;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: "Bearer " + token,
    "X-GitHub-Api-Version": "2022-11-28"
  };
  const data = await readJson(base + paths[action], headers, "GitHub");
  if (action === "overview") {
    return {
      configured: true,
      repository: { full_name: data.full_name, private: data.private, default_branch: data.default_branch, html_url: data.html_url, updated_at: data.updated_at }
    };
  }
  if (action === "branches") return { configured: true, items: data.map(x => ({ name: x.name, protected: x.protected, sha: x.commit?.sha })) };
  if (action === "commits") return { configured: true, items: data.map(x => ({ sha: x.sha, message: x.commit?.message, date: x.commit?.author?.date, url: x.html_url })) };
  if (action === "pulls") return { configured: true, items: data.map(x => ({ number: x.number, title: x.title, state: x.state, draft: x.draft, head: x.head?.ref, base: x.base?.ref, url: x.html_url, updated_at: x.updated_at })) };
  return { configured: true, items: data.filter(x => !x.pull_request).map(x => ({ number: x.number, title: x.title, state: x.state, url: x.html_url, updated_at: x.updated_at })) };
}

async function vercel(action) {
  const paths = {
    project: "/v9/projects/" + encodeURIComponent(process.env.VERCEL_PROJECT_ID || DEFAULT_VERCEL_PROJECT_ID) + "?teamId=" + encodeURIComponent(process.env.VERCEL_TEAM_ID || "team_A3GSr6JlvzblsgMAGGLZG11f"),
    deployments: "/v6/deployments?projectId=" + encodeURIComponent(process.env.VERCEL_PROJECT_ID || DEFAULT_VERCEL_PROJECT_ID) + "&limit=10&teamId=" + encodeURIComponent(process.env.VERCEL_TEAM_ID || "team_A3GSr6JlvzblsgMAGGLZG11f")
  };
  if (!Object.prototype.hasOwnProperty.call(paths, action)) {
    const error = new Error("Unsupported Vercel action");
    error.status = 400;
    throw error;
  }
  const token = process.env.VERCEL_READ_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID || DEFAULT_VERCEL_PROJECT_ID;
  if (!token) return { configured: false, projectConfigured: Boolean(projectId) };
  const team = process.env.VERCEL_TEAM_ID || "team_A3GSr6JlvzblsgMAGGLZG11f";
  const base = "https://api.vercel.com";
  const headers = { Authorization: "Bearer " + token };
  const data = await readJson(base + paths[action], headers, "Vercel");
  if (action === "project") {
    return { configured: true, project: { id: data.id, name: data.name, framework: data.framework, nodeVersion: data.nodeVersion, updatedAt: data.updatedAt, latestDeployments: Array.isArray(data.latestDeployments) ? data.latestDeployments.slice(0, 5).map(x => ({ uid: x.uid, state: x.state, target: x.target, url: x.url, createdAt: x.createdAt })) : [] } };
  }
  return { configured: true, items: (Array.isArray(data.deployments) ? data.deployments : []).map(x => ({ uid: x.uid, name: x.name, state: x.state, target: x.target, url: x.url, created: x.created, ready: x.ready, meta: { githubCommitSha: x.meta?.githubCommitSha, githubCommitRef: x.meta?.githubCommitRef, githubCommitMessage: x.meta?.githubCommitMessage } })) };
}

async function supabase(action) {
  const projectRef = process.env.SUPABASE_PROJECT_REF;
  const paths = { project: "/v1/projects/" + encodeURIComponent(projectRef || "not-configured") };
  if (!Object.prototype.hasOwnProperty.call(paths, action)) {
    const error = new Error("Unsupported Supabase action");
    error.status = 400;
    throw error;
  }
  const token = process.env.SUPABASE_MANAGEMENT_TOKEN;
  if (!token || !projectRef) return { configured: false, projectConfigured: Boolean(projectRef) };
  const data = await readJson("https://api.supabase.com" + paths[action], {
    Authorization: "Bearer " + token,
    Accept: "application/json"
  }, "Supabase Management API");
  return { configured: true, project: { id: data.id, name: data.name, organization_id: data.organization_id, region: data.region, status: data.status, created_at: data.created_at } };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return sendError(res, 405, "Method not allowed");
  }

  const user = await requireAuth(req, res);
  if (!user) return;
  if (!(await enforceRateLimit(res, user, "connectors-read-minute", 30, 60))) return;

  const provider = typeof req.query?.provider === "string" ? req.query.provider : "status";
  const action = typeof req.query?.action === "string" ? req.query.action : "overview";
  try {
    if (provider === "status") return res.status(200).json({ ok: true, connections: configuredStatus() });
    let result;
    if (provider === "github") result = await github(action);
    else if (provider === "vercel") result = await vercel(action);
    else if (provider === "supabase") result = await supabase(action);
    else return sendError(res, 400, "Unsupported connector");
    return res.status(200).json({ ok: true, provider, action, ...result });
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 503;
    console.error("External connector read failed", {
      provider,
      action,
      status,
      name: error?.name || "Error"
    });
    return sendError(res, status, status === 400 ? "Invalid connector action" : status === 404 ? "Connector resource not found" : "Connector service unavailable");
  }
};
