const { consumeOAuthState, saveConnection } = require("../_google/tokenStore");
const {
  hashState,
  exchangeCode,
  fetchGoogleIdentity
} = require("../_google/oauth");

function appBaseUrl() {
  const configured = process.env.JARVIS_APP_URL;
  if (configured) {
    const url = new URL(configured);
    if (url.protocol !== "https:" && url.hostname !== "localhost") {
      throw new Error("JARVIS_APP_URL must use HTTPS");
    }
    return url.origin;
  }
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!redirectUri) throw new Error("Google redirect URI is missing");
  return new URL(redirectUri).origin;
}

function finish(res, result) {
  const url = new URL("/", appBaseUrl());
  url.searchParams.set("google_connection", result);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Location", url.toString());
  return res.status(302).end();
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const state = typeof req.query?.state === "string" ? req.query.state : "";
  if (!/^[0-9a-f]{64}$/.test(state)) {
    return res.status(400).json({ error: "Invalid OAuth state" });
  }

  let stateRecord;
  try {
    stateRecord = await consumeOAuthState(hashState(state));
  } catch (error) {
    console.error("Google OAuth state validation failed", {
      name: error?.name || "Error"
    });
    return res.status(503).json({ error: "Google connection unavailable" });
  }

  if (!stateRecord) {
    return res.status(400).json({ error: "OAuth state expired or already used" });
  }

  if (typeof req.query?.error === "string") {
    try {
      return finish(res, "cancelled");
    } catch (_) {
      return res.status(500).json({ error: "Google connection result unavailable" });
    }
  }

  const code = typeof req.query?.code === "string" ? req.query.code : "";
  if (!code || code.length > 4096) {
    return res.status(400).json({ error: "OAuth authorization code missing" });
  }

  try {
    const tokenResponse = await exchangeCode(code);
    const identity = await fetchGoogleIdentity(tokenResponse.access_token);
    const grantedScopes = typeof tokenResponse.scope === "string"
      ? tokenResponse.scope.split(/\s+/).filter(Boolean)
      : stateRecord.requested_scopes;

    await saveConnection({
      userId: stateRecord.user_id,
      identity,
      tokenResponse,
      scopes: grantedScopes
    });

    return finish(res, "connected");
  } catch (error) {
    console.error("Google OAuth callback failed", {
      name: error?.name || "Error",
      status: Number.isInteger(error?.status) ? error.status : undefined
    });
    try {
      return finish(res, "error");
    } catch (_) {
      return res.status(503).json({ error: "Google connection unavailable" });
    }
  }
};
