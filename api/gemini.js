export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method Not Allowed",
    });
  }

  try {
    const {
      text,
      previousInteractionId,
    } = req.body;

    if (!text) {
      return res.status(400).json({
        error: "text is required",
      });
    }

    const geminiKey = process.env.GEMINI_API_KEY;
    const serperKey = process.env.SERPER_API_KEY;
    const tavilyKey = process.env.TAVILY_API_KEY;

    if (!geminiKey) {
      return res.status(500).json({
        error: "GEMINI_API_KEY is not configured",
      });
    }

    let searchContext = "";
    const sources = [];

    // ==========================================
    // Serper Search
    // ==========================================

    if (serperKey) {
      try {
        const response = await fetch(
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
              num: 8,
            }),
          }
        );

        if (response.ok) {
          const data = await response.json();

          // Answer Box
          if (data.answerBox) {
            searchContext += `
[Serper Answer Box]
${JSON.stringify(data.answerBox)}
`;
          }

          // Knowledge Graph
          if (data.knowledgeGraph) {
            searchContext += `
[Serper Knowledge Graph]
${JSON.stringify(data.knowledgeGraph)}
`;
          }

          // Organic results
          if (Array.isArray(data.organic)) {
            for (const result of data.organic) {
              if (!result?.link) continue;

              const title = result.title || "";
              const url = result.link;
              const snippet = result.snippet || "";

              sources.push({
                title,
                url,
                source: "serper",
              });

              searchContext += `
[Serper Search Result]
Title: ${title}
URL: ${url}
Snippet: ${snippet}
`;
            }
          }
        } else {
          console.error(
            "Serper HTTP error:",
            response.status
          );
        }
      } catch (error) {
        console.error(
          "Serper search error:",
          error
        );
      }
    }

    // ==========================================
    // Tavily fallback
    // ==========================================

    if (!searchContext && tavilyKey) {
      try {
        const response = await fetch(
          "https://api.tavily.com/search",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${tavilyKey}`,
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

        if (response.ok) {
          const data = await response.json();

          if (data.answer) {
            searchContext += `
[Tavily Answer]
${data.answer}
`;
          }

          if (Array.isArray(data.results)) {
            for (const result of data.results) {
              if (!result?.url) continue;

              sources.push({
                title: result.title || result.url,
                url: result.url,
                source: "tavily",
              });

              searchContext += `
[Tavily Search Result]
Title: ${result.title || ""}
URL: ${result.url}
Content: ${result.content || ""}
`;
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

    // ==========================================
    // Gemini Input
    // ==========================================

    let geminiInput = `
あなたはJ.A.R.V.I.S.です。

ユーザー:
${text}
`;

    if (searchContext) {
      geminiInput += `

==============================
WEB SEARCH RESULTS
==============================

以下は、ユーザーの質問に対して取得した最新のWeb検索結果です。

${searchContext}

==============================
SEARCH INSTRUCTIONS
==============================

- Web検索結果を必ず確認してください。
- ユーザーの質問に検索結果が関係する場合、検索結果を利用して回答してください。
- 「今日」「現在」「最新」「今」など時間依存の質問では、検索結果を優先してください。
- 検索結果に存在しない情報を、検索結果から得た情報として扱わないでください。
- 複数の検索結果がある場合は内容を比較してください。
- 情報が不足している場合は、不足していると明示してください。
- 日本語で回答してください。
- 簡潔かつ自然なJ.A.R.V.I.S.口調で回答してください。
`;
    }

    // ==========================================
    // Gemini Request
    // ==========================================

    const requestBody = {
      model: "gemini-3.6-flash",

      input: geminiInput,

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
                    "goal",
                  ],
                },

                content: {
                  type: "string",
                },

                importance: {
                  type: "integer",
                  minimum: 1,
                  maximum: 5,
                },
              },

              required: [
                "shouldSave",
                "category",
                "content",
                "importance",
              ],
            },
          },

          required: [
            "reply",
            "memory",
          ],
        },
      },
    };

    // ==========================================
    // Conversation Context
    // ==========================================

    if (
      previousInteractionId &&
      typeof previousInteractionId === "string"
    ) {
      requestBody.previous_interaction_id =
        previousInteractionId;
    }

    // ==========================================
    // Gemini Interactions API
    // ==========================================

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

    const data = await response.json();

    if (!response.ok) {
      console.error(
        "Gemini API error:",
        data
      );

      return res.status(response.status).json({
        error: data,
      });
    }

    // ==========================================
    // Gemini Output
    // ==========================================

    let outputText = data.output_text;

    if (
      !outputText &&
      Array.isArray(data.steps)
    ) {
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
                item?.type === "text" &&
                item?.text
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

    // ==========================================
    // JSON Parse
    // ==========================================

    let result;

    try {
      result = JSON.parse(outputText);
    } catch (error) {
      console.error(
        "JSON parse error:",
        outputText
      );

      return res.status(500).json({
        error: "Gemini returned invalid JSON",
        raw: outputText,
      });
    }

    // ==========================================
    // Validation
    // ==========================================

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

    // ==========================================
    // Interaction ID
    // ==========================================

    const interactionId =
      typeof data.id === "string"
        ? data.id
        : null;

    // ==========================================
    // Response
    // ==========================================

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
          result.memory.content || "",

        importance:
          result.memory.importance || 1,
      },

      sources,
    });
  } catch (error) {
    console.error(
      "Internal error:",
      error
    );

    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
}
