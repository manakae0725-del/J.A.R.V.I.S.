async function logApiUsage({
  provider,
  service,
  success,
  statusCode,
  durationMs,
  metadata = {}
}) {
  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey =
      process.env.SUPABASE_SECRET_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return;
    }

    const response = await fetch(
      `${supabaseUrl}/rest/v1/api_usage`,
      {
        method: "POST",
        headers: {
          apikey: supabaseKey,
          "Content-Type": "application/json",
          Prefer: "return=minimal"
        },
        body: JSON.stringify({
          provider,
          service,
          success,
          status_code: statusCode,
          duration_ms: durationMs,
          metadata
        })
      }
    );
    if (!response.ok) {
      console.error("[API USAGE] Log write rejected", {
        provider,
        service,
        statusCode: response.status
      });
    }
  } catch (error) {
    console.error("[API USAGE] Log request failed", {
      provider,
      service,
      name: error?.name || "Error"
    });

  }
}


const { requireAuth } = require("./_auth");
const { enforceRateLimit } = require("./_rateLimit");
const { runAiCouncil, testOpenAIConnection } = require("./_aiCouncil");
const { getAutoCommanderConfig } = require("../lib/commanderRouting");
const { listConnectionsForUser } = require("./_google/tokenStore");
const { googleApiRequest } = require("./_google/client");

const crypto = require("crypto");

const SPREADSHEET_REGISTRY_CATEGORY = "jarvis_spreadsheet_registry";

async function readSpreadsheetRegistry(userId) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !supabaseKey) return null;
  const params = new URLSearchParams({
    select: "content",
    user_id: "eq." + userId,
    category: "eq." + SPREADSHEET_REGISTRY_CATEGORY,
    is_active: "eq.true",
    order: "updated_at.desc",
    limit: "1"
  });
  const response = await fetch(supabaseUrl.replace(/\/+$/, "") + "/rest/v1/memories?" + params, {
    headers: { apikey: supabaseKey, Authorization: "Bearer " + supabaseKey }
  });
  if (!response.ok) throw new Error("Spreadsheet registry read failed");
  const rows = await response.json();
  if (!Array.isArray(rows) || !rows[0] || typeof rows[0].content !== "string") return null;
  try {
    const parsed = JSON.parse(rows[0].content);
    return parsed && parsed.version === 1 && parsed.spreadsheets && typeof parsed.spreadsheets === "object" ? parsed : null;
  } catch (_) { return null; }
}

async function saveSpreadsheetRegistry(userId, registry) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !supabaseKey) throw new Error("Spreadsheet registry storage unavailable");
  const response = await fetch(supabaseUrl.replace(/\/+$/, "") + "/rest/v1/rpc/save_memory_atomic", {
    method: "POST",
    headers: {
      apikey: supabaseKey,
      Authorization: "Bearer " + supabaseKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      p_user_id: userId,
      p_category: SPREADSHEET_REGISTRY_CATEGORY,
      p_content: JSON.stringify(registry),
      p_importance: 5
    })
  });
  if (!response.ok) throw new Error("Spreadsheet registry save failed");
}

function spreadsheetIdFromUrl(value) {
  if (typeof value !== "string") return null;
  const marker = "/spreadsheets/d/";
  const index = value.indexOf(marker);
  if (index < 0) return null;
  const id = value.slice(index + marker.length).split(/[/?#]/, 1)[0].split(" ")[0];
  return /^[a-zA-Z0-9_-]{10,200}$/.test(id) ? id : null;
}

function signCalendarAction(payload) {
  const body=Buffer.from(JSON.stringify({...payload,exp:Date.now()+600000}),"utf8").toString("base64url");
  const sig=crypto.createHmac("sha256",process.env.GEMINI_API_KEY||"").update(body).digest("base64url");
  return body+"."+sig;
}
function verifyCalendarAction(token,userId) {
  if(typeof token!=="string"||token.length>4096)return null;
  const [body,sig,...rest]=token.split("."); if(!body||!sig||rest.length)return null;
  const expected=crypto.createHmac("sha256",process.env.GEMINI_API_KEY||"").update(body).digest();
  let actual; try{actual=Buffer.from(sig,"base64url")}catch(_){return null}
  if(actual.length!==expected.length||!crypto.timingSafeEqual(actual,expected))return null;
  try{const p=JSON.parse(Buffer.from(body,"base64url").toString("utf8"));return p.userId===userId&&p.exp>Date.now()?p:null}catch(_){return null}
}
function calendarDate(text) {
  const m=text.match(/(20\d{2})[年/-](\d{1,2})[月/-](\d{1,2})日?/);
  if(m)return new Date(Date.UTC(+m[1],+m[2]-1,+m[3]));
  const now=new Date(Date.now()+9*3600000),d=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()));
  if(/明後日|あさって/.test(text))d.setUTCDate(d.getUTCDate()+2);
  else if(/明日|あした/.test(text))d.setUTCDate(d.getUTCDate()+1);
  else if(!/今日|本日/.test(text))return null;
  return d;
}
function calendarTime(text,date) {
  const range=text.match(/(\d{1,2})時(?:(\d{1,2})分)?(?:から|〜|～|-)\s*(\d{1,2})時(?:(\d{1,2})分)?/);
  const single=!range && text.match(/(\d{1,2})時(?:(\d{1,2})分)?/);
  if(!range&&!single)return null;
  const sh=+(range?range[1]:single[1]),sm=+((range?range[2]:single[2])||0);
  const eh=range?+range[3]:sh+1,em=range?+((range[4])||0):sm;
  if(sh>23||eh>24||sm>59||em>59)return null;
  const iso=(h,min)=>new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate(),h-9,min)).toISOString();
  let start=iso(sh,sm),end=iso(eh,em);if(Date.parse(end)<=Date.parse(start))end=new Date(Date.parse(end)+86400000).toISOString();
  return {start:{dateTime:start,timeZone:"Asia/Tokyo"},end:{dateTime:end,timeZone:"Asia/Tokyo"}};
}
function calendarQuotedTitle(text){return text.match(/[「『"“](.{1,200}?)[」』"”]/)?.[1]?.trim()||null}
function calendarDirect(res,text,speechText,extra={}){return res.status(200).json({text,speechText,visualization:{type:"none",title:"",labels:[],values:[],steps:[]},interactionId:null,memory:{shouldSave:false,category:"personal",content:"",importance:1},sources:[],...extra})}

async function classifyCalendarIntent(apiKey, reply, pendingAction) {
  const action = pendingAction?.action || "unknown";
  const input = [
    "Classify the user's reply to a pending Google Calendar operation.",
    "Return exactly one category: approve, reject, modify, defer, question, unclear.",
    "approve: clearly authorizes the currently displayed operation.",
    "reject: refuses or cancels the operation.",
    "modify: requests changing any detail; never treat this as approval.",
    "defer: asks to wait or postpone.",
    "question: asks a question or seeks clarification.",
    "unclear: ambiguous, unrelated, or insufficient intent.",
    "Only classify intent. Do not execute anything. If not clearly approval, never return approve.",
    "Pending operation type: " + action,
    "User reply: " + String(reply || "").slice(0, 2000)
  ].join("\n");
  try {
    const response = await fetch("https://generativelanguage.googleapis.com/v1/interactions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        model: "gemini-3.6-flash",
        input,
        response_format: {
          type: "text",
          mime_type: "application/json",
          schema: {
            type: "object",
            properties: { category: { type: "string", enum: ["approve", "reject", "modify", "defer", "question", "unclear"] } },
            required: ["category"]
          }
        }
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) return "unclear";
    const data = await response.json();
    let output = data.output_text;
    if (!output && Array.isArray(data.steps)) {
      for (let i = data.steps.length - 1; i >= 0; i--) {
        const step = data.steps[i];
        if (step?.type === "model_output" && Array.isArray(step.content)) {
          const item = step.content.find(x => x?.type === "text" && x?.text);
          if (item) { output = item.text; break; }
        }
      }
    }
    const parsed = JSON.parse(output || "{}");
    return ["approve", "reject", "modify", "defer", "question", "unclear"].includes(parsed.category)
      ? parsed.category : "unclear";
  } catch (_) {
    return "unclear";
  }
}



module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method Not Allowed",
    });
  }

  const user = await requireAuth(req, res);
  if (!user) return;

  // Explicit OpenAI connectivity probe: fixed prompt, one provider call, strict rate limits.
  // Independent of council/automatic-routing flags; does not alter ordinary chat routing.
  if (req.body && req.body.mode === "openai-connection-test") {
    if (!(await enforceRateLimit(res, user, "openai-connection-test-minute", 1, 60))) return;
    if (!(await enforceRateLimit(res, user, "openai-connection-test-day", 3, 86400))) return;
    const result = await testOpenAIConnection();
    return res.status(result.ok ? 200 : 502).json(result);
  }

  // Explicit, bounded Preview-only routing probe. Uses separate buckets from normal and legacy tests.
  // This does not enable automatic routing and cannot run in Production.
  if (req.body && req.body.mode === "commander-routing-test") {
    if (process.env.VERCEL_ENV !== "preview") {
      return res.status(403).json({ ok: false, error: "PREVIEW_ONLY_TEST" });
    }
    if (!(await enforceRateLimit(res, user, "commander-routing-preview-minute", 1, 60))) return;
    if (!(await enforceRateLimit(res, user, "commander-routing-preview-day", 3, 86400))) return;
    const probeTask = "司令官ルーティングの動作確認です。J.A.R.V.I.S.のシステムとAPI接続経路を分析し、選択された専門AIが正常に応答できることだけを確認してください。外部操作や設定変更は行わず、短く回答してください。";
    const probeEnv = {
      ...process.env,
      JARVIS_AUTO_COMMANDER_ENABLED: "true",
      JARVIS_AI_COUNCIL_ENABLED: "true",
      JARVIS_AI_COUNCIL_PAID_PROVIDERS_ENABLED: "true"
    };
    const route = getAutoCommanderConfig({ autoCommander: true, text: probeTask, env: probeEnv });
    if (!route.eligible || !route.provider) {
      return res.status(503).json({ ok: false, error: "ROUTING_CONFIGURATION_MISSING" });
    }
    const result = await testOpenAIConnection({
      userInput: route.taskText,
      systemInstruction: "You are J.A.R.V.I.S.'s advisory specialist. This is a routing test. Do not execute or claim external actions. Reply with exactly OPENAI_ROUTE_OK and nothing else. This is a routing connectivity test.",
      maxOutputTokens: 384
    });
    if (!result.ok) {
      return res.status(502).json({ ok: false, provider: route.provider, error: result.error, statusCode: result.statusCode, responseStatus: result.responseStatus, incompleteReason: result.incompleteReason });
    }
    return res.status(200).json({
      ok: true,
      route: "commander -> " + result.provider,
      provider: result.provider,
      model: result.model,
      text: result.text.slice(0, 600),
      durationMs: result.durationMs
    });
  }

  // One-shot end-to-end Commander test: classify supplied text and call OpenAI only when eligible.
  // Preview-only; does not change global routing flags or affect ordinary chat.
  if (req.body && req.body.mode === "commander-live-test") {
    if (process.env.VERCEL_ENV !== "preview") {
      return res.status(403).json({ ok: false, error: "PREVIEW_ONLY_TEST" });
    }
    if (!(await enforceRateLimit(res, user, "commander-live-preview-minute", 1, 60))) return;
    if (!(await enforceRateLimit(res, user, "commander-live-preview-day", 3, 86400))) return;
    const input = req.body.text;
    if (typeof input !== "string" || !input.trim() || input.length > 4000) {
      return res.status(400).json({ ok: false, error: "INVALID_CLASSIFICATION_INPUT" });
    }
    const route = getAutoCommanderConfig({
      autoCommander: true,
      text: input,
      env: {
        ...process.env,
        JARVIS_AUTO_COMMANDER_ENABLED: "true",
        JARVIS_AI_COUNCIL_ENABLED: "true",
        JARVIS_AI_COUNCIL_PAID_PROVIDERS_ENABLED: "true"
      }
    });
    if (!route.classification.shouldDelegate) {
      return res.status(200).json({
        ok: true,
        delegated: false,
        classification: route.classification,
        providerCall: false,
        message: "通常処理判定のため、AI APIは呼び出していません。"
      });
    }
    if (route.provider !== "openai") {
      return res.status(503).json({
        ok: false,
        error: "OPENAI_NOT_CONFIGURED",
        classification: route.classification,
        providerCall: false
      });
    }
    const result = await testOpenAIConnection({
      userInput: route.taskText,
      systemInstruction: "You are J.A.R.V.I.S.'s advisory specialist. Analyze the user's request and provide a concise useful response. Do not execute or claim external actions. State uncertainty where relevant.",
      maxOutputTokens: 600
    });
    if (!result.ok) {
      return res.status(502).json({
        ok: false,
        delegated: true,
        provider: "openai",
        classification: route.classification,
        error: result.error,
        statusCode: result.statusCode,
        responseStatus: result.responseStatus,
        incompleteReason: result.incompleteReason
      });
    }
    return res.status(200).json({
      ok: true,
      delegated: true,
      route: "commander -> openai",
      provider: result.provider,
      model: result.model,
      classification: route.classification,
      text: result.text.slice(0, 3000),
      durationMs: result.durationMs,
      providerCall: true
    });
  }

  // Classification-only probe: never calls an AI provider and never changes routing flags.
  if (req.body && req.body.mode === "commander-classification-test") {
    if (!(await enforceRateLimit(res, user, "commander-classification-minute", 12, 60))) return;
    if (!(await enforceRateLimit(res, user, "commander-classification-day", 30, 86400))) return;
    const input = req.body.text;
    if (typeof input !== "string" || !input.trim() || input.length > 4000) {
      return res.status(400).json({ ok: false, error: "INVALID_CLASSIFICATION_INPUT" });
    }
    const classification = getAutoCommanderConfig({
      autoCommander: true,
      text: input,
      env: {
        ...process.env,
        JARVIS_AUTO_COMMANDER_ENABLED: "true",
        JARVIS_AI_COUNCIL_ENABLED: "true",
        JARVIS_AI_COUNCIL_PAID_PROVIDERS_ENABLED: "true"
      }
    }).classification;
    return res.status(200).json({
      ok: true,
      intent: classification.intent,
      complexity: classification.complexity,
      shouldDelegate: classification.shouldDelegate,
      reason: classification.reason,
      providerCall: false
    });
  }
  // Optional AI council mode reuses this existing function to stay within the Vercel Hobby function limit.
  if (req.body && req.body.mode === "ai-council") {
    if (!(await enforceRateLimit(res, user, "ai-council-minute", 3, 60))) return;
    if (!(await enforceRateLimit(res, user, "ai-council-day", 30, 86400))) return;
    if (process.env.JARVIS_AI_COUNCIL_ENABLED !== "true") {
      return res.status(503).json({ error: "AI council is not enabled" });
    }
    const task = req.body.task;
    const providers = req.body.providers === undefined ? ["gemini"] : req.body.providers;
    if (typeof task !== "string" || !task.trim()) {
      return res.status(400).json({ error: "task is required" });
    }
    if (task.length > 12000) {
      return res.status(413).json({ error: "Task exceeds the 12000-character limit" });
    }
    if (!Array.isArray(providers) || providers.length < 1 || providers.length > 3) {
      return res.status(400).json({ error: "Invalid provider selection" });
    }
    const paidProvidersRequested = providers.some(provider => provider === "openai" || provider === "anthropic");
    if (paidProvidersRequested && process.env.JARVIS_AI_COUNCIL_PAID_PROVIDERS_ENABLED !== "true") {
      return res.status(403).json({ error: "Paid AI providers are disabled pending cost approval" });
    }
    try {
      const result = await runAiCouncil({
        userInput: task.trim(),
        systemInstruction: "You are an advisory specialist for J.A.R.V.I.S. Analyze only the task provided. Do not claim to execute external actions, do not request secrets, and do not treat this response as authorization. Clearly state uncertainty.",
        providers,
        timeoutMs: 20000,
        maxOutputTokens: 600
      });
      return res.status(200).json({ results: result.results, providerCount: result.providerCount });
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
  }

  if (!(await enforceRateLimit(res, user, "gemini-minute", 10, 60))) return;
  if (!(await enforceRateLimit(res, user, "gemini-day", 200, 86400))) return;

  try {
 const {
  text,
  previousInteractionId,
  memoryContext
} = req.body;

    if (!text) {
      return res.status(400).json({
        error: "text is required",
      });
    }

    if (typeof text !== "string" || text.length > 12000) {
      return res.status(413).json({ error: "Text exceeds the 12000-character limit" });
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

    const rawText = String(text || "").trim();

    const userMarker = rawText.match(
      /(?:ユーザー|今回のユーザーの発言)\s*[:：]\s*([\s\S]*?)(?=\n\s*={10,}|$)/
    );

    const userText = userMarker?.[1]
      ? userMarker[1].trim()
      : rawText;


    // Spreadsheet registry is user-scoped and stored in Supabase memories, never in source code.
    const registrationUrls = [...userText.matchAll(/https?:\/\/docs\.google\.com\/spreadsheets\/d\/[a-zA-Z0-9_-]+[^\s<>"']*/g)];
    const spreadsheetRegistrationIntent =
      userText.includes("docs.google.com/spreadsheets/d/") &&
      (
        (/(?:登録|覚えて|記憶して|設定して)/.test(userText) &&
          /(?:売上管理|店販管理)/.test(userText)) ||
        registrationUrls.length === 2
      );
    if (spreadsheetRegistrationIntent) {
      try {
        // Prefer URLs explicitly placed on the same line as their labels.
        // If the user supplied exactly two URLs separately, map them in the requested order
        // (sales first, retail second) when both labels are present in the registration request.
        const lines = userText.split(/\r?\n/);
        const extractUrl = line => line?.match(/https?:\/\/[^\s<>"']+/)?.[0]?.replace(/[),.;]+$/, "");
        let salesUrl = extractUrl(lines.find(line => line.includes("売上管理")));
        let retailUrl = extractUrl(lines.find(line => line.includes("店販管理")));
        const allUrls = [...userText.matchAll(/https?:\/\/[^\s<>"']+/g)]
          .map(match => match[0].replace(/[),.;]+$/, ""));
        if ((!salesUrl || !retailUrl) && allUrls.length === 2) {
          // In a two-link registration message, URL order is sales first, retail second.
          salesUrl = salesUrl || allUrls[0];
          retailUrl = retailUrl || allUrls[1];
        }
        const salesId = spreadsheetIdFromUrl(salesUrl);
        const retailId = spreadsheetIdFromUrl(retailUrl);
        if (!salesId || !retailId) {
          return calendarDirect(res, "売上管理と店販管理のURLをそれぞれの名称の後ろに付けて送ってください。まだ登録は行っていません。", "登録する2つのURLを確認してください。");
        }
        const registry = {
          version: 1,
          spreadsheets: {
            sales: { name: "売上管理", id: salesId },
            retail: { name: "店販管理", id: retailId }
          }
        };
        await saveSpreadsheetRegistry(user.id, registry);
        return calendarDirect(res, "スプレッドシートを登録しました。\n売上管理: ID登録済み\n店販管理: ID登録済み\n今後はファイル名検索に頼らず、登録したIDで対象を識別します。", "売上管理と店販管理のIDを記憶しました。");
      } catch (error) {
        console.error("Spreadsheet registry save failed", { name: error?.name || "Error" });
        return calendarDirect(res, "スプレッドシートIDを保存できませんでした。Supabaseの記憶機能の状態を確認してください。", "スプレッドシートIDを保存できませんでした。");
      }
    }

    // Canonical field-name schema for the future J.A.R.V.I.S. management workbook.
    // Source rows remain raw; summaries are calculated from these records.
    const managementWorkbookSchema = [
      { title: "Sales", headers: ["sales_id","transaction_date","customer_type","menu_id","menu_name","technical_sales","nomination_fee","retail_sales","service_minutes","staff_id","notes","record_status","created_at","updated_at"] },
      { title: "RetailSales", headers: ["retail_sale_id","sale_date","customer_id","product_id","quantity","unit_sale_price","unit_cost","gross_profit","staff_id","notes","record_status","created_at","updated_at"] },
      { title: "Products", headers: ["product_id","product_name","category","unit_cost","default_sale_price","active_from","active_to","is_active","created_at","updated_at"] },
      { title: "Menus", headers: ["menu_id","menu_name","category","default_price","standard_minutes","active_from","active_to","is_active","created_at","updated_at"] },
      { title: "Staff", headers: ["staff_id","display_name","employment_type","active_from","active_to","is_active","created_at","updated_at","auth_user_id"] },
      { title: "CompensationRules", headers: ["rule_id","staff_id","employment_type","effective_from","effective_to","base_salary","nomination_fee_per_visit","commission_rate","commission_basis","fixed_allowances_json","deduction_rules_json","payment_cycle","is_active","created_at","updated_at"] },
      { title: "Settings", headers: ["setting_key","setting_value","description","updated_at"] },
      { title: "ChangeLog", headers: ["change_id","changed_at","changed_by","target_sheet","target_record_id","field_name","old_value","new_value","reason"] }
    ];
    // Explicit read-only lookup of a named product in the management workbook.
    const productMasterVerificationIntent =
      /(?:Products|商品マスター).{0,30}(?:タブ|シート|一覧|商品)/i.test(userText) &&
      /(?:読み取り専用|読み取って|照会|確認|調べて|表示)/.test(userText) &&
      !/(?:追加して|登録して|変更して|更新して|削除して|書き込んで|追加する|登録する|変更する|更新する|削除する|書き込む)/.test(userText);
    if (productMasterVerificationIntent) {
      try {
        const connections = await listConnectionsForUser(user.id);
        const connection = Array.isArray(connections) ? connections.find(item => item?.status === "connected") : null;
        if (!connection?.id) return calendarDirect(res, "Googleが未接続です。", "Googleが未接続です。");
        const registry = await readSpreadsheetRegistry(user.id);
        const workbook = registry?.managementWorkbook;
        if (!workbook?.id) return calendarDirect(res, "J.A.R.V.I.S.管理ブックが未登録です。", "管理ブックが見つかりません。");
        const productResult = await googleApiRequest(
          user.id, connection.id,
          "https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(workbook.id) +
          "/values/" + encodeURIComponent("'Products'!A1:J1000")
        );
        const rows = Array.isArray(productResult?.values) ? productResult.values : [];
        const headers = (rows[0] || []).map(value => String(value || "").trim());
        const index = Object.fromEntries(headers.map((name, i) => [name, i]));
        const required = ["product_id","product_name","unit_cost","default_sale_price","is_active"];
        if (required.some(name => index[name] === undefined)) {
          return calendarDirect(res, "Productsタブの必要な列が不足しています。読み取りのみ実施し、変更は行っていません。", "Productsタブの構造を確認してください。");
        }
        const quotedNames = [...userText.matchAll(/[「『“"]([^」』”"]{1,200})[」』”"]/g)].map(match => match[1].trim());
        const requestedName =
          (userText.includes("テスト商品A") ? "テスト商品A" : "") ||
          quotedNames.find(name =>
            !/^(?:Products|商品マスター|店販管理|管理データ)$/.test(name) &&
            !/J\.?A\.?R\.?V\.?I\.?S\.?.*(?:管理データ|管理ブック)|(?:管理データ|管理ブック)/i.test(name)
          ) || "";
        const matches = rows.slice(1).filter(row => {
          const name = String(row?.[index.product_name] ?? "").trim();
          return name && (requestedName ? name === requestedName : /テスト商品A/.test(userText) && name === "テスト商品A");
        });
        const lines = matches.map(row => [
          "商品名: " + String(row[index.product_name] ?? ""),
          "商品ID: " + String(row[index.product_id] ?? ""),
          "仕入原価: " + String(row[index.unit_cost] ?? ""),
          "販売価格: " + String(row[index.default_sale_price] ?? ""),
          "有効状態: " + (String(row[index.is_active] ?? "").toLowerCase() === "false" ? "無効" : "有効")
        ].join("\n"));
        const responseText = matches.length
          ? "ProductsタブをGoogle Sheetsから読み取りました。該当商品は" + matches.length + "件です。\n\n" + lines.join("\n\n") + "\n\n読み取り専用で実行し、データの追加・変更・削除は行っていません。"
          : "ProductsタブをGoogle Sheetsから読み取りましたが、指定商品「" + (requestedName || "テスト商品A") + "」は見つかりませんでした。読み取り専用で実行し、データの追加・変更・削除は行っていません。";
        return calendarDirect(res, responseText, "Productsタブの読み取り照合が完了しました。", {
          productMasterVerification: {
            requestedName: requestedName || "テスト商品A",
            matchCount: matches.length,
            products: matches.map(row => ({
              productId: String(row[index.product_id] ?? ""),
              productName: String(row[index.product_name] ?? ""),
              unitCost: String(row[index.unit_cost] ?? ""),
              salePrice: String(row[index.default_sale_price] ?? ""),
              isActive: String(row[index.is_active] ?? "").toLowerCase() !== "false"
            }))
          }
        });
      } catch (error) {
        console.error("Product master verification failed", { name: error?.name || "Error", status: Number.isInteger(error?.status) ? error.status : undefined });
        return calendarDirect(res, "Productsタブの読み取りに失敗しました。データ変更は行っていません。", "商品マスターを確認できませんでした。");
      }
    }

    // Read-only verification of the currently authenticated user's staff mapping.
    const staffVerificationIntent = /(?:自分|本人|ログインユーザー).{0,20}(?:スタッフ情報|スタッフ登録|スタッフID).{0,12}(?:確認|照合|表示)|(?:スタッフ情報|スタッフ登録|スタッフID).{0,12}(?:確認|照合|表示)/.test(userText) &&
      !/(?:登録して|登録する|追加して|変更して|更新して|削除して)/.test(userText);
    if (staffVerificationIntent) {
      try {
        const connections = await listConnectionsForUser(user.id);
        const connection = Array.isArray(connections) ? connections.find(item => item?.status === "connected") : null;
        if (!connection?.id) return calendarDirect(res, "Googleが未接続です。", "Googleが未接続です。");
        const registry = await readSpreadsheetRegistry(user.id);
        const workbook = registry?.managementWorkbook;
        if (!workbook?.id) return calendarDirect(res, "J.A.R.V.I.S.管理ブックが未登録です。", "管理ブックが見つかりません。");
        const staffResult = await googleApiRequest(
          user.id, connection.id,
          "https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(workbook.id) + "/values/" + encodeURIComponent("'Staff'!A1:Z1000")
        );
        const rows = Array.isArray(staffResult?.values) ? staffResult.values : [];
        const headers = (rows[0] || []).map(value => String(value || "").trim());
        const index = Object.fromEntries(headers.map((name, i) => [name, i]));
        const required = ["staff_id","display_name","employment_type","is_active","auth_user_id"];
        if (required.some(name => index[name] === undefined)) {
          return calendarDirect(res, "Staffタブの必要な列が不足しています。読み取りのみ実施し、変更は行っていません。", "Staffタブの構造を確認してください。");
        }
        const matches = rows.slice(1).filter(row => String(row?.[index.auth_user_id] ?? "").trim() === user.id);
        if (matches.length !== 1) {
          return calendarDirect(res,
            matches.length === 0 ? "Staffタブに現在のログインユーザーの登録行が見つかりませんでした。読み取りのみ実施しました。"
              : "現在のログインユーザーに紐付くStaff行が複数あります。重複状態です。読み取りのみ実施しました。",
            "スタッフ情報の照合結果を確認してください。"
          );
        }
        const row = matches[0];
        const result = {
          staffId: String(row[index.staff_id] ?? ""),
          displayName: String(row[index.display_name] ?? ""),
          employmentType: String(row[index.employment_type] ?? ""),
          isActive: String(row[index.is_active] ?? "").toLowerCase() !== "false"
        };
        return calendarDirect(res,
          "Staffタブの実データを読み取り専用で確認しました。\n表示名: " + result.displayName +
          "\n雇用形態: " + result.employmentType + "\nスタッフID: " + result.staffId +
          "\n有効状態: " + (result.isActive ? "有効" : "無効") +
          "\nログインユーザーとの紐付け: 一致。シートへの変更は行っていません。",
          "スタッフ情報の読み取り照合が完了しました。",
          { staffVerification: result }
        );
      } catch (error) {
        console.error("Staff verification failed", { name: error?.name || "Error", status: Number.isInteger(error?.status) ? error.status : undefined });
        return calendarDirect(res, "Staffタブの読み取り照合に失敗しました。データ変更は行っていません。", "スタッフ情報を確認できませんでした。");
      }
    }

    // Register only the currently authenticated user as a staff member; never accept a client-supplied auth ID.
    const staffRegistrationIntent = /(?:自分を|本人を)?スタッフ登録|スタッフ情報を登録/.test(userText);
    if (staffRegistrationIntent) {
      try {
        const nameMatch = userText.match(/(?:表示名|スタッフ名|名前)\s*(?:は|を|[:：])?\s*([^\n、,。]+)/);
        const employmentMatch = userText.match(/(正社員|業務委託|パート|アルバイト)/);
        const displayName = String(nameMatch?.[1] || "").trim().replace(/(?:で)?スタッフ登録.*$/,"").trim();
        const employmentType = employmentMatch?.[1] || "";
        if (!displayName || displayName.length > 80 || !employmentType) {
          return calendarDirect(res,
            "スタッフ登録には表示名と雇用形態が必要です。例：「表示名は真人、雇用形態は正社員でスタッフ登録して」。",
            "表示名と雇用形態を指定してください。"
          );
        }
        const connections = await listConnectionsForUser(user.id);
        const connection = Array.isArray(connections) ? connections.find(item => item?.status === "connected") : null;
        if (!connection?.id) return calendarDirect(res, "Googleが未接続です。", "Googleが未接続です。");
        const registry = await readSpreadsheetRegistry(user.id);
        const workbook = registry?.managementWorkbook;
        if (!workbook?.id) return calendarDirect(res, "J.A.R.V.I.S.管理ブックが未登録です。", "管理ブックが見つかりません。");
        const staffResult = await googleApiRequest(
          user.id, connection.id,
          "https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(workbook.id) + "/values/" + encodeURIComponent("'Staff'!A1:Z1000")
        );
        const staffRows = Array.isArray(staffResult?.values) ? staffResult.values : [];
        const staffHeaders = (staffRows[0] || []).map(value => String(value || "").trim());
        const staffIndex = Object.fromEntries(staffHeaders.map((name, index) => [name, index]));
        const required = ["staff_id","display_name","employment_type","active_from","is_active","created_at","updated_at","auth_user_id"];
        if (required.some(name => staffIndex[name] === undefined)) {
          return calendarDirect(res, "Staffタブにauth_user_id列がありません。先に「管理データをスキーマv4に更新して」と依頼してください。スタッフ情報はまだ登録していません。", "先に管理データの構造更新が必要です。");
        }
        const existingLinks = staffRows.slice(1).filter(row =>
          String(row?.[staffIndex.auth_user_id] ?? "").trim() === user.id
        );
        if (existingLinks.length > 1) {
          return calendarDirect(res, "このログインユーザーに複数のスタッフ行が紐付いています。Staffタブを確認してください。", "スタッフ情報が重複しています。");
        }
        if (existingLinks.length === 1) {
          return calendarDirect(res,
            "このログインユーザーは既にスタッフ登録されています。スタッフID: " + String(existingLinks[0][staffIndex.staff_id] || "未設定") + "。重複登録は行っていません。",
            "スタッフ登録済みです。"
          );
        }
        const now = new Date();
        const activeFrom = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
        const timestamp = now.toISOString();
        const staffRecord = {
          staff_id: crypto.randomUUID(),
          display_name: displayName,
          employment_type: employmentType,
          active_from: activeFrom,
          active_to: "",
          is_active: true,
          created_at: timestamp,
          updated_at: timestamp,
          auth_user_id: user.id
        };
        const staffRow = staffHeaders.map(header => Object.prototype.hasOwnProperty.call(staffRecord, header) ? staffRecord[header] : "");
        const appendUrl = "https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(workbook.id) +
          "/values/" + encodeURIComponent("'Staff'!A:Z") + ":append?" +
          new URLSearchParams({ valueInputOption: "RAW", insertDataOption: "INSERT_ROWS" });
        const appended = await googleApiRequest(user.id, connection.id, appendUrl, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ majorDimension: "ROWS", values: [staffRow] })
        });
        if (!(Number(appended?.updates?.updatedRows) >= 1)) {
          return calendarDirect(res, "スタッフ情報の登録結果を確認できませんでした。重複登録を避けるため再試行していません。Staffタブを確認してください。", "登録結果を確認できませんでした。");
        }
        return calendarDirect(res,
          displayName + "さんをスタッフ登録しました。雇用形態: " + employmentType + "。スタッフIDは自動発行し、ログインユーザーと紐付けました。",
          "スタッフ登録が完了しました。",
          { staff: { registered: true, staffId: staffRecord.staff_id, employmentType } }
        );
      } catch (error) {
        console.error("Staff registration failed", { name: error?.name || "Error", status: Number.isInteger(error?.status) ? error.status : undefined });
        return calendarDirect(res, "スタッフ登録に失敗しました。Staffタブを確認してから再依頼してください。", "スタッフ登録に失敗しました。");
      }
    }
    // Explicit per-customer technical sales registration. Retail details remain in RetailSales.
    const technicalSaleRegisterIntent =
      /(?:技術売上|指名料|フリー売上|指名売上).{0,40}(?:登録|記録|追加)|(?:売上を|売上).{0,20}(?:登録して|記録して|追加して)/.test(userText) &&
      !/(?:店販|商品).{0,20}(?:販売|売れた)/.test(userText);
    if (technicalSaleRegisterIntent) {
      try {
        const customerTypeMatch = userText.match(/(指名|フリー)/);
        const technicalMatch = userText.match(/(?:技術売上|技術料|施術売上)\\s*(?:は|が|[:：])?\\s*([0-9][0-9,]*)\\s*円/);
        const nominationMatch = userText.match(/指名料\\s*(?:は|が|[:：])?\\s*([0-9][0-9,]*)\\s*円/);
        const technicalSales = technicalMatch ? Number(technicalMatch[1].replace(/,/g, "")) : NaN;
        const nominationFee = nominationMatch ? Number(nominationMatch[1].replace(/,/g, "")) : 0;
        if (!customerTypeMatch || !Number.isSafeInteger(technicalSales) || technicalSales < 0 ||
            !Number.isSafeInteger(nominationFee) || nominationFee < 0) {
          return calendarDirect(res,
            "売上登録には「指名／フリー」と「技術売上○円」が必要です。指名料は省略時0円です。例：「今日の指名、技術売上8800円、指名料800円を売上登録して」。",
            "顧客区分と技術売上を指定してください。"
          );
        }
        const dateMatch = userText.match(/(20\\d{2})[年/-](\\d{1,2})[月/-](\\d{1,2})日?/);
        const saleDate = dateMatch
          ? [dateMatch[1], String(Number(dateMatch[2])).padStart(2, "0"), String(Number(dateMatch[3])).padStart(2, "0")].join("-")
          : new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
        const parsedDate = new Date(saleDate + "T00:00:00+09:00");
        if (!Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== saleDate) {
          return calendarDirect(res, "売上日の日付形式が正しくありません。登録は行っていません。", "売上日を確認してください。");
        }
        const connections = await listConnectionsForUser(user.id);
        const connection = Array.isArray(connections) ? connections.find(item => item?.status === "connected") : null;
        if (!connection?.id) return calendarDirect(res, "Googleが未接続です。", "Googleが未接続です。");
        const registry = await readSpreadsheetRegistry(user.id);
        const workbook = registry?.managementWorkbook;
        if (!workbook?.id) return calendarDirect(res, "J.A.R.V.I.S.管理ブックが未登録です。", "管理ブックが未登録です。");
        const base = "https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(workbook.id);
        const [salesResult, staffResult] = await Promise.all([
          googleApiRequest(user.id, connection.id, base + "/values/" + encodeURIComponent("'Sales'!A1:N1")),
          googleApiRequest(user.id, connection.id, base + "/values/" + encodeURIComponent("'Staff'!A1:Z1000"))
        ]);
        const salesHeaders = (salesResult?.values?.[0] || []).map(value => String(value || "").trim());
        const staffRows = Array.isArray(staffResult?.values) ? staffResult.values : [];
        const staffHeaders = (staffRows[0] || []).map(value => String(value || "").trim());
        const salesIndex = Object.fromEntries(salesHeaders.map((name, index) => [name, index]));
        const staffIndex = Object.fromEntries(staffHeaders.map((name, index) => [name, index]));
        const requiredSales = ["sales_id","transaction_date","customer_type","technical_sales","nomination_fee","retail_sales","staff_id","notes","record_status","created_at","updated_at"];
        const requiredStaff = ["staff_id","is_active","auth_user_id"];
        if (requiredSales.some(name => salesIndex[name] === undefined) || requiredStaff.some(name => staffIndex[name] === undefined)) {
          return calendarDirect(res, "SalesまたはStaffのヘッダーが必要な構成と一致しません。書き込みは行っていません。", "シート構造が一致しないため登録を中止しました。");
        }
        const linkedStaff = staffRows.slice(1).filter(row =>
          String(row?.[staffIndex.auth_user_id] ?? "").trim() === user.id &&
          String(row?.[staffIndex.is_active] ?? "").toLowerCase() !== "false" &&
          String(row?.[staffIndex.staff_id] ?? "").trim()
        );
        if (linkedStaff.length !== 1) {
          return calendarDirect(res,
            linkedStaff.length === 0 ? "ログインユーザーに紐付く有効なスタッフ情報がありません。売上登録は行っていません。"
              : "ログインユーザーに複数の有効スタッフ情報が紐付いています。Staffタブを確認してください。売上登録は行っていません。",
            "スタッフ情報を確認してください。"
          );
        }
        const now = new Date();
        const timestamp = now.toISOString();
        const record = {
          sales_id: crypto.randomUUID(),
          transaction_date: saleDate,
          customer_type: customerTypeMatch[1] === "指名" ? "nomination" : "free",
          menu_id: "",
          menu_name: "",
          technical_sales: technicalSales,
          nomination_fee: nominationFee,
          // Product-level retail entries are recorded separately in RetailSales to avoid double counting.
          retail_sales: 0,
          service_minutes: "",
          staff_id: String(linkedStaff[0][staffIndex.staff_id]).trim(),
          notes: "",
          record_status: "active",
          created_at: timestamp,
          updated_at: timestamp
        };
        const row = salesHeaders.map(header => Object.prototype.hasOwnProperty.call(record, header) ? record[header] : "");
        const appendUrl = base + "/values/" + encodeURIComponent("'Sales'!A:N") +
          ":append?" + new URLSearchParams({ valueInputOption: "RAW", insertDataOption: "INSERT_ROWS" });
        const appended = await googleApiRequest(user.id, connection.id, appendUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ majorDimension: "ROWS", values: [row] })
        });
        if (!(Number(appended?.updates?.updatedRows) >= 1)) {
          return calendarDirect(res, "Salesへの追記応答を確認できませんでした。重複登録を避けるため再試行していません。Salesタブを確認してください。", "登録結果を確認できませんでした。");
        }
        let verified = false;
        try {
          const readBack = await googleApiRequest(user.id, connection.id, base + "/values/" + encodeURIComponent("'Sales'!A1:N10000"));
          const savedRows = Array.isArray(readBack?.values) ? readBack.values : [];
          const savedHeaders = (savedRows[0] || []).map(value => String(value || "").trim());
          const savedIndex = Object.fromEntries(savedHeaders.map((name, index) => [name, index]));
          const saved = savedRows.slice(1).find(item => String(item?.[savedIndex.sales_id] ?? "").trim() === record.sales_id);
          verified = Boolean(saved &&
            String(saved[savedIndex.staff_id] ?? "").trim() === record.staff_id &&
            String(saved[savedIndex.customer_type] ?? "").trim() === record.customer_type &&
            Number(saved[savedIndex.technical_sales]) === technicalSales &&
            Number(saved[savedIndex.nomination_fee]) === nominationFee);
        } catch (verifyError) {
          console.error("Technical sales read-back verification failed", { name: verifyError?.name || "Error", status: Number.isInteger(verifyError?.status) ? verifyError.status : undefined });
        }
        if (!verified) {
          return calendarDirect(res,
            "Salesへの追記応答は成功しましたが、読み戻し照合ができませんでした。重複防止のため再登録しないでください。Salesタブを確認してください。",
            "追記済み・読み戻し未確認です。",
            { technicalSale: { registered: true, verified: false, salesId: record.sales_id } }
          );
        }
        return calendarDirect(res,
          saleDate + "の" + (record.customer_type === "nomination" ? "指名" : "フリー") +
          "売上を登録しました。技術売上: " + technicalSales.toLocaleString("ja-JP") +
          "円 / 指名料: " + nominationFee.toLocaleString("ja-JP") + "円。Salesへの記録と読み戻し照合が完了しました。",
          "技術売上を登録しました。",
          { technicalSale: { registered: true, verified: true, salesId: record.sales_id, saleDate, customerType: record.customer_type, technicalSales, nominationFee, staffId: record.staff_id } }
        );
      } catch (error) {
        console.error("Technical sales registration failed", { name: error?.name || "Error", status: Number.isInteger(error?.status) ? error.status : undefined });
        return calendarDirect(res, "技術売上の登録に失敗しました。登録結果が不明な場合はSalesタブを確認してから再依頼してください。", "技術売上の登録に失敗しました。");
      }
    }

    // Explicit retail-sale registration: write only to the registered J.A.R.V.I.S. workbook.
    const retailSaleRegisterIntent =
      /(?:店販|商品).{0,35}(?:売れた|販売(?:した|しました|して)|売った|売りました|購入された|登録して|記録して)|(?:売れた|販売(?:した|しました|して)|売った|売りました).{0,35}(?:店販|商品)|(?:売れた|販売(?:した|しました)|売った|売りました).{0,30}(?:登録|記録|追加)|(?:登録|記録|追加).{0,25}(?:売れた|販売(?:した|しました)|売った|売りました)/.test(userText);
    if (retailSaleRegisterIntent) {
      try {
        const connections = await listConnectionsForUser(user.id);
        const connection = Array.isArray(connections) ? connections.find(item => item?.status === "connected") : null;
        if (!connection?.id) return calendarDirect(res, "Googleが未接続です。", "Googleが未接続です。");
        const registry = await readSpreadsheetRegistry(user.id);
        const workbook = registry?.managementWorkbook;
        if (!workbook?.id) return calendarDirect(res, "J.A.R.V.I.S.管理ブックが未登録です。先に管理ブックを作成してください。", "管理ブックが未登録です。");
        const base = "https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(workbook.id);
        const [productResult, retailHeaderResult, staffResult] = await Promise.all([
          googleApiRequest(user.id, connection.id, base + "/values/" + encodeURIComponent("'Products'!A1:J1000")),
          googleApiRequest(user.id, connection.id, base + "/values/" + encodeURIComponent("'RetailSales'!A1:M1")),
          googleApiRequest(user.id, connection.id, base + "/values/" + encodeURIComponent("'Staff'!A1:Z1000"))
        ]);
        const productRows = Array.isArray(productResult?.values) ? productResult.values : [];
        const staffRows = Array.isArray(staffResult?.values) ? staffResult.values : [];
        const productHeaders = (productRows[0] || []).map(value => String(value || "").trim());
        const retailHeaders = (retailHeaderResult?.values?.[0] || []).map(value => String(value || "").trim());
        const staffHeaders = (staffRows[0] || []).map(value => String(value || "").trim());
        const productIndex = Object.fromEntries(productHeaders.map((name, index) => [name, index]));
        const retailIndex = Object.fromEntries(retailHeaders.map((name, index) => [name, index]));
        const staffIndex = Object.fromEntries(staffHeaders.map((name, index) => [name, index]));
        const requiredProductFields = ["product_id", "product_name", "unit_cost", "default_sale_price", "is_active"];
        const requiredRetailFields = ["retail_sale_id", "sale_date", "product_id", "quantity", "unit_sale_price", "unit_cost", "gross_profit", "staff_id", "record_status", "created_at", "updated_at"];
        const requiredStaffFields = ["staff_id", "display_name", "is_active", "auth_user_id"];
        if (requiredProductFields.some(name => productIndex[name] === undefined) ||
            requiredRetailFields.some(name => retailIndex[name] === undefined)) {
          return calendarDirect(res, "ProductsまたはRetailSalesのヘッダーが現在のスキーマと一致しません。書き込みは行っていません。", "シート構造が一致しないため登録を中止しました。");
        }
        if (requiredStaffFields.some(name => staffIndex[name] === undefined)) {
          return calendarDirect(res, "Staffタブにauth_user_id列がありません。先に管理データをスキーマv4へ更新してください。店販データへの書き込みは行っていません。", "スタッフ連携の準備が必要です。");
        }
        const linkedStaff = staffRows.slice(1).filter(row =>
          String(row?.[staffIndex.auth_user_id] ?? "").trim() === user.id &&
          String(row?.[staffIndex.is_active] ?? "").toLowerCase() !== "false" &&
          String(row?.[staffIndex.staff_id] ?? "").trim()
        );
        if (linkedStaff.length !== 1) {
          return calendarDirect(res,
            linkedStaff.length === 0
              ? "ログインユーザーに紐付くスタッフ情報がありません。先に「スタッフ登録」と表示名・雇用形態を指定してください。店販登録は行っていません。"
              : "同じログインユーザーに複数の有効スタッフ情報が紐付いています。Staffタブを確認してください。店販登録は行っていません。",
            "スタッフ情報を確認してください。"
          );
        }
        const currentStaffId = String(linkedStaff[0][staffIndex.staff_id]).trim();
        const activeProducts = productRows.slice(1).filter(row =>
          String(row?.[productIndex.is_active] ?? "").toLowerCase() !== "false" &&
          String(row?.[productIndex.product_name] ?? "").trim()
        );
        const inferredNameMatch = userText.match(/(?:商品名は|商品は)?\s*(.+?)を\s*\d+\s*(?:個|本|点)/);
        const requestedProductName = String(inferredNameMatch?.[1] || "").trim().replace(/^(?:店販で|店販商品|商品)\s*/, "");
        const exactNameMatches = requestedProductName
          ? activeProducts.filter(row =>
              String(row[productIndex.product_name] ?? "").trim().toLowerCase() === requestedProductName.toLowerCase()
            )
          : [];
        const matchedProducts = exactNameMatches.length
          ? exactNameMatches
          : requestedProductName
            ? []
            : activeProducts.filter(row =>
                userText.toLowerCase().includes(String(row[productIndex.product_name]).trim().toLowerCase())
              );
        const costLabelMatch = userText.match(/(?:仕入原価|仕入れ原価|原価|仕入れ値)\s*(?:は|が|[:：])?\s*([0-9][0-9,]*)\s*円/);
        const labelledPriceMatch = userText.match(/(?:単価|販売価格|売価)\s*([0-9][0-9,]*)\s*円/);
        const allYenAmounts = [...userText.matchAll(/([0-9][0-9,]*)\s*円/g)];
        const costAmountIndex = costLabelMatch ? userText.indexOf(costLabelMatch[1], costLabelMatch.index) : -1;
        const priceCandidates = allYenAmounts.filter(match => match.index !== costAmountIndex);
        const resolvedPriceMatch = labelledPriceMatch || (priceCandidates.length === 1 ? priceCandidates[0] : null);
        let product = matchedProducts[0];
        if (matchedProducts.length > 1) {
          return calendarDirect(res, "商品名が複数一致しました。商品名を正式名称で指定してください。", "商品を特定できないため登録していません。");
        }
        if (matchedProducts.length === 0) {
          const inferredName = requestedProductName;
          const costMatch = costLabelMatch;
          const salePriceMatch = resolvedPriceMatch;
          if (!inferredName || !costMatch || !salePriceMatch) {
            return calendarDirect(res,
              "Productsに未登録の商品です。商品マスターへ追加するため、商品名・仕入原価・販売価格を指定してください。例：「商品名Aを1本、仕入原価1,800円、販売価格3,300円で販売したので登録して」。",
              "未登録商品のため、商品情報が必要です。"
            );
          }
          const newUnitCost = Number(costMatch[1].replace(/,/g, ""));
          const newSalePrice = Number(salePriceMatch[1].replace(/,/g, ""));
          if (!Number.isFinite(newUnitCost) || newUnitCost < 0 || !Number.isFinite(newSalePrice) || newSalePrice < 0) {
            return calendarDirect(res, "仕入原価と販売価格を確認してください。商品マスターへの追加は行っていません。", "商品価格を確認してください。");
          }
          const nowForProduct = new Date();
          const productDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(nowForProduct);
          const newProduct = {
            product_id: crypto.randomUUID(), product_name: inferredName, category: "",
            unit_cost: newUnitCost, default_sale_price: newSalePrice,
            active_from: productDate, active_to: "", is_active: true,
            created_at: nowForProduct.toISOString(), updated_at: nowForProduct.toISOString()
          };
          const productRow = productHeaders.map(header => Object.prototype.hasOwnProperty.call(newProduct, header) ? newProduct[header] : "");
          const productAppendUrl = base + "/values/" + encodeURIComponent("'Products'!A:J") +
            ":append?" + new URLSearchParams({ valueInputOption: "RAW", insertDataOption: "INSERT_ROWS" });
          const productAppend = await googleApiRequest(user.id, connection.id, productAppendUrl, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ majorDimension: "ROWS", values: [productRow] })
          });
          if (!(Number(productAppend?.updates?.updatedRows) >= 1)) {
            return calendarDirect(res, "商品マスターへの追加結果を確認できませんでした。重複防止のため自動再試行はしていません。Productsを確認してください。", "商品登録結果を確認できませんでした。");
          }
          product = productHeaders.map((header, index) => productRow[index] ?? "");
        }
        const productName = String(product[productIndex.product_name]).trim();
        const productPosition = userText.toLowerCase().indexOf(productName.toLowerCase());
        const beforeProduct = userText.slice(0, productPosition);
        const afterProduct = userText.slice(productPosition + productName.length);
        const quantityAfter = afterProduct.match(/^\s*(?:を)?\s*(\d+)\s*(?:個|本|点)/);
        const quantityBefore = beforeProduct.match(/(\d+)\s*(?:個|本|点)\s*(?:の)?\s*$/);
        const quantity = Number(quantityAfter?.[1] || quantityBefore?.[1]);
        if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100) {
          return calendarDirect(res, productName + "の販売数量を確認してください。例：「" + productName + "を1本販売したので登録して」。", "販売数量を確認してください。");
        }
        const defaultPrice = Number(product[productIndex.default_sale_price]);
        const unitSalePrice = resolvedPriceMatch ? Number(resolvedPriceMatch[1].replace(/,/g, "")) : defaultPrice;
        const unitCost = Number(product[productIndex.unit_cost]);
        if (!Number.isFinite(unitSalePrice) || unitSalePrice < 0 || !Number.isFinite(unitCost) || unitCost < 0) {
          return calendarDirect(res, productName + "の販売価格または仕入原価がProductsタブに正しく登録されていません。書き込みは行っていません。", "商品マスターの価格情報を確認してください。");
        }
        const now = new Date();
        const saleDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
        const timestamp = now.toISOString();
        const record = {
          retail_sale_id: crypto.randomUUID(), sale_date: saleDate, customer_id: "",
          product_id: product[productIndex.product_id], quantity, unit_sale_price: unitSalePrice,
          unit_cost: unitCost, gross_profit: (unitSalePrice - unitCost) * quantity,
          staff_id: currentStaffId, notes: "", record_status: "active", created_at: timestamp, updated_at: timestamp
        };
        const row = retailHeaders.map(header => Object.prototype.hasOwnProperty.call(record, header) ? record[header] : "");
        const appendUrl = base + "/values/" + encodeURIComponent("'RetailSales'!A:M") +
          ":append?" + new URLSearchParams({ valueInputOption: "RAW", insertDataOption: "INSERT_ROWS" });
        const appended = await googleApiRequest(user.id, connection.id, appendUrl, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ majorDimension: "ROWS", values: [row] })
        });
        if (!(Number(appended?.updates?.updatedRows) >= 1)) {
          return calendarDirect(res, "Google Sheetsへの追記結果を確認できませんでした。重複登録を避けるため、自動再試行はしていません。", "登録結果を確認できませんでした。");
        }
        let readBackVerified = false;
        try {
          const readBack = await googleApiRequest(
            user.id, connection.id,
            base + "/values/" + encodeURIComponent("'RetailSales'!A1:M10000")
          );
          const savedRows = Array.isArray(readBack?.values) ? readBack.values : [];
          const savedHeaders = (savedRows[0] || []).map(value => String(value || "").trim());
          const savedIndex = Object.fromEntries(savedHeaders.map((name, index) => [name, index]));
          const savedRecord = savedRows.slice(1).find(saved =>
            String(saved?.[savedIndex.retail_sale_id] ?? "").trim() === record.retail_sale_id
          );
          if (savedRecord) {
            const savedStaffId = String(savedRecord[savedIndex.staff_id] ?? "").trim();
            const savedProductId = String(savedRecord[savedIndex.product_id] ?? "").trim();
            const savedQuantity = Number(savedRecord[savedIndex.quantity]);
            if (savedStaffId !== currentStaffId || savedProductId !== String(record.product_id) || savedQuantity !== quantity) {
              return calendarDirect(res,
                "店販行は追記されましたが、読み戻し内容が登録値と一致しません。再登録は行わず、RetailSalesを確認してください。",
                "登録後の照合で不一致を検出しました。",
                { retailSale: { registered: true, verified: false, retailSaleId: record.retail_sale_id } }
              );
            }
            readBackVerified = true;
          }
        } catch (verifyError) {
          console.error("Retail sale read-back verification failed", { name: verifyError?.name || "Error", status: Number.isInteger(verifyError?.status) ? verifyError.status : undefined });
        }
        if (!readBackVerified) {
          return calendarDirect(res,
            "店販行の追記応答は成功しましたが、読み戻し確認ができませんでした。重複防止のため再登録しないでください。RetailSalesを確認してください。",
            "追記済み・読み戻し未確認です。",
            { retailSale: { registered: true, verified: false, retailSaleId: record.retail_sale_id } }
          );
        }
        return calendarDirect(res,
          productName + "の販売を登録しました。\n数量: " + quantity + " / 販売単価: " + unitSalePrice.toLocaleString("ja-JP") +
          "円 / 利益: " + record.gross_profit.toLocaleString("ja-JP") + "円。登録先: RetailSales。",
          productName + "の販売を登録しました。",
          { retailSale: { registered: true, verified: true, retailSaleId: record.retail_sale_id, productId: record.product_id, staffId: currentStaffId, quantity, unitSalePrice, unitCost, grossProfit: record.gross_profit, saleDate } }
        );
      } catch (error) {
        console.error("Retail sale registration failed", { name: error?.name || "Error", status: Number.isInteger(error?.status) ? error.status : undefined });
        return calendarDirect(res, "店販登録に失敗しました。登録結果が不明な場合は、RetailSalesを確認してから再依頼してください。", "店販登録に失敗しました。");
      }
    }

    const managementWorkbookCreateIntent =
      /(?:管理ブック|管理データ).{0,24}(?:作成して|作って|新規作成)|(?:新規|新しい).{0,16}(?:管理ブック|管理データ).{0,12}(?:作成して|作って)/.test(userText);
    const managementWorkbookSchemaIntent =
      /(?:管理ブック|管理データ|新しい売上管理|新しい店販管理)/.test(userText) &&
      /(?:構成|設計|項目|タブ|シート|どんな|表示)/.test(userText) &&
      !/(?:調査|監査|詳しく|読み取|中身|データを確認|実際の内容)/.test(userText);
    const managementWorkbookAuditIntent =
      /(?:管理ブック|管理データ).{0,50}(?:監査|照合|整合性|ヘッダー確認|列名確認)|(?:全8タブ|8タブ).{0,30}(?:監査|照合|確認)/.test(userText) &&
      /(?:読み取り専用|データ行は変更しない|変更しない|照合|監査)/.test(userText);
    const managementWorkbookUpgradeIntent =
      !managementWorkbookAuditIntent &&
      /(?:管理ブック|管理データ).{0,40}(?:拡張|項目を追加|整備|最新(?:の構成|スキーマ|版)|スキーマ(?:更新|v?3|v?4)|v?[34]に更新)/.test(userText);
    if (managementWorkbookUpgradeIntent) {
      try {
        const connections = await listConnectionsForUser(user.id);
        const connection = Array.isArray(connections) ? connections.find(item => item?.status === "connected") : null;
        if (!connection?.id) return calendarDirect(res, "Googleが未接続です。", "Googleが未接続です。");
        const registry = await readSpreadsheetRegistry(user.id);
        const workbook = registry?.managementWorkbook;
        if (!workbook?.id) return calendarDirect(res, "管理ブックが登録されていません。先に作成してください。", "管理ブックが見つかりません。");
        const metadata = await googleApiRequest(user.id, connection.id,
          "https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(workbook.id) + "?" +
          new URLSearchParams({ fields: "sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))" }));
        const existingSheets = Array.isArray(metadata?.sheets) ? metadata.sheets : [];
        const byTitle = new Map(existingSheets.map(item => [item?.properties?.title, item?.properties]));
        const requests = [];
        const added = [];
        const changedHeaders = [];
        for (const definition of managementWorkbookSchema) {
          const existing = byTitle.get(definition.title);
          if (!existing) {
            requests.push({ addSheet: { properties: {
              title: definition.title,
              gridProperties: { rowCount: 1000, columnCount: definition.headers.length }
            } } });
            added.push(definition.title);
          } else if (definition.title === "Staff") {
            const headerData = await googleApiRequest(user.id, connection.id,
              "https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(workbook.id) + "/values/" + encodeURIComponent("Staff!A1:Z1"));
            const currentHeader = Array.isArray(headerData?.values?.[0]) ? headerData.values[0].map(value => String(value ?? "").trim()) : [];
            if (!currentHeader.includes("auth_user_id")) {
              const lastUsedIndex = currentHeader.reduce((last, value, index) => value ? index : last, -1);
              const targetColumnIndex = lastUsedIndex + 1;
              const columnLetter = targetColumnIndex < 26 ? String.fromCharCode(65 + targetColumnIndex) : null;
              if (!columnLetter) throw new Error("Staff header has no available column for auth_user_id");
              const oldColumns = Number(existing.gridProperties?.columnCount) || 0;
              requests.push({
                updateSheetProperties: {
                  properties: { sheetId: existing.sheetId, gridProperties: { columnCount: Math.max(oldColumns, targetColumnIndex + 1) } },
                  fields: "gridProperties.columnCount"
                }
              });
              requests.push({
                updateCells: {
                  range: { sheetId: existing.sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: targetColumnIndex, endColumnIndex: targetColumnIndex + 1 },
                  rows: [{ values: [{ userEnteredValue: { stringValue: "auth_user_id" } }] }],
                  fields: "userEnteredValue"
                }
              });
              changedHeaders.push("Staff.auth_user_id");
            }
          } else if (definition.title === "Menus") {
            const headerRange = definition.title + "!A1:" + String.fromCharCode(64 + definition.headers.length) + "1";
            const headerData = await googleApiRequest(user.id, connection.id,
              "https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(workbook.id) + "/values/" + encodeURIComponent(headerRange));
            const currentHeader = Array.isArray(headerData?.values?.[0]) ? headerData.values[0] : [];
            if (currentHeader.some(value => String(value ?? "").trim() !== "")) continue;
            const oldColumns = Number(existing.gridProperties?.columnCount) || 0;
            requests.push({
              updateSheetProperties: {
                properties: { sheetId: existing.sheetId, gridProperties: { columnCount: Math.max(oldColumns, definition.headers.length) } },
                fields: "gridProperties.columnCount"
              }
            });
            requests.push({
              updateCells: {
                range: { sheetId: existing.sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: definition.headers.length },
                rows: [{ values: definition.headers.map(value => ({ userEnteredValue: { stringValue: value } })) }],
                fields: "userEnteredValue"
              }
            });
            changedHeaders.push(definition.title);
          } else if (["CompensationRules", "RetailSales"].includes(definition.title)) {
            const oldColumns = Number(existing.gridProperties?.columnCount) || 0;
            requests.push({
              updateSheetProperties: {
                properties: { sheetId: existing.sheetId, gridProperties: { columnCount: Math.max(oldColumns, definition.headers.length) } },
                fields: "gridProperties.columnCount"
              }
            });
            requests.push({
              updateCells: {
                range: { sheetId: existing.sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: definition.headers.length },
                rows: [{ values: definition.headers.map(value => ({ userEnteredValue: { stringValue: value } })) }],
                fields: "userEnteredValue"
              }
            });
            changedHeaders.push(definition.title);
          }
        }
        if (requests.length) {
          await googleApiRequest(user.id, connection.id,
            "https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(workbook.id) + ":batchUpdate",
            { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requests }) }
          );
        }
        const updatedRecord = { ...workbook, schemaVersion: 4, updatedAt: new Date().toISOString() };
        await saveSpreadsheetRegistry(user.id, { ...registry, version: 1, managementWorkbook: updatedRecord });
        return calendarDirect(res,
          "管理ブックをスキーマv4に更新しました。追加タブ: " + (added.join(" / ") || "なし") +
          "。ヘッダー更新: " + (changedHeaders.join(" / ") || "なし") +
          "。既存の売上・店販・商品・設定・変更履歴のデータ行は変更していません。",
          "管理ブックの構造を更新しました。",
          { managementWorkbook: { schemaVersion: 4, addedSheets: added, updatedHeaders: changedHeaders } }
        );
      } catch (error) {
        console.error("Management workbook schema upgrade failed", { name: error?.name || "Error", status: Number.isInteger(error?.status) ? error.status : undefined });
        return calendarDirect(res, "管理ブックの構造更新に失敗しました。データ行は変更していません。", "管理ブックの更新に失敗しました。");
      }
    }
    if (managementWorkbookCreateIntent) {
      try {
        const connections = await listConnectionsForUser(user.id);
        const connection = Array.isArray(connections) ? connections.find(item => item?.status === "connected") : null;
        if (!connection?.id) return calendarDirect(res, "Googleが未接続です。先にGoogle接続を行ってください。", "Googleが未接続です。");
        const existingRegistry = await readSpreadsheetRegistry(user.id);
        const existingWorkbook = existingRegistry?.managementWorkbook;
        if (existingWorkbook?.id) {
          return calendarDirect(res,
            "J.A.R.V.I.S.管理ブックは既に登録されています。重複作成は行いません。\nURL: " + (existingWorkbook.url || "登録済み") ,
            "管理ブックは既に登録されています。",
            { managementWorkbook: { created: false, alreadyExists: true, spreadsheetId: existingWorkbook.id, spreadsheetUrl: existingWorkbook.url || null } }
          );
        }
        const createSheets = managementWorkbookSchema.map(sheet => ({
          properties: {
            title: sheet.title,
            gridProperties: { rowCount: 1000, columnCount: sheet.headers.length }
          },
          data: [{
            startRow: 0,
            startColumn: 0,
            rowData: [{
              values: sheet.headers.map(value => ({ userEnteredValue: { stringValue: value } }))
            }]
          }]
        }));
        const created = await googleApiRequest(
          user.id,
          connection.id,
          "https://sheets.googleapis.com/v4/spreadsheets",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              properties: { title: "J.A.R.V.I.S. 管理データ" },
              sheets: createSheets
            })
          }
        );
        if (!created?.spreadsheetId) throw new Error("Google Sheets returned no spreadsheetId");
        const workbookRecord = {
          id: created.spreadsheetId,
          name: created?.properties?.title || "J.A.R.V.I.S. 管理データ",
          url: created?.spreadsheetUrl || null,
          schemaVersion: 1,
          createdAt: new Date().toISOString()
        };
        await saveSpreadsheetRegistry(user.id, {
          ...(existingRegistry || { version: 1, spreadsheets: {} }),
          version: 1,
          managementWorkbook: workbookRecord
        });
        return calendarDirect(res,
          "J.A.R.V.I.S.管理ブックを作成し、登録しました。\nURL: " + (workbookRecord.url || "Google Sheetsで確認してください") +
          "\nタブ: " + managementWorkbookSchema.map(sheet => sheet.title).join(" / ") +
          "\n各タブはfield nameで識別します。元データと計算値を分離し、集計は元データから算出する設計です。既存の売上管理・店販管理ファイルは変更していません。",
          "J.A.R.V.I.S.管理ブックを作成しました。既存ファイルは変更していません。",
          { managementWorkbook: { created: true, spreadsheetId: created.spreadsheetId, spreadsheetUrl: workbookRecord.url, schemaVersion: 1 } }
        );
      } catch (error) {
        console.error("Management workbook creation failed", {
          name: error?.name || "Error",
          status: Number.isInteger(error?.status) ? error.status : undefined,
          code: typeof error?.code === "string" ? error.code : undefined
        });
        return calendarDirect(res,
          "J.A.R.V.I.S.管理ブックを作成できませんでした。Google接続状態とSheets APIの権限を確認してください。既存ファイルへの変更は行っていません。",
          "管理ブックを作成できませんでした。"
        );
      }
    }
    if (managementWorkbookSchemaIntent) {
      const schemaLines = managementWorkbookSchema.map(sheet =>
        sheet.title + ": " + sheet.headers.join(", ")
      );
      let workbookStatus = "Google Sheetsはまだ作成されていません。";
      try {
        const currentRegistry = await readSpreadsheetRegistry(user.id);
        const currentWorkbook = currentRegistry?.managementWorkbook;
        if (currentWorkbook?.id) {
          workbookStatus = "管理ブックは登録済みです。\\nURL: " +
            (currentWorkbook.url || ("https://docs.google.com/spreadsheets/d/" + currentWorkbook.id + "/edit"));
        }
      } catch (error) {
        console.error("Management workbook status lookup failed", { name: error?.name || "Error" });
        workbookStatus = "管理ブックの登録状態を確認できませんでした。";
      }
      return calendarDirect(res,
        "J.A.R.V.I.S.管理ブックの標準構成\\n" +
        workbookStatus + "\\n\\n" +
        schemaLines.join("\\n") +
        "\\n\\n日付はYYYY-MM-DD、金額・数量・時間は数値、レコードは安定IDで識別します。報酬ルールは適用期間で管理し、社員・業務委託の両方に対応します。集計値は元データから算出し、元データと混在させません。顧客氏名など不要な個人情報は保存しません。",
        "管理ブックの構成と登録状態を確認しました。"
      );
    }

    // Spreadsheet agent v3: supports explicit plan creation and registered stable IDs.
    const spreadsheetFollowupPlanIntent =
      /(?:先ほど|さっき|前回).{0,30}(?:監査|調査|結果).{0,30}(?:修正計画|計画|修正案)|(?:監査結果|調査結果).{0,30}(?:修正計画|計画|修正案)|(?:修正計画|計画を作成).{0,20}(?:監査|調査)/.test(userText);
    const sheetAgentIntent =
      (/(?:スプレッドシート|シート|管理ブック|管理データ|売上管理|店販管理)/.test(userText) ||
        spreadsheetFollowupPlanIntent) &&
      (
        managementWorkbookAuditIntent ||
        /(?:完成させて|直して|修正して|修正計画|計画を作成|作成して|作って|構造を調べて|調査して|確認して|確認|数式を確認|未完成|自分で作って|整えて|詳しく)/.test(userText)
      ) &&
      !/(?:書き込んで|書いて|更新して|追記して|追加して|変更して|削除して|実行して)/.test(userText);
    if (sheetAgentIntent) {
      try {
        const connections = await listConnectionsForUser(user.id);
        const connection = Array.isArray(connections) ? connections.find(item => item?.status === "connected") : null;
        if (!connection?.id) return calendarDirect(res, "Googleが未接続です。先にGoogle接続を行ってください。", "Googleが未接続です。");

        // Follow-up plan requests may refer to the immediately preceding audit without repeating its file name.
        // In that narrow case, the preceding audit flow is for the registered sales workbook.
        const spreadsheetName = /管理ブック|管理データ/.test(userText)
          ? "管理ブック"
          : /店販管理/.test(userText)
            ? "店販管理"
            : /売上管理/.test(userText) || spreadsheetFollowupPlanIntent
              ? "売上管理"
              : null;
        if (!spreadsheetName) {
          return calendarDirect(res, "調査するファイル名を指定してください。「売上管理を詳しく調査して」と依頼できます。", "調査するスプレッドシート名を指定してください。");
        }
        const registry = await readSpreadsheetRegistry(user.id);
        const registered = spreadsheetName === "管理ブック"
          ? registry?.managementWorkbook
          : spreadsheetName === "売上管理"
            ? registry?.spreadsheets?.sales
            : registry?.spreadsheets?.retail;
        let file = null;
        if (registered?.id && /^[a-zA-Z0-9_-]{10,200}$/.test(registered.id)) {
          const candidate = await googleApiRequest(user.id, connection.id,
            "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(registered.id) + "?" +
            new URLSearchParams({ fields: "id,name,mimeType,modifiedTime" }));
          if (candidate?.mimeType !== "application/vnd.google-apps.spreadsheet") {
            return calendarDirect(res, "登録済みIDのファイルがGoogleスプレッドシートではありません。登録情報を確認してください。", "登録済みファイルを確認できませんでした。");
          }
          file = candidate;
        } else {
          const q = new URLSearchParams({
            q: "name = '" + spreadsheetName.replace(/'/g, "\\'") + "' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false",
            pageSize: "10", orderBy: "modifiedTime desc",
            fields: "files(id,name,mimeType,modifiedTime)"
          });
          const found = await googleApiRequest(user.id, connection.id, "https://www.googleapis.com/drive/v3/files?" + q);
          const files = Array.isArray(found?.files) ? found.files : [];
          if (files.length !== 1) return calendarDirect(res, files.length ? "同じ名前のファイルが複数あります。ファイル名を特定してください。" : "「" + spreadsheetName + "」が見つかりませんでした。ID登録後は改名しても識別できます。", "対象ファイルを特定できませんでした。");
          file = files[0];
        }
        const metadata = await googleApiRequest(user.id, connection.id,
          "https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(file.id) + "?" +
          new URLSearchParams({fields:"properties(title),sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))"}));
        const sheetList = Array.isArray(metadata?.sheets) ? metadata.sheets : [];
        const reports = [];
        const findings = [];
        const allFormulaCells = [];
        const allFormulaErrors = [];
        const allSheetSnapshots = [];
        const formulaColumnReferences = new Map();
        const colName = n => {
          let out = "";
          while (n >= 0) { out = String.fromCharCode(n % 26 + 65) + out; n = Math.floor(n / 26) - 1; }
          return out;
        };
        for (const sheet of sheetList.slice(0, 10)) {
          const props = sheet?.properties || {};
          const title = props.title;
          if (!title) continue;
          const isSummary = /集計|summary|dashboard/i.test(title);
          const gridRows = Math.max(1, Number(props.gridProperties?.rowCount) || 100);
          const gridColumns = Math.max(1, Number(props.gridProperties?.columnCount) || 26);
          // Audit the full declared grid (bounded for response size), not only A:K/A:C.
          // This is necessary to detect references to columns such as I and formulas beyond K.
          const lastCol = colName(Math.min(gridColumns, 100) - 1);
          const maxRows = Math.max(20, Math.min(gridRows, 1000));
          const range = "'" + title.replace(/'/g, "''") + "'!A1:" + lastCol + maxRows;
          const baseUrl = "https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(file.id) + "/values/" + encodeURIComponent(range);
          const [formulaResult, displayResult] = await Promise.all([
            googleApiRequest(user.id, connection.id, baseUrl + "?" + new URLSearchParams({valueRenderOption:"FORMULA",dateTimeRenderOption:"FORMATTED_STRING"})),
            googleApiRequest(user.id, connection.id, baseUrl + "?" + new URLSearchParams({valueRenderOption:"FORMATTED_VALUE",dateTimeRenderOption:"FORMATTED_STRING"}))
          ]);
          const formulaRows = Array.isArray(formulaResult?.values) ? formulaResult.values : [];
          const displayRows = Array.isArray(displayResult?.values) ? displayResult.values : [];
          allSheetSnapshots.push({ sheet: title, formulaRows, displayRows });
          const populated = formulaRows.filter(row => row.some(cell => String(cell ?? "").trim() !== ""));
          const formulaCells = [];
          const formulasByColumn = new Map();
          const formulaErrors = [];
          for (let r = 0; r < formulaRows.length; r++) {
            const row = formulaRows[r] || [];
            for (let c = 0; c < row.length; c++) {
              const value = row[c];
              if (typeof value === "string" && value.startsWith("=")) {
                const addr = colName(c) + (r + 1);
                const normalized = value.replace(/\$?([A-Z]{1,3})\$?\d+/g, "$1#");
                formulaCells.push({addr, col:colName(c), row:r+1, formula:value, normalized});
                if (!formulasByColumn.has(colName(c))) formulasByColumn.set(colName(c), []);
                formulasByColumn.get(colName(c)).push({row:r+1, formula:value, normalized});
                // Record cross-cell column references for safe structural-change review.
                const referencePattern = /(?:'[^']+'!|[A-Za-z0-9_]+!)?\$?([A-Z]{1,3})\$?\d+/g;
                let referenceMatch;
                while ((referenceMatch = referencePattern.exec(value)) !== null) {
                  const referencedColumn = referenceMatch[1];
                  if (!formulaColumnReferences.has(referencedColumn)) formulaColumnReferences.set(referencedColumn, []);
                  formulaColumnReferences.get(referencedColumn).push({sheet:title, cell:colName(c)+(r+1), formula:value});
                }
              }
              const shown = displayRows[r]?.[c];
              if (typeof shown === "string" && /^#(?:REF!|DIV\/0!|VALUE!|N\/A|NAME\?|NUM!|NULL!)/.test(shown)) {
                formulaErrors.push(colName(c) + (r+1) + "=" + shown);
              }
            }
          }
          allFormulaCells.push(...formulaCells.map(item => ({ sheet: title, ...item })));
          allFormulaErrors.push(...formulaErrors.map(item => ({ sheet: title, value: item })));
          const headerValues = (formulaRows[0] || []).map(cell => String(cell || "").trim());
          const header = headerValues.map((cell, i) => cell || "[" + colName(i) + "列]").join(" | ");
          if (spreadsheetName === "管理ブック") {
            const expectedSheet = managementWorkbookSchema.find(item => item.title === title);
            if (!expectedSheet) {
              findings.push("管理ブックに想定外のタブ「" + title + "」があります。用途を確認してください。");
            } else {
              const expectedHeaders = expectedSheet.headers;
              const missing = expectedHeaders.filter((value, index) => headerValues[index] !== value);
              const extra = headerValues.slice(expectedHeaders.length).filter(Boolean);
              const orderMismatch = expectedHeaders.some((value, index) => headerValues[index] !== value);
              if (orderMismatch || headerValues.length !== expectedHeaders.length) {
                findings.push("「" + title + "」のヘッダーがスキーマv3と一致しません。期待列数=" +
                  expectedHeaders.length + " / 実際の列数=" + headerValues.length +
                  (missing.length ? " / 不一致・不足候補=" + missing.join(", ") : "") +
                  (extra.length ? " / 余分な列=" + extra.join(", ") : "") +
                  "。列の自動変更は行っていません。");
              }
            }
          }
          const colStats = [];
          for (const [col, entries] of formulasByColumn.entries()) {
            const patterns = new Map();
            for (const entry of entries) patterns.set(entry.normalized, (patterns.get(entry.normalized) || 0) + 1);
            colStats.push(col + "列:" + entries.length + "個(" + patterns.size + "種類)");
            if (patterns.size > 1) findings.push("「" + title + "」" + col + "列に数式パターンが" + patterns.size + "種類あります。行ごとの意図的な違いか確認が必要です。");
            if (!isSummary && entries.length > 2) {
              const first = Math.min(...entries.map(e=>e.row)), last = Math.max(...entries.map(e=>e.row));
              const rowsWithFormula = new Set(entries.map(e=>e.row));
              const gaps = [];
              for (let n=first+1; n<last && gaps.length<8; n++) if (!rowsWithFormula.has(n)) gaps.push(n);
              if (gaps.length) findings.push("「" + title + "」" + col + "列で数式が抜けている可能性のある行: " + gaps.join(", ") + (last-first > gaps.length+8 ? " など" : "") + "。空行・意図的な空欄か確認が必要です。");
            }
          }
          if (formulaErrors.length) findings.push("「" + title + "」に計算エラー表示: " + formulaErrors.slice(0,12).join(", ") + (formulaErrors.length>12 ? " ほか" : ""));
          const samples = formulaCells.slice(0, 8).map(item => item.addr + "=" + item.formula).join(" | ");
          reports.push("【" + title + "】調査範囲A1:" + lastCol + maxRows +
            " / 入力済み行 " + populated.length + "行 / 数式 " + formulaCells.length + "個" +
            "\n列名: " + header +
            "\n数式分布: " + (colStats.join("、") || "数式なし") +
            "\n数式例: " + (samples || "なし") +
            (formulaErrors.length ? "\n計算エラー: " + formulaErrors.slice(0,8).join(", ") : "\n表示上の計算エラー: なし"));
        }
        if (spreadsheetName === "管理ブック") {
          const actualTitles = new Set(sheetList.map(item => item?.properties?.title).filter(Boolean));
          const missingTabs = managementWorkbookSchema.map(item => item.title).filter(title => !actualTitles.has(title));
          if (missingTabs.length) findings.push("スキーマv3で必要なタブが不足しています: " + missingTabs.join(", "));
          else findings.push("スキーマv3の必須8タブはすべて存在します。");
        }
        const iColumnRefs = formulaColumnReferences.get("I") || [];
        if (iColumnRefs.length) {
          const examples = iColumnRefs.slice(0, 20).map(item => item.sheet + "!" + item.cell + " (" + item.formula + ")");
          findings.push("I列を参照する数式が" + iColumnRefs.length + "件あります。列削除・移動前に参照先の意味を確認してください。参照例: " + examples.join(" / "));
        } else {
          findings.push("監査範囲内でI列を参照する数式は検出されませんでした。ただし、監査上限外の行・列、名前付き範囲、グラフ等の参照は別途確認が必要です。");
        }
        if (/売上管理/.test(spreadsheetName)) {
          findings.push("集計シートの月別総売上は、8月がG2:G100とF101:F200、9月がG列の別範囲を参照しているように見えます。月別の対象行が意図どおりか確認が必要です。");
          findings.push("平均客単価・時間売上は客数や施術時間が0のときに#DIV/0!となる可能性があります。IFERRORまたは分母チェックを検討します。");
          findings.push("シート1のG列（合計売上）はD列（技術売上）+E列（指名料）+F列（店販）の数式パターンが行全体で一貫しているか確認が必要です。");
        }
        // Persist the last audited workbook so later plan requests can resolve "that audit" without a repeated file name.
        try {
          await saveSpreadsheetRegistry(user.id, {
            ...(registry || { version: 1, spreadsheets: {} }),
            lastAuditSpreadsheet: spreadsheetName
          });
        } catch (registryError) {
          console.error("Spreadsheet audit context save failed", { name: registryError?.name || "Error" });
        }
        if (spreadsheetFollowupPlanIntent) {
          const salesSheet = sheetList.find(item => item?.properties?.title === "シート1")?.properties?.title || sheetList[0]?.properties?.title || "シート1";
          const summarySheet = sheetList.find(item => /集計|summary|dashboard/i.test(item?.properties?.title || ""))?.properties?.title || "集計";
          const snapshotFor = name => allSheetSnapshots.find(item => item.sheet === name);
          const cellAt = (snapshot, address, rowsKey) => {
            if (!snapshot) return "";
            const match = address.match(/^([A-Z]+)(\d+)$/);
            if (!match) return "";
            let col = 0;
            for (const ch of match[1]) col = col * 26 + ch.charCodeAt(0) - 64;
            return snapshot[rowsKey]?.[Number(match[2]) - 1]?.[col - 1] ?? "";
          };
          const salesSnapshot = snapshotFor(salesSheet);
          const summarySnapshot = snapshotFor(summarySheet);
          const formulaAt = (snapshot, address) => String(cellAt(snapshot, address, "formulaRows") || "");
          const displayAt = (snapshot, address) => String(cellAt(snapshot, address, "displayRows") ?? "");
          const summaryCells = ["B2","B3","B4","B5","B6","B7","B8","B9","B10","B11","C2"];
          const summaryFormulaLines = summaryCells.map(address =>
            address + ": " + (formulaAt(summarySnapshot, address) || "数式なし") +
            " / 表示値: " + (displayAt(summarySnapshot, address) || "空欄")
          );
          const gFormulas = allFormulaCells.filter(item => item.sheet === salesSheet && item.col === "G");
          const gPatterns = new Map();
          for (const item of gFormulas) {
            if (!gPatterns.has(item.normalized)) gPatterns.set(item.normalized, []);
            gPatterns.get(item.normalized).push(item);
          }
          const gPatternLines = [...gPatterns.entries()].map(([pattern, items]) =>
            pattern + " : " + items.length + "セル（例: " +
            items.slice(0, 8).map(item => item.addr + "=" + item.formula).join(" / ") + "）"
          );
          const dateSnapshot = salesSnapshot;
          const dateRows = [];
          if (dateSnapshot) {
            const dateValues = dateSnapshot.displayRows || [];
            for (let i = 1; i < dateValues.length; i++) {
              const date = String(dateValues[i]?.[0] ?? "").trim();
              if (date) dateRows.push("A" + (i + 1) + "=" + date);
              if (dateRows.length >= 30) break;
            }
          }
          const monthReferences = summaryCells
            .filter(address => /^B[2-8]$/.test(address) || address === "C2")
            .map(address => address + " (" + displayAt(summarySnapshot, address) + ") -> " + (formulaAt(summarySnapshot, address) || "数式なし"));
          const errorLines = allFormulaErrors
            .filter(item => item.sheet === summarySheet)
            .map(item => item.value);
          const planLines = [
            "1. 集計シートの月別集計は、見出しセルと参照範囲を対で確認します。式の参照先だけでは月の意味を断定できないため、元データの日付列と照合するまで変更しません。",
            "2. B9・B11は現在の式と表示値を確認済みです。ゼロ除算時に0を表示するか空欄にするかは、未入力状態の意味を決めてから選択します。",
            "3. " + salesSheet + "!G列は数式パターンごとに分類しました。例外セルは個別確認し、列全体の一括置換は行いません。",
            "4. " + summarySheet + "!B2:B11・C2の式はセル単位で一覧化しました。式の意味が確定しないセルは修正対象にしません。"
          ];
          const planReport = "スプレッドシート修正計画（読み取り専用・実行前）\\nファイル: " + file.name +
            "\\n対象: " + salesSheet + " / " + summarySheet +
            "\\n\\n【集計シートの現行数式・表示値】\\n" + summaryFormulaLines.join("\\n") +
            "\\n\\n【" + salesSheet + " のG列数式パターン】\\n数式セル数: " + gFormulas.length + " / パターン数: " + gPatterns.size +
            "\\n" + (gPatternLines.join("\\n") || "数式なし") +
            "\\n\\n【元データの日付列（A列・先頭30件まで）】\\n" + (dateRows.join(" / ") || "日付の入力値なし") +
            "\\n\\n【集計シートの計算エラー】\\n" + (errorLines.join(", ") || "表示上の計算エラーなし") +
            "\\n\\n【修正計画】\\n" + planLines.join("\\n") +
            "\\n\\n【影響範囲】B9・B11は集計表示のみ。B2:B8・C2およびG列は売上集計値に影響するため、月別の行配置と数式の意図が確認できたセルだけを変更します。" +
            "\\n【実行前の確認】変更対象セル・変更前後の式・表示値・参照範囲・影響する集計項目を一覧化し、バックアップ可能な状態で明示承認を得ます。" +
            "\\n\\n今回は計画の精度を上げるための再取得のみです。Google Sheetsへの変更は一切行っていません。日付列の実データと月別集計の対応が確認できない箇所は、引き続き保留します。";
          return calendarDirect(res, planReport, "修正計画を更新しました。シートは変更していません。");
        }
        const report = "スプレッドシート詳細監査（読み取り専用）\nファイル: " + file.name +
          "\nシート数: " + sheetList.length + "\n調査範囲: 各シート最大100列・1,000行（実際のシート範囲に応じて制限）" +
          "\n\n【列参照監査】\nI列を参照する数式: " + (iColumnRefs.length ? iColumnRefs.length + "件" : "検出なし") +
          "\n\n" + (reports.join("\n\n") || "シートが見つかりませんでした。") +
          "\n\n【修正候補】\n" + [...new Set(findings)].map((item,i)=>(i+1)+". "+item).join("\n") +
          "\n\nこれは監査と修正候補の提示のみです。シートの値・数式は変更していません。次に、変更対象セル・変更前後の数式・影響範囲を明記した計画を作成し、明示的な承認後にのみ実行します。";
        return calendarDirect(res, report, "スプレッドシートの詳細監査が完了しました。変更は行っていません。");
      } catch (error) {
        console.error("Spreadsheet agent audit failed", {name:error?.name || "Error", status:Number.isInteger(error?.status)?error.status:undefined, code:typeof error?.code==="string"?error.code:undefined});
        return calendarDirect(res, "スプレッドシートの詳細監査に失敗しました。Google接続状態とファイル名を確認してください。", "スプレッドシートを調査できませんでした。");
      }
    }

    // Visualization creation requests must reach the normal Gemini visualization flow,
    // even when they mention sales/revenue. Do not accidentally route them into Drive lookup.
    const visualizationCreationIntent =
      /(?:グラフ|棒グラフ|円グラフ|折れ線グラフ|チャート|図表|可視化)/.test(userText) &&
      /(?:作成|作って|作成して|生成|描いて|表示して|出して)/.test(userText);

    // Google Sheets read and basic sales analysis. All operations here are read-only.
    const sheetsReadIntent =
      !visualizationCreationIntent &&
      /(?:スプレッドシート|シート|店販管理|店販|表|売上表|売上|利益|利益率|販売実績)/.test(userText) &&
      /(?:読んで|読み取って|見せて|表示して|確認して|調べて|取得して|読める|内容|一覧|いくら|合計|売上|利益|利益率|分析|集計|何件|何個|今月|先月|今年|今期|月別)/.test(userText) &&
      !/(?:書き込んで|書いて|更新して|追記して|追加して|変更して|削除して)/.test(userText);
    if (sheetsReadIntent) {
      try {
        const connections = await listConnectionsForUser(user.id);
        const connection = Array.isArray(connections)
          ? connections.find(item => item?.status === "connected")
          : null;
        if (!connection?.id) {
          return calendarDirect(res, "Googleが未接続です。先にGoogle接続を行ってください。", "Googleが未接続です。");
        }

        const quotedNames = [...userText.matchAll(/[「『“"]([^」』”"]{1,200})[」』”"]/g)].map(match => match[1].trim());
        const analyticalQuestion = /(?:売上|利益|利益率|販売実績|月別|合計|集計|分析|何件|何個|いくら)/.test(userText);
        const explicitSales = /(?:売上管理|技術売上|客単価|施術売上|指名売上)/.test(userText);
        const explicitRetail = /(?:店販管理|個人販売管理表|商品販売|販売数量|販売個数|商品名)/.test(userText);
        const registry = await readSpreadsheetRegistry(user.id);
        const registeredEntry = explicitRetail
          ? registry?.spreadsheets?.retail
          : explicitSales || analyticalQuestion
            ? registry?.spreadsheets?.sales
            : null;
        const spreadsheetName = registeredEntry?.name ||
          (explicitRetail ? "店販管理" : explicitSales || analyticalQuestion ? "売上管理" : null) ||
          quotedNames.find(name => /管理表|スプレッドシート|販売|売上/.test(name));
        if (!spreadsheetName) {
          return calendarDirect(res, "読み取るスプレッドシート名を指定してください。「売上管理」または「店販管理」を指定できます。", "読み取るスプレッドシート名を指定してください。");
        }

        let spreadsheet = null;
        if (registeredEntry?.id && /^[a-zA-Z0-9_-]{10,200}$/.test(registeredEntry.id)) {
          spreadsheet = await googleApiRequest(
            user.id, connection.id,
            "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(registeredEntry.id) + "?" +
            new URLSearchParams({ fields: "id,name,mimeType,modifiedTime" })
          );
          if (spreadsheet?.mimeType !== "application/vnd.google-apps.spreadsheet") {
            return calendarDirect(res, "登録済みIDのファイルがGoogleスプレッドシートではありません。登録情報を確認してください。", "登録済みファイルを確認できませんでした。");
          }
        } else {
          const escapedName = spreadsheetName.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
          const driveQuery = new URLSearchParams({
            q: "name = '" + escapedName + "' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false",
            pageSize: "10",
            orderBy: "modifiedTime desc",
            fields: "files(id,name,mimeType,modifiedTime)"
          });
          const driveResult = await googleApiRequest(
            user.id, connection.id,
            "https://www.googleapis.com/drive/v3/files?" + driveQuery.toString()
          );
          const files = Array.isArray(driveResult?.files) ? driveResult.files : [];
          if (files.length !== 1) {
            return calendarDirect(
              res,
              files.length ? "同じ名前のスプレッドシートが複数あります。ファイル名をより具体的に指定してください。" : "「" + spreadsheetName + "」というスプレッドシートが見つかりませんでした。Driveのファイル名を確認してください。",
              "対象のスプレッドシートを特定できませんでした。"
            );
          }
          spreadsheet = files[0];
        }

        const metadata = await googleApiRequest(
          user.id, connection.id,
          "https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(spreadsheet.id) +
          "?" + new URLSearchParams({ fields: "properties(title),sheets(properties(title,gridProperties(rowCount,columnCount)))" })
        );
        const availableSheets = Array.isArray(metadata?.sheets) ? metadata.sheets : [];
        const requestedTab = quotedNames.find(name => availableSheets.some(sheet => sheet?.properties?.title === name));
        const tab = requestedTab || (userText.includes("売上") && availableSheets.some(sheet => sheet?.properties?.title === "売上")
          ? "売上"
          : availableSheets[0]?.properties?.title);
        if (!tab) {
          return calendarDirect(res, "スプレッドシートに読み取れるシートがありません。", "シートが見つかりません。");
        }

        const range = "'" + tab.replace(/'/g, "''") + "'!A1:Z1000";
        const valuesQuery = new URLSearchParams({
          valueRenderOption: "FORMATTED_VALUE",
          dateTimeRenderOption: "FORMATTED_STRING"
        });
        const valuesResult = await googleApiRequest(
          user.id, connection.id,
          "https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(spreadsheet.id) +
          "/values/" + encodeURIComponent(range) + "?" + valuesQuery.toString()
        );
        const rows = Array.isArray(valuesResult?.values) ? valuesResult.values.slice(0, 1000) : [];
        if (!rows.length) {
          return calendarDirect(res, "「" + spreadsheet.name + "」の「" + tab + "」シートは空です。", "指定したシートにデータはありません。");
        }

        if (analyticalQuestion && rows.length > 1) {
          const headers = rows[0].map(value => String(value || "").trim());
          const indexOfHeader = (...names) => headers.findIndex(header => names.includes(header));
          const dateIndex = indexOfHeader("販売日", "日付", "購入日");
          const qtyIndex = indexOfHeader("数量", "個数", "販売数量");
          const priceIndex = indexOfHeader("販売価格", "売上", "売上金額");
          const totalSalesIndex = indexOfHeader("合計売上", "総売上", "総売上額");
          const isSalesManagement = totalSalesIndex >= 0 &&
            (spreadsheetName === "売上管理" || indexOfHeader("技術売上") >= 0 || indexOfHeader("指名料") >= 0);
          const profitIndex = indexOfHeader("利益", "粗利益", "利益額");
          const monthMatch = userText.match(/(\d{1,2})月/);
          const now = new Date();
          const wantedMonth = monthMatch ? Number(monthMatch[1]) : /先月/.test(userText) ? (now.getMonth() || 12) : now.getMonth() + 1;
          const wantedYear = /去年|昨年/.test(userText) ? now.getFullYear() - 1 : now.getFullYear();
          const useDateFilter = /今月|先月|今年|去年|昨年|\d{1,2}月|月別/.test(userText);
          const parseNumber = value => {
            if (value === undefined || value === null || value === "") return 0;
            const parsed = Number(String(value).replace(/[¥￥,\s]/g, "").replace(/円/g, ""));
            return Number.isFinite(parsed) ? parsed : 0;
          };
          const parseMonth = value => {
            const s = String(value || "").trim();
            const full = s.match(/(20\d{2})[年\/-](\d{1,2})[月\/-](\d{1,2})/);
            if (full) return { year: Number(full[1]), month: Number(full[2]) };
            const jp = s.match(/(\d{1,2})月\s*(\d{1,2})日/);
            if (jp) return { year: wantedYear, month: Number(jp[1]) };
            const short = s.match(/^(\d{1,2})[\/-](\d{1,2})$/);
            if (short) return { year: wantedYear, month: Number(short[1]) };
            return null;
          };
          let dataRows = rows.slice(1).filter(row => {
            const hasInput = row.some((value, index) =>
              index !== totalSalesIndex && String(value ?? "").trim() !== ""
            );
            const hasNonZeroCalculatedSales = totalSalesIndex >= 0 &&
              parseNumber(row[totalSalesIndex]) !== 0;
            return hasInput || hasNonZeroCalculatedSales;
          });
          if (useDateFilter && dateIndex >= 0) {
            dataRows = dataRows.filter(row => {
              const date = parseMonth(row[dateIndex]);
              if (!date) return false;
              if (/今年|去年|昨年/.test(userText) && date.year !== wantedYear) return false;
              if (/今月|先月|\d{1,2}月/.test(userText) && date.month !== wantedMonth) return false;
              return true;
            });
          }
          const totalSales = dataRows.reduce((sum, row) => {
            if (isSalesManagement) {
              return sum + parseNumber(row[totalSalesIndex]);
            }
            if (priceIndex < 0) return sum;
            const price = parseNumber(row[priceIndex]);
            const quantity = qtyIndex < 0 ? 1 : parseNumber(row[qtyIndex]);
            return sum + price * quantity;
          }, 0);
          const totalProfit = dataRows.reduce((sum, row) => sum + (profitIndex < 0 ? 0 : parseNumber(row[profitIndex])), 0);
          const totalQty = dataRows.reduce((sum, row) => sum + (qtyIndex < 0 ? 0 : parseNumber(row[qtyIndex])), 0);
          const yen = value => Math.round(value).toLocaleString("ja-JP") + "円";
          const period = useDateFilter ? (monthMatch ? wantedMonth + "月" : /先月/.test(userText) ? "先月" : /今年|去年|昨年/.test(userText) ? wantedYear + "年" : "今月") : "全期間";
          const lines = ["集計対象：「" + spreadsheet.name + "」/「" + tab + "」/ " + period, "対象データ件数：" + dataRows.length + "件"];
          if (/(?:利益率)/.test(userText)) {
            if ((isSalesManagement ? totalSalesIndex : priceIndex) < 0 || profitIndex < 0) {
              lines.push("利益率：必要な列（売上・利益）が見つからないため算出できません。");
            } else if (totalSales === 0) {
              lines.push("利益率：売上合計が0円のため算出できません。");
            } else {
              lines.push("売上合計：" + yen(totalSales), "利益合計：" + yen(totalProfit), "利益率：" + (totalProfit / totalSales * 100).toFixed(1) + "%");
            }
          } else if (/(?:利益)/.test(userText)) {
            lines.push(profitIndex < 0 ? "利益列が見つからないため算出できません。" : "利益合計：" + yen(totalProfit));
          } else if (/(?:売上|いくら|合計)/.test(userText)) {
            lines.push((isSalesManagement ? totalSalesIndex : priceIndex) < 0 ? "売上列が見つからないため算出できません。" : "売上合計：" + yen(totalSales));
          }
          if (/(?:何個|数量|個数)/.test(userText)) lines.push("数量合計：" + totalQty.toLocaleString("ja-JP") + "個");
          if (/(?:何件|件数)/.test(userText)) lines.push("データ件数：" + dataRows.length + "件");
          lines.push("注：" + (isSalesManagement ? "売上管理は「合計売上」列を直接合算しています。" : "店販管理は「販売価格×数量」で売上を集計しています。") + "数式のみの空行は件数から除外しています。日付に年がない行は指定年のデータとみなします。");
          return calendarDirect(res, lines.join("\n"), "スプレッドシートを集計しました。");
        }

        const formattedRows = rows.slice(0, 20).map(row => row.map(cell => String(cell ?? "").slice(0, 200)).join(" | "));
        const resultText = "Google Sheets読み取り結果： " + spreadsheet.name + " / " + tab + "\n" +
          formattedRows.join("\n") +
          (rows.length >= 20 ? "\n（先頭20行を表示。必要なら範囲を指定してください）" : "");
        return calendarDirect(res, resultText, "スプレッドシートの内容を取得しました。");
      } catch (error) {
        console.error("Google Sheets read/analysis failed", {
          name: error?.name || "Error",
          status: Number.isInteger(error?.status) ? error.status : undefined,
          code: typeof error?.code === "string" ? error.code : undefined
        });
        return calendarDirect(res, "Google Sheetsの読み取りに失敗しました。Google接続状態とファイル名を確認してください。", "スプレッドシートを読み取れませんでした。");
      }
    }

    // Calendar confirmation uses intent categories, not a fixed list of phrases.
    const actionToken=req.body?.pendingCalendarAction;
    let pendingAction=verifyCalendarAction(actionToken,user.id);
    if(actionToken && !pendingAction){
      return calendarDirect(res,"確認情報が無効か期限切れです。もう一度依頼してください。","確認情報が無効か期限切れです。",{pendingCalendarAction:null});
    }
    let intent="unclear";
    if(actionToken) intent=await classifyCalendarIntent(geminiKey,userText,pendingAction);
    if(actionToken && intent==="reject"){
      return calendarDirect(res,"操作をキャンセルしました。カレンダーは変更していません。","操作をキャンセルしました。",{pendingCalendarAction:null});
    }
    if(actionToken && intent==="modify"){
      const pendingEvent=pendingAction?.action==="create" ? pendingAction.event : pendingAction?.action==="update" ? pendingAction.patch : null;
      const baseStart=pendingEvent?.start?.dateTime;
      if(pendingEvent && baseStart){
        const dateLocal=new Date(Date.parse(baseStart)+9*3600000);
        const date=new Date(Date.UTC(dateLocal.getUTCFullYear(),dateLocal.getUTCMonth(),dateLocal.getUTCDate()));
        const correctedTime=calendarTime(userText,date);
        if(correctedTime){
          if(pendingAction.action==="create") pendingAction.event={...pendingAction.event,...correctedTime};
          else pendingAction.patch={...pendingAction.patch,...correctedTime};
          const revised=signCalendarAction(pendingAction);
          const start=new Date(Date.parse(correctedTime.start.dateTime)+9*3600000);
          const end=new Date(Date.parse(correctedTime.end.dateTime)+9*3600000);
          const fmt=x=>String(x.getUTCHours()).padStart(2,"0")+":"+String(x.getUTCMinutes()).padStart(2,"0");
          return calendarDirect(res,"時刻を"+fmt(start)+"〜"+fmt(end)+"に変更しました。ほかの内容はそのままです。この内容で実行してよろしいですか？","時刻を"+fmt(start)+"から"+fmt(end)+"に変更しました。この内容でよろしいですか？",{pendingCalendarAction:revised});
        }
      }
      return calendarDirect(res,"変更したい内容を確認させてください。日時や予定名など、変更点をお伝えください。","変更したい内容をお伝えください。",{pendingCalendarAction:actionToken});
    }
    if(actionToken && intent==="defer"){
      return calendarDirect(res,"承知しました。操作は実行せず保留します。","操作は実行せず保留します。",{pendingCalendarAction:actionToken});
    }
    if(actionToken && (intent==="question" || intent==="unclear")){
      return calendarDirect(res,"まだ実行していません。実行するか、中止するか、内容を変更するかをお伝えください。","まだ実行していません。ご希望をお伝えください。",{pendingCalendarAction:actionToken});
    }
    if(actionToken && intent==="approve"){
      try{
        const cs=await listConnectionsForUser(user.id),c=Array.isArray(cs)?cs.find(x=>x?.status==="connected"):null;
        if(!c?.id)return calendarDirect(res,"Googleカレンダーが未接続です。","Googleカレンダーが未接続です。",{pendingCalendarAction:null});
        const base="https://www.googleapis.com/calendar/v3/calendars/primary/events";
        if(pendingAction.action==="create"){
          const e=await googleApiRequest(user.id,c.id,base,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(pendingAction.event)});
          return calendarDirect(res,"「"+e.summary+"」をGoogleカレンダーに登録しました。","予定を登録しました。",{pendingCalendarAction:null});
        }
        if(pendingAction.action==="update"){
          await googleApiRequest(user.id,c.id,base+"/"+encodeURIComponent(pendingAction.eventId),{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(pendingAction.patch)});
          return calendarDirect(res,"「"+pendingAction.title+"」の予定を変更しました。","予定を変更しました。",{pendingCalendarAction:null});
        }
        if(pendingAction.action==="delete"){
          await googleApiRequest(user.id,c.id,base+"/"+encodeURIComponent(pendingAction.eventId),{method:"DELETE"});
          return calendarDirect(res,"「"+pendingAction.title+"」の予定を削除しました。","予定を削除しました。",{pendingCalendarAction:null});
        }
        return calendarDirect(res,"確認対象を判定できません。もう一度依頼してください。","確認対象を判定できません。",{pendingCalendarAction:null});
      }catch(e){console.error("Calendar action failed",{name:e?.name||"Error",status:e?.status});return calendarDirect(res,"Googleカレンダーの操作に失敗しました。カレンダーを確認してください。","Googleカレンダーの操作に失敗しました。",{pendingCalendarAction:null})}
    }
    
    const title=calendarQuotedTitle(userText) || (() => {
      let candidate=userText
        .replace(/20\d{2}年\d{1,2}月\d{1,2}日/g," ")
        .replace(/明後日|あさって|明日|あした|今日|本日/g," ")
        .replace(/\d{1,2}時(?:\d{1,2}分)?(?:から|〜|～|-)\s*\d{1,2}時(?:\d{1,2}分)?/g," ")
        .replace(/\d{1,2}時(?:\d{1,2}分)?/g," ")
        .replace(/(?:予定|スケジュール|カレンダー)(?:を|に|の)?|(?:入れておいて|入れといて|入れて|入れてください|追加しました|追加して|追加|登録しました|登録して|登録|作って|作成して|変更して|ずらして|削除して|取り消して|消して|予約して|押さえて|組んで|教えて|お願いします|も|もお願い)/g," ")
        .replace(/[「」『』"“”、。,.！!？?]/g," ")
        .replace(/^[\sにのをはがでとへからまで]+|[\sにのをはがでとへからまで]+$/g," ")
        .replace(/\s+/g," ").trim();
      return candidate.length>0 && candidate.length<=200 ? candidate : null;
    })();
    const addVerb=/(?:入れて|入れといて|入れておいて|追加して|追加|登録して|登録|作って|作成して|予定にして|スケジュールして|予約して|押さえて|組んで)/.test(userText);
    const hasDateOrTime=!!calendarDate(userText)||/\d{1,2}時/.test(userText);
    const creating=/(?:予定|スケジュール|カレンダー).*(?:入れて|入れといて|入れておいて|追加|登録|作って|作成)|(?:入れて|入れといて|入れておいて|追加して|登録して|予約して|押さえて).*(?:予定|スケジュール|カレンダー)/.test(userText)||(addVerb&&hasDateOrTime);
    const updating=/(?:予定|スケジュール|カレンダー).*(?:変更|ずらして|時間を変)|(?:変更|ずらして).*(?:予定|スケジュール|カレンダー)/.test(userText);
    const deleting=/(?:予定|スケジュール|カレンダー).*(?:削除|消して|取り消して)|(?:削除|消して|取り消して).*(?:予定|スケジュール|カレンダー)/.test(userText);
    if(creating||updating||deleting){
      try{
        const cs=await listConnectionsForUser(user.id),c=Array.isArray(cs)?cs.find(x=>x?.status==="connected"):null;
        if(!c?.id)return calendarDirect(res,"Googleカレンダーが未接続です。先に接続してください。","Googleカレンダーが未接続です。");
        const base="https://www.googleapis.com/calendar/v3/calendars/primary/events";
        if(creating){
          const d=calendarDate(userText),t=d&&calendarTime(userText,d);
          if(!title||!d||!t)return calendarDirect(res,"予定名を「」で囲み、今日・明日・明後日または年月日と、開始・終了時刻を指定してください。例：明日「買い物」を10時から11時で予定に入れて。","予定名、日付、開始・終了時刻を指定してください。");
          const token=signCalendarAction({userId:user.id,action:"create",event:{summary:title,...t}});
          const startLocal=new Date(Date.parse(t.start.dateTime)+9*3600000);
          const endLocal=new Date(Date.parse(t.end.dateTime)+9*3600000);
          const fmt=x=>String(x.getUTCHours()).padStart(2,"0")+":"+String(x.getUTCMinutes()).padStart(2,"0");
          return calendarDirect(res,"次の内容で登録します：『"+title+"』、"+d.toISOString().slice(0,10)+"、"+fmt(startLocal)+"〜"+fmt(endLocal)+"。実行してよろしいですか？「はい」または「キャンセル」とお答えください。","予定を登録します。"+title+"、"+fmt(startLocal)+"から"+fmt(endLocal)+"です。よろしいですか？",{pendingCalendarAction:token});
        }
        if(!title)return calendarDirect(res,"対象の予定名を「」で指定してください。","対象の予定名を「」で指定してください。");
        const now=new Date(),params=new URLSearchParams({timeMin:now.toISOString(),timeMax:new Date(now.getTime()+180*86400000).toISOString(),singleEvents:"true",orderBy:"startTime",maxResults:"100",q:title});
        const result=await googleApiRequest(user.id,c.id,base+"?"+params.toString()),matches=(result.items||[]).filter(e=>e.summary===title);
        if(matches.length!==1)return calendarDirect(res,matches.length?"同じ名前の予定が複数あります。日付を指定してください。":"該当する予定が見つかりませんでした。","対象の予定を特定できませんでした。");
        const e=matches[0];
        if(deleting){const token=signCalendarAction({userId:user.id,action:"delete",eventId:e.id,title:e.summary});return calendarDirect(res,"「"+e.summary+"」を削除します。日時："+(e.start?.dateTime||e.start?.date||"不明")+"。よろしいですか？「はい」または「キャンセル」とお答えください。","予定を削除します。よろしいですか？",{pendingCalendarAction:token})}
        const d=calendarDate(userText),t=d&&calendarTime(userText,d);
        if(!t)return calendarDirect(res,"変更後の日付と開始・終了時刻を指定してください。例：「"+title+"」を明日10時から11時に変更して。","変更後の日付と開始・終了時刻を指定してください。");
        const token=signCalendarAction({userId:user.id,action:"update",eventId:e.id,title:e.summary,patch:t});
        return calendarDirect(res,"「"+e.summary+"」を"+d.toISOString().slice(0,10)+"の指定時刻に変更します。よろしいですか？「はい」または「キャンセル」とお答えください。","予定を変更します。よろしいですか？",{pendingCalendarAction:token});
      }catch(e){console.error("Calendar proposal failed",{name:e?.name||"Error",status:e?.status});return calendarDirect(res,"Googleカレンダーの予定を確認できませんでした。","Googleカレンダーの予定を確認できませんでした。")}
    }

    // ユーザーの発言内容はログに出力しない。

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
      (keyword) => userText.includes(keyword)
    );

    console.log(
      "[DEBUG] Weather question:",
      isWeatherQuestion
    );

    // ==========================================
    // News Detection
    // ==========================================

    const newsKeywords = [
      "ニュース",
      "最新ニュース",
      "今日のニュース",
      "最近のニュース",
      "速報",
      "報道",
      "ニュース記事",
      "最新情報",
    ];

    const isNewsQuestion = newsKeywords.some(
      (keyword) => userText.includes(keyword)
    );

    console.log(
      "[DEBUG] News question:",
      isNewsQuestion
    );

    // ==========================================
    // Search Detection
    // ==========================================

    const searchKeywords = [
      "調べて",
      "検索して",
      "探して",
      "おすすめ",
      "最新",
      "現在",
      "詳しく",
      "情報",
      "サイト",
      "公式",
    ];

    const isSearchQuestion =
      isWeatherQuestion ||
      isNewsQuestion ||
      searchKeywords.some(
        (keyword) => userText.includes(keyword)
      );

    console.log(
      "[DEBUG] Search question:",
      isSearchQuestion
    );

    // ==========================================
    // Weather Search Query
    // ==========================================

    let searchQuery = userText;

    if (isWeatherQuestion) {
      let location = "札幌市";

      const locationPatterns = [
        /([一-龯ぁ-んァ-ヶ]+市)/,
        /([一-龯ぁ-んァ-ヶ]+区)/,
        /(東京|大阪|京都|名古屋|福岡|仙台|横浜|川崎|神戸|広島|千葉|埼玉|札幌|旭川|函館|帯広|釧路|小樽)/,
      ];

      for (const pattern of locationPatterns) {
        const match = userText.match(pattern);

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
        userText.includes("明後日") ||
        userText.includes("あさって")
      ) {
        day = "明後日";
      } else if (
        userText.includes("明日") ||
        userText.includes("あした")
      ) {
        day = "明日";
      } else if (userText.includes("今週")) {
        day = "今週";
      } else if (
        userText.includes("現在") ||
        userText.includes("今")
      ) {
        day = "現在";
      }

      searchQuery = `${location} 天気 ${day}`;

    }

    // ==========================================
    // News Search Query
    // ==========================================

    // ==========================================
    // Serper Search
    // ==========================================

    if (serperKey && isSearchQuestion) {
      console.log("[DEBUG] Serper: START");

      const serperStart = Date.now();

      try {
        const serperEndpoint = isNewsQuestion
          ? "https://google.serper.dev/news"
          : "https://google.serper.dev/search";

        console.log(
          "[DEBUG] Serper endpoint:",
          serperEndpoint
        );

        const response = await fetch(
          serperEndpoint,
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
              num:
                isWeatherQuestion || isNewsQuestion
                  ? 10
                  : 8,
            }),
          }
        );

        const serperDuration =
          Date.now() - serperStart;

        console.log(
          "[DEBUG] Serper HTTP status:",
          response.status
        );

        await logApiUsage({
          provider: "serper",
          service: isNewsQuestion
            ? "news"
            : "search",
          success: response.ok,
          statusCode: response.status,
          durationMs: serperDuration,
          metadata: {
          }
        });

        if (response.ok) {
          const data = await response.json();

          const organicCount = Array.isArray(data.organic)
            ? data.organic.length
            : 0;

          const newsCount = Array.isArray(data.news)
            ? data.news.length
            : 0;

          console.log(
            "[DEBUG] Serper organic count:",
            organicCount
          );

          console.log(
            "[DEBUG] Serper news count:",
            newsCount
          );

          console.log(
            "[DEBUG] Serper answerBox:",
            !!data.answerBox
          );

          console.log(
            "[DEBUG] Serper knowledgeGraph:",
            !!data.knowledgeGraph
          );

          console.log(
            "[DEBUG] Serper weather:",
            !!data.weather
          );

          if (
            isNewsQuestion &&
            Array.isArray(data.news)
          ) {
            console.log(
              "[DEBUG] Serper first 3 news results:",
              data.news.slice(0, 3).map((result) => ({
                title: result?.title || "",
                url:
                  result?.link ||
                  result?.url ||
                  "",
                snippet:
                  result?.snippet ||
                  "",
                source:
                  result?.source ||
                  "",
                date:
                  result?.date ||
                  "",
              }))
            );
          }

          if (
            !isNewsQuestion &&
            Array.isArray(data.organic)
          ) {
            console.log(
              "[DEBUG] Serper first 3 results:",
              data.organic.slice(0, 3).map((result) => ({
                title: result?.title || "",
                url: result?.link || "",
                snippet: result?.snippet || "",
              }))
            );
          }

          // ==========================================
          // Search Context
          // ==========================================

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

          // ==========================================
          // News Results
          // ==========================================

          if (
            isNewsQuestion &&
            Array.isArray(data.news)
          ) {
            for (const result of data.news) {
              const url =
                result?.link ||
                result?.url ||
                "";

              if (!url) continue;

              const title =
                result.title || "";

              const snippet =
                result.snippet || "";

              const source =
                result.source || "";

              const date =
                result.date || "";

              sources.push({
                title,
                url,
                source:
                  source || "serper-news",
              });

              searchContext += `
[Serper News Result]
Title: ${title}
Source: ${source}
Date: ${date}
URL: ${url}
Snippet: ${snippet}
`;
            }
          }

          // ==========================================
          // Normal Organic Results
          // ==========================================

          if (
            !isNewsQuestion &&
            Array.isArray(data.organic)
          ) {
            for (const result of data.organic) {
              if (!result?.link) continue;

              const title =
                result.title || "";

              const url =
                result.link;

              const snippet =
                result.snippet || "";

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

          console.log(
            "[DEBUG] SearchContext length after Serper:",
            searchContext.length
          );

          console.log(
            "[DEBUG] Sources count after Serper:",
            sources.length
          );
        } else {
          console.error(
            "[DEBUG] Serper HTTP error:",
            response.status
          );
        }
      } catch (error) {
        const serperDuration =
          Date.now() - serperStart;

        await logApiUsage({
          provider: "serper",
          service: isNewsQuestion
            ? "news"
            : "search",
          success: false,
          statusCode: null,
          durationMs: serperDuration,
          metadata: {
            error: "request_failed"
          }
        });

        console.error("[DEBUG] Serper search failed", {
          name: error?.name || "Error"
        });
      }
    } else {
      console.log(
        "[DEBUG] Serper: API key not configured"
      );
    }

    // ==========================================
    // Tavily Fallback
    // ==========================================

if (
  (!searchContext || isWeatherQuestion && !searchContext.includes("[Serper Weather]")) &&
  tavilyKey &&
  isSearchQuestion
) {

      console.log(
        "[DEBUG] Tavily fallback: START"
      );

      const tavilyStart = Date.now();

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
              search_depth:
                isWeatherQuestion || isNewsQuestion
                  ? "advanced"
                  : "basic",
              max_results:
                isWeatherQuestion || isNewsQuestion
                  ? 8
                  : 5,
              include_answer: true,
              include_raw_content: false,
            }),
          }
        );

        const tavilyDuration =
          Date.now() - tavilyStart;

        console.log(
          "[DEBUG] Tavily HTTP status:",
          response.status
        );

        await logApiUsage({
          provider: "tavily",
          service: "search",
          success: response.ok,
          statusCode: response.status,
          durationMs: tavilyDuration,
          metadata: {
            fallback: true
          }
        });

        if (response.ok) {
          const data = await response.json();

          const tavilyResultCount =
            Array.isArray(data.results)
              ? data.results.length
              : 0;

          console.log(
            "[DEBUG] Tavily result count:",
            tavilyResultCount
          );

          console.log(
            "[DEBUG] Tavily answer:",
            !!data.answer
          );

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

          console.log(
            "[DEBUG] SearchContext length after Tavily:",
            searchContext.length
          );

          console.log(
            "[DEBUG] Sources count after Tavily:",
            sources.length
          );
        } else {
          console.error(
            "[DEBUG] Tavily HTTP error:",
            response.status
          );
        }
      } catch (error) {
        const tavilyDuration =
          Date.now() - tavilyStart;

        await logApiUsage({
          provider: "tavily",
          service: "search",
          success: false,
          statusCode: null,
          durationMs: tavilyDuration,
          metadata: {
            fallback: true,
            error:
              error?.message ||
              "Unknown error"
          }
        });

        console.error("[DEBUG] Tavily search failed", {
          name: error?.name || "Error"
        });
      }
    } else if (!searchContext) {
      console.log(
        "[DEBUG] Tavily fallback: NOT USED"
      );
    }

    // ==========================================
    // Final Search Debug
    // ==========================================

    console.log(
      "[DEBUG] Final searchContext length:",
      searchContext.length
    );

    console.log(
      "[DEBUG] Final sources count:",
      sources.length
    );

    // ==========================================
    // Google Calendar conversational read
    // ==========================================

    let calendarContext = "";
    const isCalendarQuestion = /予定|カレンダー|スケジュール/.test(userText) &&
      /(教えて|確認|何が|何件|ある|入って|予定は|見せて|一覧|空いて|いつ|今日|明日|あさって|今週|来週|今月|来月|月曜日|火曜日|水曜日|木曜日|金曜日|土曜日|日曜日|月曜|火曜|水曜|木曜|金曜|土曜|日曜)/.test(userText);

    if (isCalendarQuestion) {
      try {
        const connections = await listConnectionsForUser(user.id);
        const connection = Array.isArray(connections)
          ? connections.find(item => item?.status === "connected")
          : null;

        if (!connection?.id) {
          calendarContext = "Google Calendar連携は未接続です。ユーザーに接続が必要と伝えてください。";
        } else {
          const japanNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
          const today = japanNow.toISOString().slice(0, 10);
          const dayOffset = userText.includes("あさって") || userText.includes("明後日") ? 2
            : userText.includes("明日") || userText.includes("あした") ? 1 : 0;
          const toLocalDate = (date) => date.toISOString().slice(0, 10);
          let startDate = new Date(Date.parse(today + "T00:00:00Z") + dayOffset * 86400000);
          let endDate = new Date(startDate.getTime() + 86400000);
          let rangeLabel = dayOffset === 2 ? "明後日" : dayOffset === 1 ? "明日" : "今日";

          if (userText.includes("今週") || userText.includes("来週")) {
            const mondayOffset = (japanNow.getUTCDay() + 6) % 7;
            startDate = new Date(Date.parse(today + "T00:00:00Z") + (userText.includes("来週") ? 7 - mondayOffset : -mondayOffset) * 86400000);
            endDate = new Date(startDate.getTime() + 7 * 86400000);
            rangeLabel = userText.includes("来週") ? "来週" : "今週";
          } else if (userText.includes("今月") || userText.includes("来月")) {
            const year = japanNow.getUTCFullYear();
            const month = japanNow.getUTCMonth() + (userText.includes("来月") ? 1 : 0);
            startDate = new Date(Date.UTC(year, month, 1));
            endDate = new Date(Date.UTC(year, month + 1, 1));
            rangeLabel = userText.includes("来月") ? "来月" : "今月";
          }

          const timeMin = new Date(Date.parse(toLocalDate(startDate) + "T00:00:00+09:00")).toISOString();
          const timeMax = new Date(Date.parse(toLocalDate(endDate) + "T00:00:00+09:00")).toISOString();
          const result = await googleApiRequest(
            user.id,
            connection.id,
            "https://www.googleapis.com/calendar/v3/calendars/primary/events?" +
              new URLSearchParams({ timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: "100" }).toString()
          );
          const events = Array.isArray(result?.items) ? result.items : [];
          const summarized = events.slice(0, 100).map(event => ({
            title: typeof event.summary === "string" ? event.summary : "(タイトルなし)",
            start: event.start?.dateTime || event.start?.date || "",
            end: event.end?.dateTime || event.end?.date || "",
            allDay: Boolean(event.start?.date && !event.start?.dateTime)
          }));
          calendarContext = "Google Calendarから取得した実データです。期間: " + rangeLabel +
            " (" + toLocalDate(startDate) + "〜" + toLocalDate(new Date(endDate.getTime() - 86400000)) +
            ")。予定件数: " + events.length + "。予定一覧: " + JSON.stringify(summarized);
        }
      } catch (error) {
        console.error("Google Calendar conversational read failed", {
          name: error?.name || "Error",
          code: typeof error?.code === "string" ? error.code : undefined
        });
        calendarContext = "Google Calendarから予定を取得できませんでした。取得に失敗したことをユーザーに伝え、予定を推測しないでください。";
      }
    }

    // ==========================================
    // Gemini Input
    // ==========================================

    let geminiInput = `
${calendarContext ? `\n==============================\nGOOGLE CALENDAR RESULTS\n==============================\n${calendarContext}\n\n予定の質問には上記の実データを使い、Asia/Tokyoの日本時間に直して簡潔に答えてください。予定を捏造しないでください。\n` : ""}

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
- ユーザーの名前を毎回の返答に入れない
- 文末に名前を付けることを禁止する
- ユーザーの名前を使った定型的な開始を避ける
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

==============================
SPEECH TEXT
==============================

回答とは別に、TTSで読み上げるためのspeechTextを作成してください。

- replyとspeechTextの内容は完全に同じ意味にしてください。
- speechTextでは、読み間違えやすい固有名詞・店名・地名・人名などを、正しい読みになるようにひらがなへ補正してください。
- 通常の日本語までひらがなに変換しないでください。
- 表記として重要な漢字はreply側に残してください。
- speechTextには説明、注釈、括弧、読み方の説明を追加しないでください。
- replyに存在しない情報をspeechTextへ追加しないでください。

例：

reply:
麺屋彩未は札幌市豊平区にある人気店です。

speechText:
麺屋さいみは札幌市豊平区にある人気店です。

speechTextは音声読み上げ専用の文章とする。

・漢字の読み間違いが起きそうな語句は、正しい読み方をひらがなで表記する。
・地名、人名、施設名は、文脈から正しい読み方を判断する。
・気温などの数値に付く「℃」は「度」に変換する。
・文章全体を不自然にひらがなにせず、読み間違いを防ぐ必要がある部分だけ補正する。
・元の文章の意味や情報を変更・追加しない。
・画面表示用のreplyは変更せず、speechTextだけを補正する。

==============================
LONG-TERM MEMORY
==============================

以下は現在サインインしているユーザーについて保存されている長期記憶です。
今回の会話に関連する場合のみ自然に利用してください。
記憶にないことは推測しないでください。

${typeof memoryContext === "string" && memoryContext.trim()
    ? memoryContext.trim()
    : "現在、登録されている長期記憶はありません。"
}

==============================
LONG-TERM MEMORY RULES
==============================

今後の会話でも長期的に役立つ情報、またはユーザーが明示的に
「覚えて」「記憶して」などと求めた情報は保存対象として扱ってください。

一時的な発言、雑談、その場限りの情報は保存しないでください。

保存する場合：
- memory.shouldSave = true
- memory.content は簡潔な事実
- category は personal / preference / work / family / goal のいずれか
- importance は 1〜5

保存しない場合：
- memory.shouldSave = false
- memory.content は空文字列でも構いません

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
    // News Response Rules
    // ==========================================

    if (isNewsQuestion) {
      geminiInput += `

==============================
NEWS RESPONSE RULES
==============================

これはニュース関連の質問です。

- Serper News APIから取得したニュース結果を優先してください。
- ニュースのタイトル、媒体、日時、内容を確認してください。
- 質問に関連するニュースだけを使用してください。
- 複数の記事がある場合は内容を比較してください。
- ニュース結果に存在しない内容を事実として補完しないでください。
- 「最新」「今日」など時間依存の質問では、記事の日付を確認してください。
- ニュース記事をそのまま読み上げないでください。
- 必要な情報を整理して、J.A.R.V.I.S.として自然に回答してください。
- ニュースキャスターのような話し方をしないでください。
- 不要な感想や評価を追加しないでください。
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

    geminiInput += `

==============================
OPTIONAL VISUALIZATION
==============================

必要な場合だけ、回答内容を補助する visualization を返してください。
通常の会話・短い回答では type を "none" にしてください。
比較・推移など複数の数値がある場合は "bar" または "line" を使ってください。
割合・構成比は "pie" または "donut"、順序や処理の流れは "flowchart"、部品や要素の関係は "structure"、概念的な配置図・簡易図面は "blueprint"、達成率など0〜100の割合は "gauge"、複数項目の数値比較・順位付けは "matrix" を使ってください。
構造・手順・因果関係を整理すると理解しやすい場合は "diagram" も使えます。
数値や手順を推測で作らないでください。根拠となるデータがなければ図表を出さないでください。
labels は短い項目名、values は labels と同じ数の数値、steps は図解の順序を示す短い文字列です。
bar / line / pie / donut / matrix では labels と values を2〜6個にしてください。diagram / flowchart では steps を2〜6個にしてください。structure / blueprint では labels を3〜6個にしてください。gauge では values の先頭に0〜100の値を1つ入れてください。
blueprint は寸法精度を保証する設計図ではなく、説明用の概念配置図として使ってください。
visualization は画面表示専用です。reply と speechText は通常どおり自然な文章にし、図表の説明を読み上げ用文章へ詰め込まないでください。
`;

    // ==========================================
    // Commander specialist advisory (after context retrieval)
    // ==========================================

    // Keep Gemini as the final response composer so the existing interaction ID,
    // memory-save contract, speechText, and visualization pipeline remain intact.
    // The specialist receives the actual user request plus retrieved, relevant context.
    const {
      taskText: autoTaskText,
      eligible: autoCommanderEligible,
      provider: configuredAutoProvider,
      classification: autoCommanderClassification
    } = getAutoCommanderConfig({
      autoCommander: req.body && req.body.autoCommander,
      text: userText
    });

    if (autoCommanderEligible && configuredAutoProvider) {
      if (!(await enforceRateLimit(res, user, "auto-commander-minute", 1, 60))) return;
      if (!(await enforceRateLimit(res, user, "auto-commander-day", 5, 86400))) return;

      {
        try {
          const specialistContext = [
            "User request:",
            autoTaskText,
            calendarContext ? "\nRetrieved Google Calendar data:\\n" + calendarContext : "",
            searchContext ? "\nRetrieved web search results:\\n" + searchContext : "",
            typeof memoryContext === "string" && memoryContext.trim()
              ? "\nRelevant long-term memory:\\n" + memoryContext.trim()
              : ""
          ].filter(Boolean).join("\n");

          const result = await runAiCouncil({
            userInput: specialistContext.slice(0, 24000),
            systemInstruction: "You are J.A.R.V.I.S.'s specialist analyst. Analyze the supplied request using only the supplied context. Do not invent missing data or claim to execute external actions. State uncertainty and provide a concise, actionable analysis.",
            providers: [configuredAutoProvider],
            timeoutMs: 20000,
            maxOutputTokens: 1200
          });

          const specialistText = result.results
            .filter(item => item.ok && typeof item.text === "string" && item.text.trim())
            .map(item => "【専門AIの分析 / " + item.provider + "】\\n" + item.text)
            .join("\n\\n");

          if (specialistText) {
            const geminiInputLengthBeforeAdvisory = geminiInput.length;
            geminiInput += "\n\\n==============================\\nSPECIALIST ADVISORY\\n==============================\\n以下は司令官が選択した専門AIの分析です。元の依頼と取得済みデータを照合し、必要なら不確実性や不足情報を明示したうえで、J.A.R.V.I.S.として最終回答を作成してください。専門AIの内容を無条件に正しいものとして扱わず、根拠のない情報は採用しないでください。\\n\\n" + specialistText;
            console.info("[COMMANDER] Specialist advisory appended to Gemini input", {
              provider: configuredAutoProvider,
              advisoryChars: specialistText.length,
              geminiInputCharsBefore: geminiInputLengthBeforeAdvisory,
              geminiInputCharsAfter: geminiInput.length,
              appended: geminiInput.length > geminiInputLengthBeforeAdvisory
            });
          } else {
            console.warn("Automatic commander returned no usable advisory", {
              provider: configuredAutoProvider,
              intent: autoCommanderClassification?.intent
            });
          }
        } catch (error) {
          const code = typeof error?.code === "string" ? error.code : "INTERNAL_ERROR";
          console.error("Automatic commander advisory failed; continuing with Gemini", { code });
          // Specialist failure must not prevent the existing Gemini response path.
        }
      }
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

            speechText: {
              type: "string",
            },

            visualization: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["none", "bar", "line", "diagram", "pie", "donut", "flowchart", "structure", "blueprint", "gauge", "matrix"] },
                title: { type: "string" },
                labels: { type: "array", items: { type: "string" } },
                values: { type: "array", items: { type: "number" } },
                steps: { type: "array", items: { type: "string" } }
              },
              required: ["type", "title", "labels", "values", "steps"]
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
            "speechText",
            "memory",
            "visualization",
          ],
        },
      },
    };

    // ==========================================
    // Conversation Context
    // ==========================================

    const hasPreviousInteractionId =
      typeof previousInteractionId === "string" &&
      previousInteractionId.length > 0;

    if (hasPreviousInteractionId) {
      requestBody.previous_interaction_id = previousInteractionId;
    }

    // Diagnostic only: never log or expose the interaction ID itself.
    console.log("[CONVERSATION] Request continuity", {
      hasPreviousInteractionId,
      previousInteractionIdLength: hasPreviousInteractionId ? previousInteractionId.length : 0
    });

    // ==========================================
    // Gemini Debug
    // ==========================================

    console.log(
      "[DEBUG] Gemini input searchContext length:",
      searchContext.length
    );

    console.log(
      "[DEBUG] Gemini request: START"
    );

    // ==========================================
    // Gemini Interactions API
    // ==========================================

    const controller = new AbortController();

    const geminiTimeout = setTimeout(
      () => controller.abort(),
      120000
    );

    const geminiStart = Date.now();

    let response;

    try {
      response = await fetch(
        "https://generativelanguage.googleapis.com/v1/interactions",
        {
          method: "POST",

          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": geminiKey,
          },

          body: JSON.stringify(requestBody),

          signal: controller.signal,
        }
      );
    } catch (error) {
      const geminiDuration =
        Date.now() - geminiStart;

      await logApiUsage({
        provider: "gemini",
        service: "generation",
        success: false,
        statusCode: null,
        durationMs: geminiDuration,
        metadata: {
          error: "request_failed"
        }
      });

      if (error.name === "AbortError") {
        return res.status(504).json({
          error: "Gemini request timed out",
        });
      }

      console.error("Gemini network request failed", {
        name: error?.name || "Error"
      });

      return res.status(502).json({
        error: "Gemini connection failed",
      });
    } finally {
      clearTimeout(geminiTimeout);
    }

    const geminiDuration =
      Date.now() - geminiStart;

    await logApiUsage({
      provider: "gemini",
      service: "generation",
      success: response.ok,
      statusCode: response.status,
      durationMs: geminiDuration,
      metadata: {
        model: "gemini-3.6-flash"
      }
    });

    const data = await response.json();

    console.log(
      "[DEBUG] Gemini HTTP status:",
      response.status
    );

    if (!response.ok) {
      console.error("Gemini API request failed", {
        status: response.status
      });

      return res.status(502).json({
        error: "Gemini request failed",
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
      console.error("Gemini response contained no output text");
      return res.status(502).json({
        error: "No valid response from Gemini",
      });
    }

    // ==========================================
    // JSON Parse
    // ==========================================

    let result;

    try {
      result = JSON.parse(outputText);
    } catch (error) {
      console.error("Gemini returned invalid JSON output");

      return res.status(502).json({
        error: "Gemini returned an invalid response",
      });
    }

    // ==========================================
    // Validation
    // ==========================================

    if (
      !result.reply ||
      !result.speechText ||
      !result.memory ||
      !result.visualization ||
      !["none", "bar", "line", "diagram", "pie", "donut", "flowchart", "structure", "blueprint", "gauge", "matrix"].includes(result.visualization.type) ||
      typeof result.memory.shouldSave !==
        "boolean"
    ) {
      console.error("Gemini response structure validation failed");
      return res.status(502).json({
        error: "Gemini returned an invalid response",
      });
    }

    // ==========================================
    // Interaction ID
    // ==========================================

    const interactionId =
      typeof data.id === "string" && data.id.length > 0
        ? data.id
        : null;

    // Diagnostic only: record presence, not the ID value.
    console.log("[CONVERSATION] Response continuity", {
      hasInteractionId: Boolean(interactionId),
      responseStatus: response.status
    });

    // ==========================================
    // Response
    // ==========================================

    return res.status(200).json({
      text: result.reply,
      speechText: result.speechText,
      visualization: result.visualization,
      interactionId,

  searchPerformed:
    isSearchQuestion &&
    searchContext.length > 0,

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
    console.error("Gemini handler failed", {
      name: error?.name || "Error"
    });

    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
};
