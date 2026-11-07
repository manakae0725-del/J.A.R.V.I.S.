async function logApiUsage({
  provider,
  service,
  success,
  statusCode,
  durationMs,
  metadata = {},
  characterCount = null
}) {
  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey =
      process.env.SUPABASE_SECRET_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return;
    }

    const response = await fetch(
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
          character_count: characterCount,
          cost_status: "unpriced",
          metadata
        })
      }
    );
    if (!response.ok) {
      console.error("[API USAGE] Log write rejected", {
        provider,
        service,
        statusCode: response.status
      });
    }
  } catch (error) {
    console.error("[API USAGE] Log request failed", {
      provider,
      service,
      name: error?.name || "Error"
    });

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

    const apiKey = process.env.ELEVENLABS_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: "ELEVENLABS_API_KEY is not configured."
      });
    }

    // Voice settings are sent directly in the synthesis request; no separate settings lookup is needed.
   
    // 読み上げ用テキストの補正
    const spokenText = text
      .replace(/真人/g, "まなと")
      .replace(/札幌市/g, "さっぽろし")
      .replace(/札幌/g, "さっぽろ")
      .replace(/気温/g, "きおん")
      .replace(/(-?\d+(?:\.\d+)?)\s*℃/g, "$1度");

    const ttsStart = Date.now();

    let response;
    const ttsController = new AbortController();
    const ttsTimeoutMs = 25000;
    const ttsTimeout = setTimeout(() => ttsController.abort(), ttsTimeoutMs);

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
          signal: ttsController.signal
        }
      );
    } catch (error) {
      const durationMs = Date.now() - ttsStart;
      const timedOut = error?.name === "AbortError";
      await logApiUsage({
        provider: "elevenlabs",
        service: "tts",
        success: false,
        statusCode: timedOut ? 504 : null,
        durationMs,
        characterCount: spokenText.length,
        metadata: {
          model: "eleven_v3",
          voice: "XrrS5KddqXY8b3ulN2uu",
          error: timedOut ? "TTS request timed out" : "TTS request failed"
        }
      });
      if (timedOut) {
        console.error("ElevenLabs TTS request timed out", { durationMs });
        return res.status(504).json({ error: "Speech synthesis timed out" });
      }
      console.error("ElevenLabs TTS request failed", { name: error?.name || "Error" });
      return res.status(502).json({ error: "Speech synthesis failed" });
    } finally {
      clearTimeout(ttsTimeout);
    }

    const durationMs =
      Date.now() - ttsStart;

    if (!response.ok) {
      await logApiUsage({
        provider: "elevenlabs",
        service: "tts",
        success: false,
        statusCode: response.status,
        durationMs,
        metadata: { model: "eleven_v3", voice: "XrrS5KddqXY8b3ulN2uu", error: "Provider request rejected" }
      });
      console.error("ElevenLabs TTS request failed", { status: response.status });
      return res.status(502).json({ error: "Speech synthesis failed" });
    }

    let arrayBuffer;
    try {
      arrayBuffer = await response.arrayBuffer();
    } catch (error) {
      await logApiUsage({
        provider: "elevenlabs",
        service: "tts",
        success: false,
        statusCode: 502,
        durationMs,
        metadata: { model: "eleven_v3", voice: "XrrS5KddqXY8b3ulN2uu", error: "Invalid audio response" }
      });
      console.error("ElevenLabs returned an unreadable audio response", { name: error?.name || "Error" });
      return res.status(502).json({ error: "Speech synthesis failed" });
    }

    if (!arrayBuffer.byteLength) {
      await logApiUsage({
        provider: "elevenlabs",
        service: "tts",
        success: false,
        statusCode: 502,
        durationMs,
        metadata: { model: "eleven_v3", voice: "XrrS5KddqXY8b3ulN2uu", error: "Empty audio response" }
      });
      return res.status(502).json({ error: "Speech synthesis failed" });
    }

    await logApiUsage({
      provider: "elevenlabs",
      service: "tts",
      success: true,
      statusCode: response.status,
      durationMs,
      characterCount: spokenText.length,
      metadata: {
        model: "eleven_v3",
        voice: "XrrS5KddqXY8b3ulN2uu"
      }
    });

    const audio = Buffer.from(arrayBuffer).toString("base64");

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
