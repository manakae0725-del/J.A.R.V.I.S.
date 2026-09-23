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
          "x-goog-api-key": apiKey,
          "Api-Revision": "2026-05-20"
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

    if (!response.ok) {
      return res.status(response.status).json({
        error:
          data?.error?.message ||
          "Gemini TTS request failed."
      });
    }

    const audio =
      data?.steps?.[0]?.content?.[0]?.data;

    if (!audio) {
      return res.status(500).json({
        error: "Audio data was not returned."
      });
    }

    return res.status(200).json({
      audio: audio
    });

  } catch (error) {

    return res.status(500).json({
      error:
        error?.message ||
        "TTS server error."
    });

  }
}
