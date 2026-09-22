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
        }),
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

    return res.status(200).json({
      text: outputText,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
}
