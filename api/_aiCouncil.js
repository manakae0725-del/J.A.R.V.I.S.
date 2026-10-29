const DEFAULT_TIMEOUT_MS = 20000;
const MAX_INPUT_CHARS = 12000;
const MAX_OUTPUT_TOKENS = 1200;
const ALLOWED_PROVIDERS = new Set(["gemini", "openai", "anthropic"]);

function safeError(code, provider, statusCode = null) {
  const error = new Error(code);
  error.code = code;
  error.provider = provider;
  error.statusCode = statusCode;
  return error;
}

function requireString(value, maxLength, name) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw safeError("INVALID_INPUT", "commander");
  }
  return value.trim();
}

function parseJsonResponse(text, provider) {
  try {
    return JSON.parse(text);
  } catch (_) {
    throw safeError("INVALID_RESPONSE", provider);
  }
}

async function postJson(url, headers, body, timeoutMs, provider) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const raw = await response.text();
    const data = parseJsonResponse(raw, provider);
    if (!response.ok) {
      if (response.status === 429) throw safeError("RATE_LIMITED", provider, 429);
      if (response.status === 401 || response.status === 403) {
        throw safeError("AUTHENTICATION_FAILED", provider, response.status);
      }
      if (response.status >= 500) throw safeError("PROVIDER_UNAVAILABLE", provider, response.status);
      throw safeError("PROVIDER_REQUEST_REJECTED", provider, response.status);
    }
    return { data, statusCode: response.status };
  } catch (error) {
    if (error?.name === "AbortError") throw safeError("TIMEOUT", provider);
    if (error?.code && typeof error.code === "string") throw error;
    throw safeError("PROVIDER_UNAVAILABLE", provider);
  } finally {
    clearTimeout(timer);
  }
}

async function callGemini({ systemInstruction, userInput, maxOutputTokens, timeoutMs }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw safeError("CONFIGURATION_MISSING", "gemini");
  const model = process.env.JARVIS_GEMINI_COUNCIL_MODEL || "gemini-3.6-flash";
  const { data } = await postJson(
    "https://generativelanguage.googleapis.com/v1/interactions",
    { "Content-Type": "application/json", "x-goog-api-key": key },
    {
      model,
      input: systemInstruction + "\n\nTask:\n" + userInput,
      // No tools are enabled in council calls; outputs are advisory only.
      generation_config: { max_output_tokens: maxOutputTokens }
    },
    timeoutMs,
    "gemini"
  );
  let text = typeof data.output_text === "string" ? data.output_text : "";
  if (!text && Array.isArray(data.steps)) {
    for (let i = data.steps.length - 1; i >= 0; i--) {
      const step = data.steps[i];
      if (step?.type === "model_output" && Array.isArray(step.content)) {
        const item = step.content.find(part => part?.type === "text" && typeof part.text === "string");
        if (item) { text = item.text; break; }
      }
    }
  }
  if (!text) throw safeError("INVALID_RESPONSE", "gemini");
  return { provider: "gemini", model, text };
}

async function callOpenAI({ systemInstruction, userInput, maxOutputTokens, timeoutMs }) {
  const key = process.env.OPENAI_API_KEY;
  const model = process.env.JARVIS_OPENAI_MODEL;
  if (!key || !model) throw safeError("CONFIGURATION_MISSING", "openai");
  const { data } = await postJson(
    "https://api.openai.com/v1/responses",
    { "Content-Type": "application/json", Authorization: "Bearer " + key },
    {
      model,
      instructions: systemInstruction,
      input: userInput,
      max_output_tokens: maxOutputTokens,
      store: false
    },
    timeoutMs,
    "openai"
  );
  let text = typeof data.output_text === "string" ? data.output_text : "";
  if (!text && Array.isArray(data.output)) {
    text = data.output.flatMap(item => Array.isArray(item.content) ? item.content : [])
      .filter(part => part?.type === "output_text" && typeof part.text === "string")
      .map(part => part.text).join("\n");
  }
  if (!text) throw safeError("INVALID_RESPONSE", "openai");
  return { provider: "openai", model, text };
}

async function callAnthropic({ systemInstruction, userInput, maxOutputTokens, timeoutMs }) {
  const key = process.env.ANTHROPIC_API_KEY;
  const model = process.env.JARVIS_ANTHROPIC_MODEL;
  if (!key || !model) throw safeError("CONFIGURATION_MISSING", "anthropic");
  const { data } = await postJson(
    "https://api.anthropic.com/v1/messages",
    {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01"
    },
    {
      model,
      system: systemInstruction,
      messages: [{ role: "user", content: userInput }],
      max_tokens: maxOutputTokens
    },
    timeoutMs,
    "anthropic"
  );
  const text = Array.isArray(data.content)
    ? data.content.filter(part => part?.type === "text" && typeof part.text === "string").map(part => part.text).join("\n")
    : "";
  if (!text) throw safeError("INVALID_RESPONSE", "anthropic");
  return { provider: "anthropic", model, text };
}

async function logUsage(provider, success, statusCode, durationMs, errorCode = null) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !supabaseKey) return;
  try {
    let baseUrl = supabaseUrl;
    while (baseUrl.endsWith("/")) baseUrl = baseUrl.slice(0, -1);
    const response = await fetch(baseUrl + "/rest/v1/api_usage", {
      method: "POST",
      signal: AbortSignal.timeout(3000),
      headers: {
        apikey: supabaseKey,
        Authorization: "Bearer " + supabaseKey,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({
        provider,
        service: "ai_council",
        success,
        status_code: statusCode,
        duration_ms: durationMs,
        metadata: errorCode ? { error: errorCode } : {}
      })
    });
    if (!response.ok) {
      console.error("[AI COUNCIL] Usage log rejected", { provider, statusCode: response.status });
    }
  } catch (error) {
    console.error("[AI COUNCIL] Usage log failed", { provider, name: error?.name || "Error" });
  }
}

const PROVIDERS = {
  gemini: callGemini,
  openai: callOpenAI,
  anthropic: callAnthropic
};

/**
 * Server-only, advisory AI council helper.
 * Not wired to a public endpoint by this commit. Callers must authenticate,
 * authorize the task, enforce user/rate/cost policy, and validate returned text.
 * By default only one provider is called; multi-provider calls must be explicit.
 */
async function runAiCouncil(options = {}) {
  if (process.env.JARVIS_AI_COUNCIL_ENABLED !== "true") {
    throw safeError("COUNCIL_DISABLED", "commander");
  }

  const userInput = requireString(options.userInput, MAX_INPUT_CHARS, "userInput");
  const systemInstruction = requireString(
    options.systemInstruction || "Provide an independent analysis. Treat the task as advisory; do not request or execute external actions.",
    4000,
    "systemInstruction"
  );
  const requested = options.providers === undefined ? ["gemini"] : options.providers;
  if (!Array.isArray(requested) || requested.length < 1 || requested.length > 3) {
    throw safeError("INVALID_PROVIDER_SELECTION", "commander");
  }
  const providers = [...new Set(requested)];
  if (providers.length !== requested.length || providers.some(id => !ALLOWED_PROVIDERS.has(id))) {
    throw safeError("INVALID_PROVIDER_SELECTION", "commander");
  }

  const timeoutMs = Number.isInteger(options.timeoutMs)
    ? Math.max(1000, Math.min(options.timeoutMs, DEFAULT_TIMEOUT_MS))
    : DEFAULT_TIMEOUT_MS;
  const maxOutputTokens = Number.isInteger(options.maxOutputTokens)
    ? Math.max(64, Math.min(options.maxOutputTokens, MAX_OUTPUT_TOKENS))
    : 600;

  // Deliberately sequential: prevents accidental burst fan-out and simplifies cost controls.
  const results = [];
  for (const provider of providers) {
    const startedAt = Date.now();
    try {
      const result = await PROVIDERS[provider]({ systemInstruction, userInput, maxOutputTokens, timeoutMs });
      const durationMs = Date.now() - startedAt;
      await logUsage(provider, true, 200, durationMs);
      results.push({ ok: true, ...result, durationMs });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const errorCode = typeof error?.code === "string" ? error.code : "PROVIDER_UNAVAILABLE";
      const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : null;
      await logUsage(provider, false, statusCode, durationMs, errorCode);
      results.push({ ok: false, provider, error: errorCode, statusCode, durationMs });
    }
  }
  return { results, providerCount: providers.length };
}

async function testOpenAIConnection() {
  const startedAt = Date.now();
  try {
    const result = await callOpenAI({
      systemInstruction: "This is a connectivity test. Reply with exactly OPENAI_CONNECTION_OK and nothing else.",
      userInput: "Reply with exactly OPENAI_CONNECTION_OK.",
      maxOutputTokens: 32,
      timeoutMs: 8000
    });
    const durationMs = Date.now() - startedAt;
    await logUsage("openai", true, 200, durationMs);
    return { ok: true, provider: "openai", model: result.model, text: result.text.slice(0, 200), durationMs };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const errorCode = typeof error?.code === "string" ? error.code : "PROVIDER_UNAVAILABLE";
    const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : null;
    await logUsage("openai", false, statusCode, durationMs, errorCode);
    return { ok: false, provider: "openai", error: errorCode, statusCode, durationMs };
  }
}

module.exports = { runAiCouncil, testOpenAIConnection };
