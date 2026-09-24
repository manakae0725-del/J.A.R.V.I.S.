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

    // TTSでは「真人」を「まなと」と読ませる
    const spokenText = text.replace(/真人/g, "まなと");

    const voiceInstruction = `
Speak as J.A.R.V.I.S., an advanced artificial intelligence assistant.

The goal is NOT to sound like a human pretending to be an AI.
The goal is to sound like an AI that naturally communicates using a human-like voice.

Voice identity:
- Strongly convey the presence of an artificial intelligence
- Calm, highly intelligent and controlled
- Slightly low and mature male voice
- Sophisticated and precise
- Emotionally restrained
- Very stable vocal expression
- Minimal emotional fluctuation
- Minimal conversational enthusiasm
- No excessive warmth or friendliness
- No exaggerated human-like reactions
- No cheerful customer-service tone
- No theatrical acting
- No dramatic emotional performance
- No robotic, metallic, synthetic, or computerized voice
- Do not imitate any real person or celebrity

AI characteristics:
- Speak with deliberate control
- Keep pitch variation relatively restrained
- Keep emotional emphasis subtle
- Maintain a consistent vocal presence
- Sound confident without sounding aggressive
- Sound intelligent without sounding theatrical
- The listener should feel that an advanced AI is speaking through a natural human voice

Delivery:
- Natural Japanese pronunciation
- Smooth conversational rhythm
- Slightly measured pacing
- Clear articulation
- Controlled pauses
- Do not over-enunciate
- Do not add dramatic pauses
- Do not add unnecessary emphasis
- Do not add words that are not present in the text

Avoid:
- News announcer style
- Weather broadcaster style
- Commercial narration
- Voice actor performance
- Excessive emotional expression
- Casual human conversation style
- Overly warm or friendly delivery
- Robotic computer voice

Pronunciation:
- The name 「まなと」 must be pronounced naturally as Japanese "まなと".

Read the following Japanese text exactly as intended:

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
