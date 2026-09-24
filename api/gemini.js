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

    const geminiKey = process.env.GEMINI_API_KEY;
    const tavilyKey = process.env.TAVILY_API_KEY;
    const serperKey = process.env.SERPER_API_KEY;

    if (!geminiKey) {
      return res.status(500).json({
        error: "GEMINI_API_KEY is not configured",
      });
    }

    /*
     * ==========================================
     * Web Search
     * ==========================================
     */

    let searchContext = "";
    const sources = [];

    /*
     * ------------------------------------------
     * Tavily
     * ------------------------------------------
     */

    if (tavilyKey) {
      try {
        const tavilyResponse = await fetch(
          "https://api.tavily.com/search",
          {
            method: "POST",

            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${tavilyKey}`,
            },

            body: JSON.stringify({
              query: text,
              topic: "general",
              search_depth: "basic",
              max_results: 5,
              include_answer: true,
              include_raw_content: false,
            }),
          }
        );

        if (tavilyResponse.ok) {
          const tavilyData =
            await tavilyResponse.json();

          if (Array.isArray(tavilyData.results)) {
            for (const result of tavilyData.results) {
              if (!result?.url) continue;

              sources.push({
                title:
                  result.title ||
                  result.url,

                url:
                  result.url,

                source: "tavily"
              });

              searchContext +=
                `\n[Tavily]\n` +
                `Title: ${result.title || ""}\n` +
                `URL: ${result.url}\n` +
                `Content: ${result.content || ""}\n`;
            }
          }
        }
      } catch (error) {
        console.error(
          "Tavily search error:",
          error
        );
      }
    }

    /*
     * ------------------------------------------
     * Serper
     * ------------------------------------------
     */

    if (serperKey) {
      try {
        const serperResponse = await fetch(
          "https://google.serper.dev/search",
          {
            method: "POST",

            headers: {
              "Content-Type": "application/json",
              "X-API-KEY": serperKey,
            },

            body: JSON.stringify({
              q: text,
              gl: "jp",
              hl: "ja",
              num: 5,
            }),
          }
        );

        if (serperResponse.ok) {
          const serperData =
            await serperResponse.json();

          if (
            Array.isArray(
              serperData.organic
            )
          ) {
            for (
              const result of
              serperData.organic
            ) {
              if (!result?.link) continue;

              sources.push({
                title:
                  result.title ||
                  result.link,

                url:
                  result.link,

                source: "serper"
              });

              searchContext +=
                `\n[Serper]\n` +
                `Title: ${result.title || ""}\n` +
                `URL: ${result.link}\n` +
                `Snippet: ${result.snippet || ""}\n`;
            }
          }
        }
      } catch (error) {
        console.error(
          "Serper search error:",
          error
        );
      }
    }

    /*
     * ==========================================
     * Gemini Input
     * ==========================================
     */

    let geminiInput = text;

    if (searchContext) {
      geminiInput = `
ユーザーからの質問:
${text}

以下はWeb検索で取得した最新情報です。
必要に応じて内容を参照して回答してください。

${searchContext}

重要:
- 検索結果をそのまま信じず、内容を比較・整理してください。
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
       * Google Search
       */
      tools: [
        {
          type: "google_search"
        }
      ],

      /*
       * Structured Output
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

        body: JSON.stringify(requestBody)
      }
    );

    const data = await response.json();

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
     * Google Search Citations
     * ==========================================
     */

    if (Array.isArray(data.steps)) {
      for (const step of data.steps) {
        if (
          step?.type !== "model_output" ||
          !Array.isArray(step.content)
        ) {
          continue;
        }

        for (
          const contentBlock
          of step.content
        ) {
          if (
            contentBlock?.type !== "text" ||
            !Array.isArray(
              contentBlock.annotations
            )
          ) {
            continue;
          }

          for (
            const annotation
            of contentBlock.annotations
          ) {
            if (
              annotation?.type ===
                "url_citation" &&
              annotation?.url
            ) {
              const exists =
                sources.some(
                  (source) =>
                    source.url ===
                    annotation.url
                );

              if (!exists) {
                sources.push({
                  title:
                    annotation.title ||
                    annotation.url,

                  url:
                    annotation.url,

                  source:
                    "google_search"
                });
              }
            }
          }
        }
      }
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

      interactionId:

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

      sources,
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error:
        "Internal Server Error",
    });
  }
}
