export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method Not Allowed",
    });
  }

  try {
    const { text } = req.body;

    if (!text) {
      return res.status(400).json({
        error: "text is required",
      });
    }

    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: "GEMINI_API_KEY is not configured",
      });
    }

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/interactions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
          "Api-Revision": "2026-05-20",
        },
        body: JSON.stringify({
          model: "gemini-3.1-flash-tts-preview",
          input:
            "落ち着いた、知的で紳士的なAIアシスタントとして話してください。\n\n" +
            text,
          response_format: {
            type: "audio",
          },
          generation_config: {
            speech_config: [
              {
                voice: "Charon",
              },
            ],
          },
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data,
      });
    }

    const audioData = data.output_audio?.data;

    if (!audioData) {
      return res.status(500).json({
        error: "No audio response from Gemini",
        data,
      });
    }

    return res.status(200).json({
      audio: audioData,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
}
