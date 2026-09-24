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
    /* ================================
       GET: 記憶を取得
       ================================ */

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


    /* ================================
       POST: 記憶を保存
       ================================ */

    const {
      category,
      content,
      importance
    } = req.body || {};

    if (!category || !content) {
      return res.status(400).json({
        ok: false,
        error: "category and content are required"
      });
    }

    const cleanCategory =
      String(category).trim();

    const cleanContent =
      String(content).trim();

    if (!cleanCategory || !cleanContent) {
      return res.status(400).json({
        ok: false,
        error: "category and content cannot be empty"
      });
    }

    const cleanImportance =
      typeof importance === "number"
        ? Math.max(
            1,
            Math.min(5, importance)
          )
        : 1;


    /* ================================
       既存記憶を検索
       ================================ */

    const encodedCategory =
      encodeURIComponent(cleanCategory);

    const encodedContent =
      encodeURIComponent(cleanContent);

    const findResponse = await fetch(
      `${baseUrl}?select=*&category=eq.${encodedCategory}&content=eq.${encodedContent}&is_active=eq.true&limit=1`,
      {
        method: "GET",
        headers
      }
    );

    const existingData =
      await findResponse.json();

    if (!findResponse.ok) {
      return res.status(findResponse.status).json({
        ok: false,
        error: existingData
      });
    }


    /* ================================
       既存なら更新
       ================================ */

    if (
      Array.isArray(existingData) &&
      existingData.length > 0
    ) {

      const existing =
        existingData[0];

      const updateResponse =
        await fetch(
          `${baseUrl}?id=eq.${existing.id}`,
          {
            method: "PATCH",

            headers: {
              ...headers,
              Prefer: "return=representation"
            },

            body: JSON.stringify({
              importance: cleanImportance,
              updated_at: new Date().toISOString()
            })
          }
        );

      const updateData =
        await updateResponse.json();

      if (!updateResponse.ok) {
        return res.status(
          updateResponse.status
        ).json({
          ok: false,
          error: updateData
        });
      }

      return res.status(200).json({
        ok: true,
        action: "updated",
        memory: updateData
      });
    }


    /* ================================
       新規保存
       ================================ */

    const insertResponse =
      await fetch(baseUrl, {
        method: "POST",

        headers: {
          ...headers,
          Prefer: "return=representation"
        },

        body: JSON.stringify({
          category: cleanCategory,
          content: cleanContent,
          importance: cleanImportance
        })
      });

    const insertData =
      await insertResponse.json();

    if (!insertResponse.ok) {
      return res.status(
        insertResponse.status
      ).json({
        ok: false,
        error: insertData
      });
    }

    return res.status(200).json({
      ok: true,
      action: "created",
      memory: insertData
    });

  } catch (error) {

    return res.status(500).json({
      ok: false,
      error:
        error.message ||
        "Unknown error"
    });
  }
}
