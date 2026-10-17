const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_PUBLISHABLE_KEY;

async function requireAuth(req, res) {
  const authorization = req.headers.authorization || "";
  const match = authorization.match(/^Bearer\s+(\S+)$/i);

  if (!match) {
    console.warn("Auth check failed: bearer token missing", {
      path: req.url || "",
      method: req.method || ""
    });
    res.status(401).json({ error: "Authentication required" });
    return null;
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error("Supabase auth environment variables are missing", {
      hasSupabaseUrl: Boolean(SUPABASE_URL),
      hasSupabaseAnonOrPublishableKey: Boolean(SUPABASE_ANON_KEY)
    });
    res.status(500).json({ error: "Authentication unavailable" });
    return null;
  }

  try {
    const response = await fetch(
      `${SUPABASE_URL.replace(/\/+$/, "")}/auth/v1/user`,
      {
        method: "GET",
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${match[1]}`
        },
        signal: AbortSignal.timeout(8000)
      }
    );

    if (!response.ok) {
      console.warn("Supabase session validation rejected", {
        status: response.status
      });
      res.status(401).json({ error: "Invalid or expired session" });
      return null;
    }

    const user = await response.json();

    if (!user || typeof user.id !== "string") {
      console.warn("Supabase session validation returned no user id");
      res.status(401).json({ error: "Invalid session" });
      return null;
    }

    return user;
  } catch (error) {
    console.error("Supabase auth verification failed", {
      name: error && typeof error.name === "string" ? error.name : "Error",
    });
    res.status(503).json({ error: "Authentication service unavailable" });
    return null;
  }
}

module.exports = { requireAuth };
