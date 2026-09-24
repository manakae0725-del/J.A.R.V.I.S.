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
Speak as J.A.R.V.I.S., an advanced personal artificial intelligence assistant.

Voice identity:
- Clearly sound like an AI assistant, not an ordinary human speaker
- Calm, intelligent and highly controlled
- Slightly low and mature male voice
- Cool and composed
- Precise and deliberate
- Emotion is restrained
- Do not sound cheerful, excited, emotional, or overly warm
- Do not sound like an actor, announcer, narrator, weather broadcaster, or commercial voice
- Do not imitate a human celebrity or real person
- Maintain a subtle sense of artificial intelligence and advanced technology
- Natural enough for conversation, but clearly not overly human
- Speak directly to one person
- Use smooth Japanese conversational rhythm
- Keep the delivery controlled and concise
- Do not exaggerate pronunciation
- Do not add dramatic pauses
- Do not add emotional emphasis
- Do not add words that are not present in the text

Pronunciation:
- The name 「まなと」 must be pronounced naturally as Japanese "まなと".
- Do not reinterpret or change the pronunciation.

Read the following Japanese text exactly as intended, with the J.A.R.V.I.S. voice described above:

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
