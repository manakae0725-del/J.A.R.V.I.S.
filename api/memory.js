const { requireAuth } = require("./_auth");
const { enforceRateLimit } = require("./_rateLimit");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

module.exports = async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await requireAuth(req, res);
  if (!user) return;

  if (!(await enforceRateLimit(res, user, "memory-minute", 60, 60))) return;
  if (!(await enforceRateLimit(res, user, "memory-day", 500, 86400))) return;

  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    console.error("Memory API environment variables are missing");
    return res.status(500).json({ error: "Memory service unavailable" });
  }

  const baseUrl = `${SUPABASE_URL.replace(/\\/+$/, "")}/rest/v1`;
  const headers = {
    apikey: SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
    "Content-Type": "application/json"
  };

  try {
    if (req.method === "GET") {
      const params = new URLSearchParams({
        select: "*",
        user_id: `eq.${user.id}`,
        is_active: "eq.true",
        order: "importance.desc,updated_at.desc"
      });

      const response = await fetch(`${baseUrl}/memories?${params}`, { headers });

      if (!response.ok) {
        console.error("Memory read failed", response.status);
        return res.status(500).json({ error: "Failed to load memories" });
      }

      return res.status(200).json({ ok: true, memories: await response.json() });
    }

    const { category, content, importance } = req.body || {};

    if (
      typeof category !== "string" ||
      !category.trim() ||
      typeof content !== "string" ||
      !content.trim() ||
      !Number.isInteger(importance) ||
      importance < 1 ||
      importance > 5
    ) {
      return res.status(400).json({ error: "Invalid memory data" });
    }

    if (category.trim().length > 40 || content.length > 4000) {
      return res.status(413).json({ error: "Memory category or content exceeds the allowed size" });
    }

    // The database RPC must serialize identical keys in a transaction.
    // A client-side read-then-insert check cannot prevent concurrent duplicates.
    const response = await fetch(`${baseUrl}/rpc/save_memory_atomic`, {
      method: "POST",
      headers: { ...headers, Prefer: "return=representation" },
      body: JSON.stringify({
        p_user_id: user.id,
        p_category: category.trim(),
        p_content: content.trim(),
        p_importance: importance
      })
    });

    if (!response.ok) {
      console.error("Atomic memory save failed", response.status);
      return res.status(500).json({ error: "Failed to save memory" });
    }

    const saved = await response.json();
    return res.status(200).json({
      ok: true,
      memories: Array.isArray(saved) ? saved : [saved]
    });
  } catch (error) {
    console.error("Memory API request failed", error?.name || "UnknownError");
    return res.status(500).json({ error: "Memory service unavailable" });
  }
};
