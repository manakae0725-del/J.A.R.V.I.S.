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

    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: "GEMINI_API_KEY is not configured."
      });
    }

    // 「真人」を「まなと」と正しく発音させる
    const spokenText = text.replace(/真人/g, "まなと");

    const voiceInstruction = `
Speak the following Japanese text as J.A.R.V.I.S., an advanced artificial intelligence assistant.

VOICE DIRECTION:

Use a natural adult male voice.

Do NOT intentionally make the voice deeper, heavier, thicker, darker, or more masculine.
Do NOT create an obviously artificial or robotic voice.

The voice should feel natural and human in its basic vocal quality, while the DELIVERY should suggest an advanced AI.

The defining characteristics should come from the way the voice speaks, not from an exaggerated voice timbre.

DELIVERY:

- Calm
- Highly controlled
- Intelligent
- Precise
- Composed
- Consistent
- Emotionally restrained
- Slightly faster than slow conversational speech
- Short, efficient pauses
- Smooth continuous phrasing
- Clear but natural articulation
- Stable vocal energy
- Restrained pitch movement
- Subtle emphasis only when naturally required
- Very little emotional fluctuation

The delivery should feel exceptionally controlled and consistent.

Avoid unnecessary hesitation.
Avoid filler-like pauses.
Avoid dramatic pauses.
Avoid exaggerated emphasis.
Avoid theatrical delivery.
Avoid exaggerated emotional reactions.

Do not sound like a narrator.
Do not sound like a news announcer.
Do not sound like a commercial voice-over.
Do not sound like a customer-service representative.
Do not sound like a voice actor performing a character.
Do not sound overly friendly or cheerful.
Do not sound cold or hostile.

The result should resemble an advanced AI communicating naturally through a human voice.

The listener should perceive intelligence, precision and composure primarily through the delivery and consistency of the speech.

EMOTIONAL DIRECTION:

Keep emotion subtle and controlled.

Do not eliminate natural human prosody completely.
Do not make the speech monotone.

Use only small, natural variations in pitch, rhythm and emphasis.

The overall emotional range should remain narrow and stable.

PACING:

Use a natural conversational pace with a slight tendency toward efficiency.

Do not speak slowly for dramatic effect.

Keep pauses short unless punctuation naturally requires a pause.

Do not insert additional pauses between every phrase.

PRONUNCIATION:

Speak Japanese naturally.

Do not over-enunciate.

The name 「まなと」 must be pronounced naturally as Japanese "まなと".

Do not add words, explanations, reactions, or sounds that are not present in the text.

Read the following Japanese text exactly as provided:

${spokenText}
`;

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

          input: voiceInstruction,

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
