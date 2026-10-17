async function logApiUsage({
  userId,
  provider,
  service,
  success,
  statusCode,
  durationMs,
  metadata = {}
}) {
  const safeMetadata = {};
  for (const key of ["model", "queryType", "fallback", "failureType", "voice"]) {
    const value = metadata && metadata[key];
    if (typeof value === "boolean" && key === "fallback") {
      safeMetadata[key] = value;
    } else if (typeof value === "string" && value.length <= 80 && /^[a-zA-Z0-9_.-]+$/.test(value)) {
      safeMetadata[key] = value;
    }
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey =
      process.env.SUPABASE_SECRET_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return;
    }

    const logResponse = await fetch(
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
          user_id: userId || null,
          provider,
          service,
          success,
          status_code: statusCode,
          duration_ms: durationMs,
          metadata: safeMetadata
        }),
        signal: AbortSignal.timeout(3000)
      }
    );
    if (!logResponse.ok) {
      console.error("[API USAGE] Logging rejected", { status: logResponse.status });
    }
  } catch (error) {
    console.error("[API USAGE] Logging failed", { name: error && typeof error.name === "string" ? error.name : "Error" });
  }
}


import { requireAuth } from "./_auth.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not Allowed"
    });
  }

  const user = await requireAuth(req, res);
  if (!user) return;

  try {
    const { text } = req.body || {};

    if (typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "Invalid text input." });
    }

    if (text.length > 3000) {
      return res.status(413).json({ error: "Text input is too long." });
    }

    const apiKey =
      process.env.ELEVENLABS_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: "TTS service unavailable."
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
          }),
          signal: AbortSignal.timeout(20000)
        }
      );
    } catch (error) {
      const durationMs =
        Date.now() - ttsStart;

      await logApiUsage({
          userId: user.id,
        provider: "elevenlabs",
        service: "tts",
        success: false,
        statusCode: null,
        durationMs,
        metadata: {
          model: "eleven_v3",
          voice: "configured_voice"
        }
      });

      throw error;
    }

    const durationMs =
      Date.now() - ttsStart;

    await logApiUsage({
          userId: user.id,
      provider: "elevenlabs",
      service: "tts",
      success: response.ok,
      statusCode: response.status,
      durationMs,
      metadata: {
        model: "eleven_v3",
        voice: "configured_voice"
      }
    });

    if (!response.ok) {
      console.error("ElevenLabs TTS request failed", { status: response.status });
      return res.status(502).json({ error: "TTS service unavailable." });
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
    console.error("TTS request failed", {
      name: error && typeof error.name === "string" ? error.name : "Error"
    });
    return res.status(502).json({ error: "TTS service unavailable." });
  }
}
