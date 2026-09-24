import { searchManager } from "../lib/searchManager.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method Not Allowed",
    });
  }

  try {
    const {
      text,
      previousInteractionId
    } = req.body;

    if (!text) {
      return res.status(400).json({
        error: "text is required",
      });
    }

    const geminiKey =
      process.env.GEMINI_API_KEY;

    if (!geminiKey) {
      return res.status(500).json({
        error:
          "GEMINI_API_KEY is not configured",
      });
    }

    /*
     * ==========================================
     * Search Manager
     * ==========================================
     */

    const search =
      await searchManager(text);

    /*
     * ==========================================
     * Gemini Input
     * ==========================================
     */

    let geminiInput = text;

    if (search.context) {
      geminiInput = `
ユーザーからの質問:
${text}

以下はWeb検索で取得した情報です。
必要に応じて内容を参照して回答してください。

${search.context}

重要:
- 検索結果をそのまま信じず、内容を整理してください。
- 検索結果にない情報を検索結果由来として扱わないでください。
- 回答は日本語で行ってください。
`;
    }

    /*
     * ==========================================
     * Gemini Request
     * ==========================================
     */

    const requestBody = {
      model: "gemini-3.6-flash",

      input: geminiInput,

      /*
       * Google Searchは使用しない
       */

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
    };

    /*
     * ==========================================
     * Conversation Context
     * ==========================================
     */

    if (
      previousInteractionId &&
      typeof previousInteractionId === "string"
    ) {
      requestBody.previous_interaction_id =
        previousInteractionId;
    }

    /*
     * ==========================================
     * Gemini Interactions API
     * ==========================================
     */

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1/interactions",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": geminiKey,
        },

        body: JSON.stringify(requestBody),
      }
    );

    const data =
      await response.json();

    /*
     * ==========================================
     * Gemini Error
     * ==========================================
     */

    if (!response.ok) {
      return res.status(response.status).json({
        error: data,
      });
    }

    /*
     * ==========================================
     * Gemini Output
     * ==========================================
     */

    let outputText =
      data.output_text;

    if (
      !outputText &&
      Array.isArray(data.steps)
    ) {
      for (
        let i = data.steps.length - 1;
        i >= 0;
        i--
      ) {
        const step =
          data.steps[i];

        if (
          step?.type === "model_output" &&
          Array.isArray(step.content)
        ) {
          const textContent =
            step.content.find(
              (item) =>
                item.type === "text" &&
                item.text
            );

          if (textContent) {
            outputText =
              textContent.text;

            break;
          }
        }
      }
    }

    if (!outputText) {
      return res.status(500).json({
        error:
          "No text response from Gemini",
        data,
      });
    }

    /*
     * ==========================================
     * JSON Parse
     * ==========================================
     */

    let result;

    try {
      result =
        JSON.parse(outputText);
    } catch (error) {
      return res.status(500).json({
        error:
          "Gemini returned invalid JSON",
        raw: outputText,
      });
    }

    /*
     * ==========================================
     * Response Validation
     * ==========================================
     */

    if (
      !result.reply ||
      !result.memory ||
      typeof result.memory.shouldSave !==
        "boolean"
    ) {
      return res.status(500).json({
        error:
          "Invalid Gemini response structure",
        data: result,
      });
    }

    /*
     * ==========================================
     * Interaction ID
     * ==========================================
     */

    const interactionId =
      typeof data.id === "string"
        ? data.id
        : null;

    /*
     * ==========================================
     * Response
     * ==========================================
     */

    return res.status(200).json({
      text: result.reply,

      interactionId,

      memory: {
        shouldSave:
          result.memory.shouldSave,

        category:
          result.memory.category ||
          "personal",

        content:
          result.memory.content ||
          "",

        importance:
          result.memory.importance ||
          1,
      },

      sources:
        search.results || [],
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error:
        "Internal Server Error",
    });
  }
}
