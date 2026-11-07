const { requireAuth } = require("../_auth");
const { enforceRateLimit } = require("../_rateLimit");

function monthStartUtc() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await requireAuth(req, res);
  if (!user) return;
  if (!(await enforceRateLimit(res, user, "usage-summary-minute", 20, 60))) return;

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(503).json({ error: "Usage storage unavailable" });
  }

  try {
    const params = new URLSearchParams({
      select: "provider,service,success,input_tokens,output_tokens,total_tokens,character_count,estimated_cost_usd,cost_status,created_at",
      user_id: "eq." + user.id,
      created_at: "gte." + monthStartUtc(),
      order: "created_at.desc",
      limit: "5000"
    });
    const response = await fetch(
      supabaseUrl.replace(/\\/+$/, "") + "/rest/v1/api_usage?" + params,
      {
        headers: {
          apikey: serviceKey,
          Authorization: "Bearer " + serviceKey
        },
        signal: AbortSignal.timeout(8000)
      }
    );
    if (!response.ok) throw new Error("Usage query failed");
    const rows = await response.json();
    const byProvider = {};
    let successful = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    let characters = 0;
    let knownCostUsd = 0;
    let pricedRecords = 0;
    let unpricedRecords = 0;

    for (const row of rows) {
      const provider = typeof row.provider === "string" ? row.provider : "unknown";
      if (!byProvider[provider]) {
        byProvider[provider] = {
          requests: 0,
          successful: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          characters: 0,
          knownCostUsd: 0,
          unpricedRecords: 0
        };
      }
      const item = byProvider[provider];
      item.requests += 1;
      if (row.success === true) {
        successful += 1;
        item.successful += 1;
      }
      const input = Number.isFinite(row.input_tokens) ? row.input_tokens : 0;
      const output = Number.isFinite(row.output_tokens) ? row.output_tokens : 0;
      const total = Number.isFinite(row.total_tokens) ? row.total_tokens : input + output;
      const chars = Number.isFinite(row.character_count) ? row.character_count : 0;
      inputTokens += input;
      outputTokens += output;
      totalTokens += total;
      characters += chars;
      item.inputTokens += input;
      item.outputTokens += output;
      item.totalTokens += total;
      item.characters += chars;
      if (row.estimated_cost_usd !== null && Number.isFinite(Number(row.estimated_cost_usd))) {
        const cost = Number(row.estimated_cost_usd);
        knownCostUsd += cost;
        item.knownCostUsd += cost;
        pricedRecords += 1;
      } else if (row.cost_status !== "free") {
        unpricedRecords += 1;
        item.unpricedRecords += 1;
      }
    }

    return res.status(200).json({
      ok: true,
      period: {
        start: monthStartUtc(),
        timezone: "UTC"
      },
      totals: {
        requests: rows.length,
        successful,
        inputTokens,
        outputTokens,
        totalTokens,
        characters,
        knownCostUsd: Number(knownCostUsd.toFixed(8)),
        pricedRecords,
        unpricedRecords,
        costCompleteness: rows.length === 0 ? "no_data" : (unpricedRecords === 0 ? "complete" : "partial")
      },
      byProvider
    });
  } catch (error) {
    console.error("API usage summary failed", { name: error?.name || "Error" });
    return res.status(503).json({ error: "Usage summary unavailable" });
  }
};
