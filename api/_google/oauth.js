const crypto = require("crypto");

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

function getGoogleConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Google OAuth environment variables are missing");
  }
  return { clientId, clientSecret, redirectUri };
}

function normalizeReturnOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch (_) {
    throw new Error("Google OAuth return origin is invalid");
  }
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password) {
    throw new Error("Google OAuth return origin is invalid");
  }
  const hostname = url.hostname.toLowerCase();
  const isProduction = hostname === "j-a-r-v-i-s-gold.vercel.app";
  const isProjectPreview = /^j-a-r-v-i-[a-z0-9-]+-manato2\.vercel\.app$/.test(hostname);
  if (!isProduction && !isProjectPreview) {
    throw new Error("Google OAuth return origin is not an allowed J.A.R.V.I.S. domain");
  }
  return url.origin;
}

function createState(returnOrigin) {
  const origin = normalizeReturnOrigin(returnOrigin);
  const encodedOrigin = Buffer.from(origin, "utf8").toString("base64url");
  return crypto.randomBytes(32).toString("hex") + "." + encodedOrigin;
}

function returnOriginFromState(state) {
  const match = /^([0-9a-f]{64})\.([A-Za-z0-9_-]+)$/.exec(state);
  if (!match) throw new Error("Google OAuth state is invalid");
  const origin = Buffer.from(match[2], "base64url").toString("utf8");
  return normalizeReturnOrigin(origin);
}

function hashState(state) {
  return crypto.createHash("sha256").update(state, "utf8").digest("hex");
}

function createAuthorizationUrl(state, scopes) {
  const { clientId, redirectUri } = getGoogleConfig();
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

async function exchangeCode(code) {
  const { clientId, clientSecret, redirectUri } = getGoogleConfig();
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code"
  });
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || typeof data.access_token !== "string") {
    const error = new Error("Google token exchange failed");
    error.status = response.status;
    throw error;
  }
  return data;
}

async function refreshAccessToken(refreshToken) {
  const { clientId, clientSecret } = getGoogleConfig();
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token"
  });
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || typeof data.access_token !== "string") {
    const error = new Error("Google access token refresh failed");
    error.status = response.status;
    error.code = typeof data.error === "string" ? data.error : "refresh_failed";
    throw error;
  }
  return data;
}

async function fetchGoogleIdentity(accessToken) {
  const response = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || typeof data.sub !== "string") {
    const error = new Error("Google identity lookup failed");
    error.status = response.status;
    throw error;
  }
  return {
    subject: data.sub,
    email: typeof data.email === "string" ? data.email : null
  };
}

async function revokeGoogleToken(token) {
  if (typeof token !== "string" || !token) return;
  const response = await fetch(GOOGLE_REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token })
  });
  if (!response.ok && response.status !== 400) {
    throw new Error("Google token revocation failed");
  }
}

module.exports = {
  getGoogleConfig,
  createState,
  returnOriginFromState,
  hashState,
  createAuthorizationUrl,
  exchangeCode,
  refreshAccessToken,
  fetchGoogleIdentity,
  revokeGoogleToken
};
