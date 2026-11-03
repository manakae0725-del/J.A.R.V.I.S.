"use strict";

const FEED_URL = "https://www.data.jma.go.jp/developer/xml/feed/regular_l.xml";
const ALLOWED_TELEGRAM_HOST = "www.data.jma.go.jp";
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_FEED_BYTES = 5 * 1024 * 1024;
const MAX_TELEGRAM_BYTES = 2 * 1024 * 1024;

let feedCache = { expiresAt: 0, entries: null };

function decodeXml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function readTag(xml, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xml.match(new RegExp("<(?:[\\w.-]+:)?" + escaped + "\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?" + escaped + "\\s*>", "i"));
  return match ? decodeXml(match[1].replace(/<[^>]*>/g, "").trim()) : null;
}

async function fetchText(url, maxBytes) {
  const response = await fetch(url, {
    headers: { "User-Agent": "JARVIS-private-weather-client/1.0", Accept: "application/atom+xml, application/xml, text/xml" },
    signal: AbortSignal.timeout(10000),
    redirect: "error"
  });
  if (!response.ok) throw new Error("JMA_HTTP_" + response.status);
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > maxBytes) throw new Error("JMA_RESPONSE_TOO_LARGE");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error("JMA_RESPONSE_TOO_LARGE");
  return text;
}

function parseFeedEntries(xml) {
  if (typeof xml !== "string" || !/<(?:[\\w.-]+:)?feed\\b/i.test(xml)) {
    throw new Error("JMA_INVALID_ATOM_FEED");
  }
  const entries = [];
  const blocks = xml.match(/<(?:[\\w.-]+:)?entry\\b[\\s\\S]*?<\/(?:[\\w.-]+:)?entry\s*>/gi) || [];
  for (const block of blocks) {
    const id = readTag(block, "id");
    const title = readTag(block, "title") || "";
    const updated = readTag(block, "updated");
    if (!id || !title || !updated) continue;
    let url;
    try { url = new URL(id); } catch (_) { continue; }
    if (url.protocol !== "https:" || url.hostname !== ALLOWED_TELEGRAM_HOST ||
        !/^\/developer\/xml\/data\/[A-Za-z0-9_.-]+\.xml$/.test(url.pathname)) continue;
    const codeMatch = title.match(/(?:VPFD51|VPFW50)/);
    if (!codeMatch) continue;
    entries.push({ id: url.toString(), title, updated, code: codeMatch[0] });
  }
  return entries.sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
}

async function getForecastTelegramLinks() {
  if (feedCache.entries && feedCache.expiresAt > Date.now()) {
    return { entries: feedCache.entries, cached: true };
  }
  const xml = await fetchText(FEED_URL, MAX_FEED_BYTES);
  const entries = parseFeedEntries(xml);
  if (!entries.length) throw new Error("JMA_FORECAST_TELEGRAM_NOT_FOUND");
  feedCache = { entries, expiresAt: Date.now() + CACHE_TTL_MS };
  return { entries, cached: false };
}

async function inspectLatestForecast() {
  const { entries, cached } = await getForecastTelegramLinks();
  const selected = {
    daily: entries.find(entry => entry.code === "VPFD51") || null,
    weekly: entries.find(entry => entry.code === "VPFW50") || null
  };
  if (!selected.daily && !selected.weekly) throw new Error("JMA_FORECAST_TELEGRAM_NOT_FOUND");

  const telegram = selected.daily || selected.weekly;
  const xml = await fetchText(telegram.id, MAX_TELEGRAM_BYTES);
  const title = readTag(xml, "Title");
  const reportDateTime = readTag(xml, "ReportDateTime");
  const targetDateTime = readTag(xml, "TargetDateTime");
  const publishingOffice = readTag(xml, "PublishingOffice");
  const infoType = readTag(xml, "InfoType");

  if (!title || !reportDateTime || !publishingOffice) {
    throw new Error("JMA_TELEGRAM_HEADER_INCOMPLETE");
  }
  return {
    provider: "jma",
    source: "気象庁 防災情報XML",
    attribution: "出典：気象庁（気象庁の公開データを基にJ.A.R.V.I.S.が加工・表示）",
    feedCached: cached,
    selected,
    inspectedTelegram: {
      code: telegram.code,
      title,
      reportDateTime,
      targetDateTime,
      publishingOffice,
      infoType
    },
    forecastValuesReady: false,
    note: "電文ヘッダーの取得確認段階です。札幌の予報区域・地点対応と予報値の解析が検証されるまで、予報値は表示しません。"
  };
}

module.exports = { inspectLatestForecast, parseFeedEntries };
