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


import { requireAuth } from "./_auth.js";
import { enforceRateLimit } from "./_rateLimit.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not Allowed"
    });
  }

  const user = await requireAuth(req, res);
  if (!user) return;

  if (!(await enforceRateLimit(res, user, "tts-minute", 20, 60))) return;
  if (!(await enforceRateLimit(res, user, "tts-day", 300, 86400))) return;

  try {
    const { text } = req.body || {};

    if (!text) {
      return res.status(400).json({
        error: "Text is required."
      });
    }

    if (typeof text !== "string" || text.length > 5000) {
      return res.status(413).json({ error: "Text exceeds the 5000-character limit" });
    }

    const apiKey =
      process.env.ELEVENLABS_API_KEY;

  const settingsResponse = await fetch(
    "https://api.elevenlabs.io/v1/voices/XrrS5KddqXY8b3ulN2uu/settings",
    { headers: { "xi-api-key": apiKey } }
  );

  if (settingsResponse.ok) {
    const settings = await settingsResponse.json();
    console.log("[JARVIS VOICE SETTINGS]", settings);
  } else {
    console.error(
      "[JARVIS VOICE SETTINGS] Failed:",
      settingsResponse.status
    );
  }

    if (!apiKey) {
      return res.status(500).json({
        error:
          "ELEVENLABS_API_KEY is not configured."
      });
    }

   
    // 読み上げ用テキストの補正
    const spokenText = text
      .replace(/真人/g, "まなと")
      .replace(/札幌市/g, "さっぽろし")
      .replace(/札幌/g, "さっぽろ")
      .replace(/気温/g, "きおん")
      .replace(/(-?\d+(?:\.\d+)?)\s*℃/g, "$1度");

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
 model_id: "eleven_v3",
  voice_settings: {
    stability: 0.77,
    similarity_boost: 0.75,
    style: 0,
    use_speaker_boost: true,
    speed: 0.9
  }
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

      console.error("ElevenLabs TTS request failed", {
        status: response.status
      });
      return res.status(502).json({
        error: "Speech synthesis failed"
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
    console.error("TTS handler failed", {
      name: error?.name || "Error"
    });
    return res.status(500).json({
      error: "TTS server error."
    });
  }
}
