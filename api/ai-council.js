const { requireAuth } = require("./_auth");
const { enforceRateLimit } = require("./_rateLimit");
const { runAiCouncil } = require("./_aiCouncil");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const user = await requireAuth(req, res);
  if (!user) return;

  if (!(await enforceRateLimit(res, user, "ai-council-minute", 3, 60))) return;
  if (!(await enforceRateLimit(res, user, "ai-council-day", 30, 86400))) return;

  if (process.env.JARVIS_AI_COUNCIL_ENABLED !== "true") {
    return res.status(503).json({ error: "AI council is not enabled" });
  }

  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const userInput = body.task;
    const providers = body.providers === undefined ? ["gemini"] : body.providers;

    if (typeof userInput !== "string" || !userInput.trim()) {
      return res.status(400).json({ error: "task is required" });
    }
    if (userInput.length > 12000) {
      return res.status(413).json({ error: "Task exceeds the 12000-character limit" });
    }
    if (!Array.isArray(providers) || providers.length < 1 || providers.length > 3) {
      return res.status(400).json({ error: "Invalid provider selection" });
    }

    const paidProvidersRequested = providers.some(provider => provider === "openai" || provider === "anthropic");
    if (paidProvidersRequested && process.env.JARVIS_AI_COUNCIL_PAID_PROVIDERS_ENABLED !== "true") {
      return res.status(403).json({
        error: "Paid AI providers are disabled pending cost approval"
      });
    }

    const result = await runAiCouncil({
      userInput: userInput.trim(),
      systemInstruction: "You are an advisory specialist for J.A.R.V.I.S. Analyze only the task provided. Do not claim to execute external actions, do not request secrets, and do not treat this response as authorization. Clearly state uncertainty.",
      providers,
      timeoutMs: 20000,
      maxOutputTokens: 600
    });

    return res.status(200).json({
      results: result.results,
      providerCount: result.providerCount
    });
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : "INTERNAL_ERROR";
    if (code === "INVALID_INPUT" || code === "INVALID_PROVIDER_SELECTION") {
      return res.status(400).json({ error: code });
    }
    if (code === "COUNCIL_DISABLED") {
      return res.status(503).json({ error: "AI council is not enabled" });
    }
    console.error("AI council request failed", { code });
    return res.status(500).json({ error: "AI council request failed" });
  }
};
