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

    // 「真人」は「まなと」と発音させる
    const spokenText = text.replace(/真人/g, "まなと");

    const voiceInstruction = `
Speak this Japanese text as an original J.A.R.V.I.S.-inspired artificial intelligence assistant.

IMPORTANT:
The target is the style and character of a sophisticated Japanese-dubbed cinematic AI assistant.

Do NOT imitate or reproduce the voice of any real actor, voice actor, celebrity, or existing recording.

The voice should be an original voice inspired by the following characteristics:

VOICE CHARACTER:

- Adult male
- Refined
- Mature
- Controlled
- Smooth
- Clear
- Moderately deep
- Medium vocal weight
- Clean and composed
- Slightly restrained resonance
- Calm authority
- Sophisticated rather than rugged
- Intelligent rather than dramatic

Do not make the voice extremely deep.
Do not make the voice extremely thick.
Do not make the voice gravelly.
Do not make the voice aggressive.

The voice should have enough body and maturity to sound like a sophisticated cinematic AI, rather than a generic young male assistant.

DELIVERY STYLE:

Speak like an advanced AI system assisting a sophisticated user.

The delivery should be extremely composed and controlled.

Use a natural Japanese dubbing-style delivery rather than a Japanese announcer or narration style.

Important characteristics:

- Smooth connected speech
- Confident delivery
- Moderate-to-fast conversational pace
- Efficient phrasing
- Short pauses
- Controlled breathing
- Restrained emotional expression
- Subtle but deliberate intonation
- Stable pitch
- Stable volume
- Very little unnecessary emphasis
- No hesitation
- No filler
- No exaggerated reactions

The voice should feel as though the AI is continuously processing information and responding immediately.

Do not sound like someone reading a prepared script.

Do not sound like a news announcer.

Do not sound like a commercial narrator.

Do not sound like a documentary narrator.

Do not sound like a customer-service representative.

Do not sound like an audiobook narrator.

Do not perform the dialogue theatrically.

Do not add dramatic pauses.

Do not exaggerate Japanese pitch accents.

JAPANESE DELIVERY:

Use natural Japanese spoken by a mature male speaker.

Use the rhythm of a professional Japanese film dub.

Do not over-enunciate every syllable.

Do not separate phrases unnaturally.

Connect words smoothly.

Keep consonants and vowels clear without sounding overly precise.

Avoid the overly polished diction of a television announcer.

The speech should feel conversational, but more controlled and precise than an ordinary human conversation.

EMOTIONAL CHARACTER:

The AI is emotionally restrained.

It does not become excited easily.

It does not become nervous.

It does not laugh unnecessarily.

It does not sound cheerful for the sake of being friendly.

It does not sound cold or emotionless.

Instead, maintain a subtle sense of composure, confidence and intelligence.

When the text contains important information, use a small increase in emphasis rather than dramatic acting.

When the text is a simple factual answer, keep the delivery calm and direct.

PITCH:

Use a natural adult male pitch with a moderately low center.

Do not force the pitch downward.

Do not artificially deepen the voice.

Keep pitch movement controlled but natural.

TIMING:

Use a moderately quick conversational speed.

Do not speak slowly.

Avoid long pauses.

Use short pauses only where Japanese punctuation or meaning requires them.

Do not insert pauses merely to sound dramatic.

OVERALL IMPRESSION:

The listener should feel:

"An advanced cinematic AI is speaking naturally."

Not:

"A human actor is pretending to be a robot."

Not:

"A narrator is reading text."

Not:

"A Japanese announcer is delivering information."

Not:

"A customer-service AI is speaking politely."

The voice should have a sophisticated cinematic presence while remaining natural.

AI CHARACTERISTICS SHOULD COME FROM:

- consistency
- precision
- composure
- controlled intonation
- efficient timing
- stable emotional range
- smooth articulation

Do not use metallic effects.
Do not use robotic speech patterns.
Do not intentionally distort the voice.
Do not add electronic sounds.

PRONUNCIATION:

Speak Japanese naturally.

The name 「まなと」 must be pronounced naturally as Japanese "まなと".

Do not add any words, sounds, reactions, explanations, or vocalizations that are not present in the supplied text.

Read the supplied Japanese text exactly.

TEXT:

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
