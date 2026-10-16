
const { requireAuth } = require("./_auth");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

module.exports = async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await requireAuth(req, res);
  if (!user) return;

  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    console.error("Memory API environment variables are missing");
    return res.status(500).json({ error: "Memory service unavailable" });
  }

  const baseUrl =
    `${SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/memories`;

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

      return res.status(200).json(await response.json());
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

    const searchParams = new URLSearchParams({
      select: "id",
      user_id: `eq.${user.id}`,
      category: `eq.${normalizedCategory}`,
      content: `eq.${normalizedContent}`,
      is_active: "eq.true",
      limit: "1"
    });

    const searchResponse = await fetch(
      `${baseUrl}?${searchParams}`,
      { headers }
    );

    if (!searchResponse.ok) {
      console.error("Memory duplicate check failed", searchResponse.status);
      return res.status(500).json({ error: "Failed to save memory" });
    }

    const existing = await searchResponse.json();

    if (existing.length > 0) {
      const updateParams = new URLSearchParams({
        id: `eq.${existing[0].id}`,
        user_id: `eq.${user.id}`
      });

      const updateResponse = await fetch(
        `${baseUrl}?${updateParams}`,
        {
          method: "PATCH",
          headers: {
            ...headers,
            Prefer: "return=representation"
          },
          body: JSON.stringify({
            importance,
            updated_at: new Date().toISOString()
          })
        }
      );

      if (!updateResponse.ok) {
        console.error("Memory update failed", updateResponse.status);
        return res.status(500).json({ error: "Failed to save memory" });
      }

      return res.status(200).json(await updateResponse.json());
    }

    const insertResponse = await fetch(baseUrl, {
      method: "POST",
      headers: {
        ...headers,
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        user_id: user.id,
        category: normalizedCategory,
        content: normalizedContent,
        importance,
        is_active: true
      })
    });

    if (!insertResponse.ok) {
      console.error("Memory insert failed", insertResponse.status);
      return res.status(500).json({ error: "Failed to save memory" });
    }

    return res.status(201).json(await insertResponse.json());
  } catch (error) {
    console.error("Memory API request failed");
    return res.status(500).json({ error: "Memory service unavailable" });
  }
};
