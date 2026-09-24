export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({
      ok: false,
      error: "Supabase environment variables are missing"
    });
  }

  const baseUrl = `${supabaseUrl}/rest/v1/memories`;

  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    "Content-Type": "application/json"
  };

  try {
    // GET: 記憶を取得
    if (req.method === "GET") {
      const response = await fetch(
        `${baseUrl}?select=*&is_active=eq.true&order=importance.desc,updated_at.desc`,
        {
          method: "GET",
          headers
        }
      );

      const data = await response.json();

      if (!response.ok) {
        return res.status(response.status).json({
          ok: false,
          error: data
        });
      }

      return res.status(200).json({
        ok: true,
        memories: data
      });
    }

    // POST: 記憶を保存
    const { category, content, importance } = req.body || {};

    if (!category || !content) {
      return res.status(400).json({
        ok: false,
        error: "category and content are required"
      });
    }

    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        ...headers,
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        category,
        content,
        importance:
          typeof importance === "number"
            ? Math.max(1, Math.min(5, importance))
            : 1
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        error: data
      });
    }

    return res.status(200).json({
      ok: true,
      memory: data
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Unknown error"
    });
  }
}
