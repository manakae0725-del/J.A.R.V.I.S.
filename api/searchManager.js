function needsSearch(text) {
  const keywords = [
    "今日",
    "現在",
    "最新",
    "今",
    "天気",
    "ニュース",
    "価格",
    "値段",
    "営業時間",
    "発売",
    "検索",
    "調べて",
    "調査",
    "誰",
    "いつ",
    "どこ",
    "何年",
    "最近",
  ];

  return keywords.some((keyword) =>
    text.includes(keyword)
  );
}

function needsDeepResearch(text) {
  const keywords = [
    "詳しく調べて",
    "深く調べて",
    "徹底的に",
    "比較して",
    "比較調査",
    "徹底調査",
    "深掘り",
    "理由を調べて",
    "複数の情報源",
  ];

  return keywords.some((keyword) =>
    text.includes(keyword)
  );
}

async function searchTavily(text, apiKey) {
  const response = await fetch(
    "https://api.tavily.com/search",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
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

  if (!response.ok) {
    throw new Error(
      `Tavily error: ${response.status}`
    );
  }

  const data = await response.json();

  const results = Array.isArray(data.results)
    ? data.results
    : [];

  return results
    .filter((result) => result?.url)
    .map((result) => ({
      title: result.title || result.url,
      url: result.url,
      content: result.content || "",
      source: "tavily",
    }));
}

async function searchSerper(text, apiKey) {
  const response = await fetch(
    "https://google.serper.dev/search",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": apiKey,
      },
      body: JSON.stringify({
        q: text,
        gl: "jp",
        hl: "ja",
        num: 5,
      }),
    }
  );

  if (!response.ok) {
    throw new Error(
      `Serper error: ${response.status}`
    );
  }

  const data = await response.json();

  const results = Array.isArray(data.organic)
    ? data.organic
    : [];

  return results
    .filter((result) => result?.link)
    .map((result) => ({
      title: result.title || result.link,
      url: result.link,
      content: result.snippet || "",
      source: "serper",
    }));
}

export async function searchManager(text) {
  const tavilyKey =
    process.env.TAVILY_API_KEY;

  const serperKey =
    process.env.SERPER_API_KEY;

  /*
   * 検索不要
   */
  if (!needsSearch(text)) {
    return {
      searched: false,
      provider: null,
      results: [],
      context: "",
    };
  }

  /*
   * 深い調査 → Tavily
   */
  const useTavily =
    needsDeepResearch(text);

  /*
   * Tavily
   */
  if (useTavily && tavilyKey) {
    try {
      const results =
        await searchTavily(
          text,
          tavilyKey
        );

      return {
        searched: true,
        provider: "tavily",
        results,
        context: results
          .map(
            (result) =>
              `[Tavily]
Title: ${result.title}
URL: ${result.url}
Content: ${result.content}`
          )
          .join("\n\n"),
      };
    } catch (error) {
      console.error(
        "Tavily search error:",
        error
      );
    }
  }

  /*
   * 通常検索 → Serper
   */
  if (serperKey) {
    try {
      const results =
        await searchSerper(
          text,
          serperKey
        );

      return {
        searched: true,
        provider: "serper",
        results,
        context: results
          .map(
            (result) =>
              `[Serper]
Title: ${result.title}
URL: ${result.url}
Content: ${result.content}`
          )
          .join("\n\n"),
      };
    } catch (error) {
      console.error(
        "Serper search error:",
        error
      );
    }
  }

  /*
   * 検索失敗
   */
  return {
    searched: false,
    provider: null,
    results: [],
    context: "",
  };
}
