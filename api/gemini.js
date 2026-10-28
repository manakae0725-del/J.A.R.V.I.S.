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
const { listConnectionsForUser } = require("./_google/tokenStore");
const { googleApiRequest } = require("./_google/client");

const crypto = require("crypto");
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

    if (
      previousInteractionId &&
      typeof previousInteractionId === "string"
    ) {
      requestBody.previous_interaction_id =
        previousInteractionId;
    }

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
      typeof data.id === "string"
        ? data.id
        : null;

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
