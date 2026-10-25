// Temporary diagnostic endpoint; guarded to a token-protected Vercel Preview deployment only.
const geminiHandler = require("./gemini");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const configuredToken = process.env.JARVIS_USAGE_LOG_TEST_TOKEN;
  const suppliedToken =
    typeof req.query?.token === "string" ? req.query.token : "";

  if (
    process.env.VERCEL_ENV !== "preview" ||
    !configuredToken ||
    suppliedToken !== configuredToken
  ) {
    return res.status(404).json({ error: "Not Found" });
  }

  await geminiHandler.logApiUsage({
    provider: "test",
    service: "usage-log-failure-injection",
    success: false,
    statusCode: 503,
    durationMs: 0,
    metadata: { testOnly: true },
    testFailureMode: "http"
  });

  await geminiHandler.logApiUsage({
    provider: "test",
    service: "usage-log-failure-injection",
    success: false,
    statusCode: null,
    durationMs: 0,
    metadata: { testOnly: true },
    testFailureMode: "network"
  });

  return res.status(200).json({
    ok: true,
    tests: [
      "simulated_http_rejection",
      "simulated_network_exception"
    ],
    writesAttempted: false
  });
};
