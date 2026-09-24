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

    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: "GEMINI_API_KEY is not configured",
      });
    }

    const requestBody = {
      model: "gemini-3.6-flash",

      input: text,

      /* ================================
         Google Search
         ================================ */

      tools: [
        {
          type: "google_search"
        }
      ],

      /* ================================
         構造化出力
         ================================ */

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


    /* ================================
       短期会話コンテキスト
       ================================ */

    if (
      previousInteractionId &&
      typeof previousInteractionId === "string"
    ) {
      requestBody.previous_interaction_id =
        previousInteractionId;
    }


    /* ================================
       Gemini Interactions API
       ================================ */

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1/interactions",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },

        body: JSON.stringify(requestBody)
      }
    );


    const data = await response.json();


    /* ================================
       Gemini APIエラー
       ================================ */

    if (!response.ok) {

      return res.status(response.status).json({
        error: data,
      });

    }


    /* ================================
       Gemini出力取得
       ================================ */

    let outputText = data.output_text;


    if (!outputText && Array.isArray(data.steps)) {

      for (
        let i = data.steps.length - 1;
        i >= 0;
        i--
      ) {

        const step = data.steps[i];

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
        error: "No text response from Gemini",
        data,
      });

    }


    /* ================================
       JSON解析
       ================================ */

    let result;

    try {

      result =
        JSON.parse(outputText);

    } catch (error) {

      return res.status(500).json({
        error: "Gemini returned invalid JSON",
        raw: outputText,
      });

    }


    /* ================================
       レスポンス構造確認
       ================================ */

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


    /* ================================
       Google Search 引用情報
       ================================ */

    const sources = [];

    if (Array.isArray(data.steps)) {

      for (const step of data.steps) {

        if (
          step?.type !== "model_output" ||
          !Array.isArray(step.content)
        ) {
          continue;
        }

        for (const contentBlock of step.content) {

          if (
            contentBlock?.type !== "text" ||
            !Array.isArray(contentBlock.annotations)
          ) {
            continue;
          }

          for (const annotation of contentBlock.annotations) {

            if (
              annotation?.type === "url_citation" &&
              annotation?.url
            ) {

              const exists =
                sources.some(
                  (source) =>
                    source.url === annotation.url
                );

              if (!exists) {

                sources.push({
                  title:
                    annotation.title ||
                    annotation.url,

                  url:
                    annotation.url
                });

              }
            }
          }
        }
      }
    }


    /* ================================
       次回会話用Interaction ID
       ================================ */

    const interactionId =
      typeof data.id === "string"
        ? data.id
        : null;


    /* ================================
       レスポンス
       ================================ */

    return res.status(200).json({

      text: result.reply,

      interactionId: interactionId,

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

      sources: sources,

    });

  } catch (error) {

    console.error(error);

    return res.status(500).json({
      error: "Internal Server Error",
    });

  }
}
