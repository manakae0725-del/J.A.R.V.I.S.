const { requireAuth } = require("./_auth");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await requireAuth(req, res);
  if (!user) return;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("Gemini ephemeral token service is not configured");
    return res.status(503).json({ error: "Token service unavailable" });
  }

  try {
    const now = Date.now();
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/auth_tokens",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          uses: 1,
          expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
          newSessionExpireTime: new Date(now + 60 * 1000).toISOString(),
        }),
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!response.ok) {
      console.error("Gemini ephemeral token request failed", {
        status: response.status,
      });
      return res.status(502).json({ error: "Token service unavailable" });
    }

    const data = await response.json();
    if (!data || typeof data.name !== "string" || !data.name) {
      console.error("Gemini ephemeral token response was invalid");
      return res.status(502).json({ error: "Token service unavailable" });
    }

    return res.status(200).json({ token: data.name });
  } catch (error) {
    console.error("Gemini ephemeral token request failed", {
      name: error && typeof error.name === "string" ? error.name : "Error",
    });
    return res.status(502).json({ error: "Token service unavailable" });
  }
};
