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
      "https://generativelanguage.googleapis.com/v1/interactions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          model: "gemini-3.6-flash",

          input: text,

          response_format: {
            type: "text",
            mime_type: "application/json",
            schema: {
              type: "object",

              properties: {
                reply: {
                  type: "string",
                },

                memory: {
                  type: "object",

                  properties: {
                    shouldSave: {
                      type: "boolean",
                    },

                    category: {
                      type: "string",
                      enum: [
                        "personal",
                        "preference",
                        "work",
                        "family",
                        "goal"
                      ],
                    },

                    content: {
                      type: "string",
                    },

                    importance: {
                      type: "integer",
                      minimum: 1,
                      maximum: 5,
                    }
                  },

                  required: [
                    "shouldSave",
                    "category",
                    "content",
                    "importance"
                  ]
                }
              },

              required: [
                "reply",
                "memory"
              ]
            }
          }
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data,
      });
    }

    let outputText = data.output_text;

    if (!outputText && Array.isArray(data.steps)) {
      for (let i = data.steps.length - 1; i >= 0; i--) {
        const content = data.steps[i]?.content;

        if (Array.isArray(content)) {
          const textContent = content.find(
            (item) => item.type === "text" && item.text
          );

          if (textContent) {
            outputText = textContent.text;
            break;
          }
        }
      }
    }

    if (!outputText) {
      return res.status(500).json({
        error: "No text response from Gemini",
        data,
      });
    }

    let result;

    try {
      result = JSON.parse(outputText);
    } catch (error) {
      return res.status(500).json({
        error: "Gemini returned invalid JSON",
        raw: outputText,
      });
    }

    if (
      !result.reply ||
      !result.memory ||
      typeof result.memory.shouldSave !== "boolean"
    ) {
      return res.status(500).json({
        error: "Invalid Gemini response structure",
        data: result,
      });
    }

    return res.status(200).json({
      text: result.reply,

      memory: {
        shouldSave: result.memory.shouldSave,
        category: result.memory.category || "personal",
        content: result.memory.content || "",
        importance: result.memory.importance || 1,
      },
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
}
