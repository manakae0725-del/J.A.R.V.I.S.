const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

async function enforceRateLimit(res, user, bucket, limit, windowSeconds) {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    console.error("Rate limit storage is unavailable");
    res.status(503).json({ error: "Usage limit service unavailable" });
    return false;
  }

  try {
    const response = await fetch(
      `${SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/rpc/jarvis_check_rate_limit`,
      {
        method: "POST",
        headers: {
          apikey: SUPABASE_SECRET_KEY,
          Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          p_user_id: user.id,
          p_bucket: bucket,
          p_limit: limit,
          p_window_seconds: windowSeconds
        })
      }
    );

    if (!response.ok) {
      console.error("Rate limit check failed", response.status);
      res.status(503).json({ error: "Usage limit service unavailable" });
      return false;
    }

    const result = await response.json();
    const decision = Array.isArray(result) ? result[0] : result;

    if (!decision || typeof decision.allowed !== "boolean") {
      console.error("Rate limit check returned an invalid result");
      res.status(503).json({ error: "Usage limit service unavailable" });
      return false;
    }

    if (!decision.allowed) {
      const retryAfter = Math.max(1, Number(decision.retry_after_seconds) || 1);
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({
        error: "Rate limit exceeded",
        retryAfterSeconds: retryAfter
      });
      return false;
    }

    return true;
  } catch (error) {
    console.error("Rate limit check failed", {
      name: error && typeof error.name === "string" ? error.name : "Error"
    });
    res.status(503).json({ error: "Usage limit service unavailable" });
    return false;
  }
}

module.exports = { enforceRateLimit };
