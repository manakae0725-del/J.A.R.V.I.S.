const { requireAuth } = require("../_auth");
const { enforceRateLimit } = require("../_rateLimit");
const {
  createState,
  hashState,
  createAuthorizationUrl
} = require("../_google/oauth");
const { createOAuthState } = require("../_google/tokenStore");

const CALENDAR_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events"
];

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await requireAuth(req, res);
  if (!user) return;

  if (!(await enforceRateLimit(res, user, "google-oauth-minute", 10, 60))) return;
  if (!(await enforceRateLimit(res, user, "google-oauth-day", 30, 86400))) return;

  try {
    const requestOrigin = req.headers.origin;
    if (typeof requestOrigin !== "string") {
      return res.status(400).json({ error: "Request origin is required" });
    }
    const state = createState(requestOrigin);
    const scopes = CALENDAR_SCOPES;
    await createOAuthState({
      stateHash: hashState(state),
      userId: user.id,
      scopes,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString()
    });
    const authorizationUrl = createAuthorizationUrl(state, scopes);
    return res.status(200).json({ ok: true, authorizationUrl });
  } catch (error) {
    console.error("Google OAuth start failed", {
      name: error?.name || "Error"
    });
    return res.status(503).json({ error: "Google connection unavailable" });
  }
};
