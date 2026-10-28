const { requireAuth } = require("../_auth");
const { enforceRateLimit } = require("../_rateLimit");
const {
  decryptToken,
  getConnectionForUser,
  deleteConnectionForUser
} = require("../_google/tokenStore");
const { revokeGoogleToken } = require("../_google/oauth");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await requireAuth(req, res);
  if (!user) return;

  if (!(await enforceRateLimit(res, user, "google-disconnect-minute", 10, 60))) return;

  const connectionId = req.body?.connectionId;
  if (typeof connectionId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(connectionId)) {
    return res.status(400).json({ error: "Valid connectionId is required" });
  }

  try {
    const connection = await getConnectionForUser(user.id, connectionId);
    if (!connection) {
      return res.status(404).json({ error: "Google connection not found" });
    }

    let revoked = false;
    try {
      const token = connection.refresh_token_ciphertext
        ? decryptToken(connection.refresh_token_ciphertext)
        : decryptToken(connection.access_token_ciphertext);
      if (token) {
        await revokeGoogleToken(token);
        revoked = true;
      }
    } catch (error) {
      console.warn("Google token revocation did not complete; deleting local credentials", {
        name: error?.name || "Error"
      });
    }

    await deleteConnectionForUser(user.id, connectionId);
    return res.status(200).json({
      ok: true,
      disconnected: true,
      providerRevocationConfirmed: revoked
    });
  } catch (error) {
    console.error("Google disconnect failed", {
      name: error?.name || "Error"
    });
    return res.status(503).json({ error: "Google disconnect unavailable" });
  }
};
