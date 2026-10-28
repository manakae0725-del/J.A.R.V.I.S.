const { requireAuth } = require("../_auth");
const { enforceRateLimit } = require("../_rateLimit");
const { listConnectionsForUser } = require("../_google/tokenStore");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await requireAuth(req, res);
  if (!user) return;

  if (!(await enforceRateLimit(res, user, "google-status-minute", 60, 60))) return;

  try {
    const connections = await listConnectionsForUser(user.id);
    return res.status(200).json({ ok: true, connections });
  } catch (error) {
    console.error("Google connection status lookup failed", {
      name: error?.name || "Error"
    });
    return res.status(503).json({ error: "Google connection status unavailable" });
  }
};
