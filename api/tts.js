async function logApiUsage({
  provider,
  service,
  success,
  statusCode,
  durationMs,
  metadata = {}
}) {
  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey =
      process.env.SUPABASE_SECRET_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return;
    }

    await fetch(
      `${supabaseUrl}/rest/v1/api_usage`,
      {
        method: "POST",
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal"
        },
        body: JSON.stringify({
          provider,
          service,
          success,
          status_code: statusCode,
          duration_ms: durationMs,
          metadata
        })
      }
    );
  } catch (error) {
    console.error(
      "[API USAGE] Log failed:",
      error
    );
  }
}


export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not Allowed"
    });
  }

  try {
    const { text } = req.body || {};

    if (!text) {
      return res.status(400).json({
        error: "Text is required."
      });
    }

    const apiKey =
      process.env.ELEVENLABS_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error:
          "ELEVENLABS_API_KEY is not configured."
      });
    }

    // 「真人」は「まなと」と発音させる
    const spokenText =
      text.replace(/真人/g, "まなと");

    const ttsStart = Date.now();

    let response;

    try {
      response = await fetch(
        "https://api.elevenlabs.io/v1/text-to-speech/XrrS5KddqXY8b3ulN2uu?output_format=pcm_24000",
        {
          method: "POST",

          headers: {
            "xi-api-key": apiKey,
            "Content-Type": "application/json"
          },

          body: JSON.stringify({
            text: spokenText,
            model_id: "eleven_multilingual_v2"
          })
        }
      );
    } catch (error) {
      const durationMs =
        Date.now() - ttsStart;

      await logApiUsage({
        provider: "elevenlabs",
        service: "tts",
        success: false,
        statusCode: null,
        durationMs,
        metadata: {
          model: "eleven_multilingual_v2",
          voice: "XrrS5KddqXY8b3ulN2uu",
          error:
            error?.message ||
            "Unknown error"
        }
      });

      throw error;
    }

    const durationMs =
      Date.now() - ttsStart;

    await logApiUsage({
      provider: "elevenlabs",
      service: "tts",
      success: response.ok,
      statusCode: response.status,
      durationMs,
      metadata: {
        model: "eleven_multilingual_v2",
        voice: "XrrS5KddqXY8b3ulN2uu"
      }
    });

    if (!response.ok) {
      let errorMessage =
        "ElevenLabs TTS request failed.";

      try {
        const data = await response.json();

        errorMessage =
          data?.detail?.message ||
          data?.detail?.status ||
          data?.error ||
          errorMessage;
      } catch (e) {}

      return res.status(response.status).json({
        error: errorMessage
      });
    }

    const arrayBuffer =
      await response.arrayBuffer();

    const audio =
      Buffer.from(arrayBuffer).toString("base64");

    if (!audio) {
      return res.status(500).json({
        error: "Audio data was not returned."
      });
    }

    return res.status(200).json({
      audio
    });

  } catch (error) {
    return res.status(500).json({
      error:
        error?.message ||
        "TTS server error."
    });
  }
}
