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

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/interactions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": process.env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          model: "gemini-3.1-flash-tts-preview",
          input: text,
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

    let audioData = null;

    if (Array.isArray(data.steps)) {
      for (const step of data.steps) {
        if (step.type === "model_output" && Array.isArray(step.content)) {
          for (const content of step.content) {
            if (content.type === "audio" && content.data) {
              audioData = content.data;
              break;
            }
          }
        }

        if (audioData) break;
      }
    }

    if (!audioData) {
      console.error("TTS response:", JSON.stringify(data));

      return res.status(500).json({
        error: "Audio data was not returned.",
      });
    }

    return res.status(200).json({
      audio: audioData,
    });
  } catch (error) {
    console.error("TTS Error:", error);

    return res.status(500).json({
      error: error.message || "TTS request failed",
    });
  }
}
