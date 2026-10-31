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

    // Spreadsheet agent v3: supports explicit plan creation and registered stable IDs.
    const sheetAgentIntent =
      /(?:スプレッドシート|シート|売上管理|店販管理)/.test(userText) &&
      /(?:完成させて|直して|修正して|修正計画|計画を作成|作成して|作って|構造を調べて|調査して|数式を確認|未完成|自分で作って|整えて|詳しく)/.test(userText) &&
      !/(?:書き込んで|書いて|更新して|追記して|追加して|変更して|削除して|実行して)/.test(userText);
    if (sheetAgentIntent) {
      try {
        const connections = await listConnectionsForUser(user.id);
        const connection = Array.isArray(connections) ? connections.find(item => item?.status === "connected") : null;
        if (!connection?.id) return calendarDirect(res, "Googleが未接続です。先にGoogle接続を行ってください。", "Googleが未接続です。");

        const spreadsheetName = /店販管理/.test(userText) ? "店販管理" : /売上管理/.test(userText) ? "売上管理" : null;
        if (!spreadsheetName) {
          return calendarDirect(res, "調査するファイル名を指定してください。「売上管理を詳しく調査して」と依頼できます。", "調査するスプレッドシート名を指定してください。");
        }
        const registry = await readSpreadsheetRegistry(user.id);
        const registered = spreadsheetName === "売上管理"
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
          const lastCol = isSummary ? "C" : "K";
          const maxRows = Math.max(20, Math.min(Number(props.gridProperties?.rowCount) || 100, isSummary ? 100 : 500));
          const range = "'" + title.replace(/'/g, "''") + "'!A1:" + lastCol + maxRows;
          const baseUrl = "https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(file.id) + "/values/" + encodeURIComponent(range);
          const [formulaResult, displayResult] = await Promise.all([
            googleApiRequest(user.id, connection.id, baseUrl + "?" + new URLSearchParams({valueRenderOption:"FORMULA",dateTimeRenderOption:"FORMATTED_STRING"})),
            googleApiRequest(user.id, connection.id, baseUrl + "?" + new URLSearchParams({valueRenderOption:"FORMATTED_VALUE",dateTimeRenderOption:"FORMATTED_STRING"}))
          ]);
          const formulaRows = Array.isArray(formulaResult?.values) ? formulaResult.values : [];
          const displayRows = Array.isArray(displayResult?.values) ? displayResult.values : [];
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
              }
              const shown = displayRows[r]?.[c];
              if (typeof shown === "string" && /^#(?:REF!|DIV\/0!|VALUE!|N\/A|NAME\?|NUM!|NULL!)/.test(shown)) {
                formulaErrors.push(colName(c) + (r+1) + "=" + shown);
              }
            }
          }
          const header = (formulaRows[0] || []).map((cell, i) => String(cell || "").trim() || "[" + colName(i) + "列]").join(" | ");
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
        if (/売上管理/.test(spreadsheetName)) {
          findings.push("集計シートの月別総売上は、8月がG2:G100とF101:F200、9月がG列の別範囲を参照しているように見えます。月別の対象行が意図どおりか確認が必要です。");
          findings.push("平均客単価・時間売上は客数や施術時間が0のときに#DIV/0!となる可能性があります。IFERRORまたは分母チェックを検討します。");
          findings.push("シート1のG列（合計売上）はD列（技術売上）+E列（指名料）+F列（店販）の数式パターンが行全体で一貫しているか確認が必要です。");
        }
        const report = "スプレッドシート詳細監査（読み取り専用）\nファイル: " + file.name +
          "\nシート数: " + sheetList.length + "\n調査上限: 各シート最大" + (sheetList.some(s=>/集計|summary|dashboard/i.test(s?.properties?.title||"")) ? "500" : "500") + "行（集計シートは100行）" +
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
        const explicitSales = /(?:売上管理|売上|技術売上|客単価|施術売上|指名売上)/.test(userText);
        const explicitRetail = /(?:店販管理|店販|個人販売管理表|商品販売|販売数量|販売個数|商品名)/.test(userText);
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
          const priceIndex = indexOfHeader("販売価格", "売上", "売上金額", "合計売上");
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
          let dataRows = rows.slice(1).filter(row => row.some(value => String(value ?? "").trim() !== ""));
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
            if (priceIndex < 0 || profitIndex < 0) {
              lines.push("利益率：必要な列（販売価格・利益）が見つからないため算出できません。");
            } else if (totalSales === 0) {
              lines.push("利益率：売上合計が0円のため算出できません。");
            } else {
              lines.push("売上合計：" + yen(totalSales), "利益合計：" + yen(totalProfit), "利益率：" + (totalProfit / totalSales * 100).toFixed(1) + "%");
            }
          } else if (/(?:利益)/.test(userText)) {
            lines.push(profitIndex < 0 ? "利益列が見つからないため算出できません。" : "利益合計：" + yen(totalProfit));
          } else if (/(?:売上|いくら|合計)/.test(userText)) {
            lines.push(priceIndex < 0 ? "販売価格列が見つからないため算出できません。" : "売上合計：" + yen(totalSales));
          }
          if (/(?:何個|数量|個数)/.test(userText)) lines.push("数量合計：" + totalQty.toLocaleString("ja-JP") + "個");
          if (/(?:何件|件数)/.test(userText)) lines.push("データ件数：" + dataRows.length + "件");
          lines.push("注：販売価格×数量を売上として集計しています。日付に年がない行は指定年のデータとみなします。");
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