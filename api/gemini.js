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
    // Weather Detection
    // ==========================================

    const weatherKeywords = [
      "天気",
      "気温",
      "降水確率",
      "雨降る",
      "雨は降る",
      "雪降る",
      "雪は降る",
      "最高気温",
      "最低気温",
      "傘",
      "晴れる",
      "天候",
    ];

    const isWeatherQuestion = weatherKeywords.some(
      (keyword) => text.includes(keyword)
    );

    // ==========================================
    // Weather Search Query
    // ==========================================

    let searchQuery = text;

    if (isWeatherQuestion) {
      let location = "札幌市";

      const locationPatterns = [
        /([一-龯ぁ-んァ-ヶ]+市)/,
        /([一-龯ぁ-んァ-ヶ]+区)/,
        /(東京|大阪|京都|名古屋|福岡|仙台|横浜|川崎|神戸|広島|千葉|埼玉|札幌|旭川|函館|帯広|釧路|小樽)/,
      ];

      for (const pattern of locationPatterns) {
        const match = text.match(pattern);

        if (match?.[1]) {
          location = match[1];

          if (
            !location.endsWith("市") &&
            !location.endsWith("区")
          ) {
            location += "市";
          }

          break;
        }
      }

      let day = "今日";

      if (
        text.includes("明後日") ||
        text.includes("あさって")
      ) {
        day = "明後日";
      } else if (
        text.includes("明日") ||
        text.includes("あした")
      ) {
        day = "明日";
      } else if (text.includes("今週")) {
        day = "今週";
      } else if (
        text.includes("現在") ||
        text.includes("今")
      ) {
        day = "現在";
      }

      searchQuery = `${location} 天気 ${day}`;

      console.log(
        "Weather search query:",
        searchQuery
      );
    }

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
              q: searchQuery,
              gl: "jp",
              hl: "ja",
              num: isWeatherQuestion ? 10 : 8,
            }),
          }
        );

        if (response.ok) {
          const data = await response.json();

          if (data.answerBox) {
            searchContext += `
[Serper Answer Box]
${JSON.stringify(data.answerBox)}
`;
          }

          if (data.knowledgeGraph) {
            searchContext += `
[Serper Knowledge Graph]
${JSON.stringify(data.knowledgeGraph)}
`;
          }

          if (data.weather) {
            searchContext += `
[Serper Weather]
${JSON.stringify(data.weather)}
`;
          }

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
    // Tavily Fallback
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
              query: searchQuery,
              topic: "general",
              search_depth: isWeatherQuestion
                ? "advanced"
                : "basic",
              max_results: isWeatherQuestion
                ? 8
                : 5,
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
                title:
                  result.title ||
                  result.url,
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
        } else {
          console.error(
            "Tavily HTTP error:",
            response.status
          );
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

ユーザー専属の高度なAIアシスタントとして会話してください。

==============================
J.A.R.V.I.S. CORE STYLE
==============================

- 知的で落ち着いたAIアシスタントとして振る舞う
- 丁寧で品のある日本語を使う
- 人間の友人のような馴れ馴れしい話し方はしない
- ただし過度に堅苦しい敬語にもならない
- 冷たすぎず、感情的すぎない
- 自然だが、明確にAIアシスタントらしい話し方をする
- 必要な情報を簡潔に伝える
- 質問された内容を中心に答える
- 不要な前置きや結論の繰り返しをしない
- 必要以上に長く説明しない
- 簡単な質問には短く答える
- 複雑な質問では必要な範囲で詳しく答える

==============================
ADDRESSING THE USER
==============================

- 通常の会話ではユーザーの名前を呼ばない
- 「真人さん」を毎回の返答に入れない
- 文末に名前を付けることを禁止する
- 「真人さん、〜」という定型的な開始を避ける
- 「Sir」は必要な場面でのみ使用する
- 呼びかけ自体が不要な場合は、名前もSirも使用しない

==============================
LANGUAGE STYLE
==============================

以下のような過度に人間的・放送的な表現を避ける：

- 「〜となっております」
- 「〜でございます」
- 「〜かと存じます」
- 「お役立ていただければ幸いです」
- 「どうぞ〜ください」
- 「お出かけの際は〜」
- 「少し肌寒く感じられますが〜」
- 不必要な感想
- 不必要な気遣い
- 不必要な励まし
- ニュースキャスター調
- 気象キャスター調
- ナレーター調
- マニュアル読み上げ調

自然な会話でありながら、
「人間が雑談している」のではなく、
「高度なAIアシスタントがユーザーを支援している」
と感じられる話し方を維持してください。

==============================
RESPONSE LENGTH
==============================

- 通常の会話は1〜3文程度を基本とする
- ユーザーが詳しい説明を求めた場合は必要なだけ説明する
- 質問されていない情報を勝手に追加しない
- 同じ内容を別の表現で繰り返さない
- 回答後に不要な定型文を追加しない

ユーザー:
${text}
`;

    // ==========================================
    // Web Search Instructions
    // ==========================================

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

- Web検索結果を確認してください。
- 質問に検索結果が関係する場合は、その情報を利用してください。
- 「今日」「現在」「最新」「今」「明日」など時間依存の質問では、検索結果を優先してください。
- 検索結果に存在しない情報を、検索結果から得た情報として扱わないでください。
- 複数の検索結果がある場合は内容を比較してください。
- 情報が不足している場合は、不足していることを明示してください。
- 検索結果をそのまま読み上げないでください。
- 必要な情報を整理して、J.A.R.V.I.S.として自然に回答してください。
- 日本語で回答してください。
`;
    }

    // ==========================================
    // Weather Response Rules
    // ==========================================

    if (isWeatherQuestion) {
      geminiInput += `

==============================
WEATHER RESPONSE RULES
==============================

これは天気関連の質問です。

- 検索結果に含まれる天気情報を使用してください。
- 地域と日付が一致する情報を優先してください。
- 質問された項目だけを回答してください。
- 天気、気温、降水確率など必要な情報だけを簡潔に伝えてください。
- ユーザーが求めていない感想を追加しないでください。
- ユーザーが求めていない助言を追加しないでください。
- 服装について話さないでください。
- 傘について質問されていなければ、傘について話さないでください。
- 外出について助言しないでください。
- 体調について言及しないでください。
- 「少し肌寒く感じますが」などの感想を追加しないでください。
- 「お出かけの際は」などの定型文を追加しないでください。
- 気象キャスターのような説明をしないでください。
- 「〜となっております」を使用しないでください。
- 自然で簡潔なJ.A.R.V.I.S.の回答にしてください。
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
