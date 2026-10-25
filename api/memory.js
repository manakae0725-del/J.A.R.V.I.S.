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

  const supabaseUrl = SUPABASE_URL.replace(/\/+$/, "");
  const baseUrl = `${supabaseUrl}/rest/v1/memories`;
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

      const response = await fetch(`${baseUrl}?${params}`, { headers });

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

    const normalizedCategory = category.trim();
    const normalizedContent = content.trim();

    if (normalizedCategory.length > 40 || normalizedContent.length > 4000) {
      return res.status(413).json({ error: "Memory category or content exceeds the allowed size" });
    }

    // Use the database function so duplicate detection and insert/update happen atomically.
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/save_memory_atomic`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        p_user_id: user.id,
        p_category: normalizedCategory,
        p_content: normalizedContent,
        p_importance: importance
      })
    });

    if (!response.ok) {
      const responseText = await response.text();
      console.error("Atomic memory save failed", response.status, responseText.slice(0, 300));
      return res.status(500).json({ error: "Failed to save memory" });
    }

    const memories = await response.json();
    return res.status(200).json({ ok: true, memories });
  } catch (error) {
    console.error("Memory API request failed", error?.name || "UnknownError");
    return res.status(500).json({ error: "Memory service unavailable" });
  }
};
