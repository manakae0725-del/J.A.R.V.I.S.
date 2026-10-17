const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

const DEFAULT_LIMITS = {
  gemini: 30,
  search: 20,
  tts: 10,
  token: 5
};

async function consumeRateLimit(userId, service, res) {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    console.error("Rate-limit service is not configured");
    res.status(503).json({ error: "Usage protection unavailable" });
    return false;
  }

  const configuredLimit = Number(process.env[`JARVIS_${service.toUpperCase()}_RPM`]);
  const limit = Number.isInteger(configuredLimit) && configuredLimit > 0
    ? Math.min(configuredLimit, 1000)
    : DEFAULT_LIMITS[service];

  if (!limit) {
    res.status(500).json({ error: "Invalid usage protection configuration" });
    return false;
  }

  try {
    const response = await fetch(
      `${SUPABASE_URL.replace(/\\/+$/, "")}/rest/v1/rpc/consume_api_quota`,
      {
        method: "POST",
        headers: {
          apikey: SUPABASE_SECRET_KEY,
          Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          p_user_id: userId,
          p_service: service,
          p_limit: limit
        }),
        signal: AbortSignal.timeout(3000)
      }
    );

    if (!response.ok) {
      console.error("Rate-limit check failed", { status: response.status });
      res.status(503).json({ error: "Usage protection unavailable" });
      return false;
    }

    const allowed = await response.json();
    if (allowed !== true) {
      res.setHeader("Retry-After", "60");
      res.setHeader("Cache-Control", "no-store");
      res.status(429).json({ error: "Rate limit exceeded. Try again shortly." });
      return false;
    }

    return true;
  } catch (error) {
    console.error("Rate-limit check failed", {
      name: error && typeof error.name === "string" ? error.name : "Error"
    });
    res.status(503).json({ error: "Usage protection unavailable" });
    return false;
  }
}

module.exports = { consumeRateLimit };
