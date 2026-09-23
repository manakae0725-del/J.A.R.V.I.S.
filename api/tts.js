export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method Not Allowed"
    });
  }

  try {
    const { text } = req.body || {};

    if (!text) {
      return res.status(400).json({
        error: "Text is required."
      });
    }

    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: "GEMINI_API_KEY is not configured."
      });
    }

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/interactions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
          model: "gemini-3.1-flash-tts-preview",
          input: text,
          response_format: {
            type: "audio"
          },
          generation_config: {
            speech_config: [
              {
                voice: "Charon"
              }
            ]
          }
        })
      }
    );

    const data = await response.json();

    // APIキー・音声データ本体を絶対に返さないための診断情報
    function inspect(value, depth = 0) {
      if (depth > 5) {
        return {
          type: typeof value
        };
      }

      if (value === null) {
        return {
          type: "null"
        };
      }

      if (Array.isArray(value)) {
        return {
          type: "array",
          length: value.length,
          items: value.slice(0, 5).map((item) =>
            inspect(item, depth + 1)
          )
        };
      }

      if (typeof value === "object") {
        const result = {};

        for (const [key, val] of Object.entries(value)) {
          // APIキー等の機密情報を除外
          if (
            /api.?key|authorization|token|secret|password/i.test(key)
          ) {
            result[key] = {
              type: "REDACTED"
            };
            continue;
          }

          if (typeof val === "string") {
            result[key] = {
              type: "string",
              length: val.length,
              preview: val.slice(0, 20)
            };
          } else if (Array.isArray(val)) {
            result[key] = inspect(val, depth + 1);
          } else if (val && typeof val === "object") {
            result[key] = inspect(val, depth + 1);
          } else {
            result[key] = {
              type: typeof val,
              value: val
            };
          }
        }

        return result;
      }

      return {
        type: typeof value,
        value: value
      };
    }

    return res.status(response.status).json({
      diagnostic: true,
      gemini_http_status: response.status,
      gemini_ok: response.ok,
      response_structure: inspect(data)
    });

  } catch (error) {
    return res.status(500).json({
      error: "TTS diagnostic failed.",
      message: error?.message || "Unknown error"
    });
  }
}
