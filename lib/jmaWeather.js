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
  if (typeof xml !== "string" || !/<(?:[\w.-]+:)?feed\b/i.test(xml)) {
    throw new Error("JMA_INVALID_ATOM_FEED");
  }
  const entries = [];
  const blocks = xml.match(/<(?:[\w.-]+:)?entry\b[\s\S]*?<\/(?:[\w.-]+:)?entry\s*>/gi) || [];
  for (const block of blocks) {
    const id = readTag(block, "id");
    const title = readTag(block, "title") || "";
    const updated = readTag(block, "updated");
    if (!id || !title || !updated) continue;
    let url;
    try { url = new URL(id); } catch (_) { continue; }
    if (url.protocol !== "https:" || url.hostname !== ALLOWED_TELEGRAM_HOST ||
        url.port || url.username || url.password || url.search || url.hash ||
        !/^\/developer\/xml\/data\/[A-Za-z0-9_.-]+\.xml$/.test(url.pathname) ||
        !Number.isFinite(Date.parse(updated))) continue;
    const codeMatch = (title + " " + url.pathname).match(/(?:VPFD51|VPFW50)/);
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


function readAttribute(attributes, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(attributes || "").match(new RegExp("(?:^|\\s)" + escaped + "\\s*=\\s*[\\\"']([^\\\"']*)[\\\"']", "i"));
  return match ? decodeXml(match[1]) : null;
}

function extractElementBlocks(xml, elementName) {
  const escapedName = elementName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const token = new RegExp("<(\/)?(?:[\w.-]+:)?" + escapedName + "\\b([^>]*)>", "gi");
  const results = [];
  const stack = [];
  let match;
  while ((match = token.exec(xml))) {
    if (match[1]) {
      const opened = stack.pop();
      if (opened) results.push({ attributes: opened.attributes, inner: xml.slice(opened.contentStart, match.index) });
      continue;
    }
    const attributes = match[2] || "";
    if (/\/\s*$/.test(attributes)) {
      results.push({ attributes, inner: "" });
    } else {
      stack.push({ attributes, contentStart: token.lastIndex });
    }
  }
  return results.reverse();
}

function summarizeForecastStructure(xml) {
  return extractElementBlocks(xml, "MeteorologicalInfos").map(info => ({
    type: readAttribute(info.attributes, "type"),
    timeSeries: extractElementBlocks(info.inner, "TimeSeriesInfo").map((series, index) => ({
      index,
      timeDefines: extractElementBlocks(series.inner, "TimeDefine").slice(0, 8).map(time => ({
        id: readAttribute(time.attributes, "timeId"),
        dateTime: readTag(time.inner, "DateTime"),
        name: readTag(time.inner, "Name")
      })),
      items: extractElementBlocks(series.inner, "Item").slice(0, 5).map(item => ({
        areaName: readTag(item.inner, "Area") ? readTag(extractElementBlocks(item.inner, "Area")[0]?.inner || "", "Name") : null,
        stationName: readTag(extractElementBlocks(item.inner, "Station")[0]?.inner || "", "Name"),
        kinds: extractElementBlocks(item.inner, "Kind").map(kind => readTag(kind.inner, "Type")).filter(Boolean)
      }))
    }))
  }));
}
function extractNamedCodeElements(xml, elementName) {
  return extractElementBlocks(xml, elementName).map(element => {
    const name = readTag(element.inner, "Name");
    const code = readAttribute(element.attributes, "code") || readTag(element.inner, "Code");
    return code && name ? { code: decodeXml(code), name } : null;
  }).filter(Boolean);
}
function extractForecastAreas(xml) {
  return extractNamedCodeElements(xml, "Area");
}

function extractForecastStations(xml) {
  return extractNamedCodeElements(xml, "Station");
}

function findSapporoArea(areas) {
  return areas.find(area => area.name === "石狩地方") || areas.find(area => area.name === "札幌") || null;
}

function findSapporoStation(stations) {
  return stations.find(station => station.name === "札幌") || null;
}

function classifyInfoType(infoType) {
  if (infoType === "取消") return "canceled";
  if (infoType === "発表" || infoType === "訂正") return "active";
  return "unknown";
}
function findSapporoForecastTargets(xml) {
  const areas = extractForecastAreas(xml);
  const stations = extractForecastStations(xml);
  return { area: findSapporoArea(areas), station: findSapporoStation(stations) };
}


const SAPPORO_AREA_NAME = "石狩地方";
const SAPPORO_STATION_NAME = "札幌";

function readElementText(inner) {
  return decodeXml(String(inner || "").replace(/<[^>]*>/g, "").trim());
}

function getForecastTarget(itemXml, elementName) {
  const element = extractElementBlocks(itemXml, elementName)[0];
  if (!element) return null;
  const name = readTag(element.inner, "Name");
  const code = readAttribute(element.attributes, "code") || readTag(element.inner, "Code");
  return name ? { name, code: code || null } : null;
}

function getTimeDefineMap(timeSeriesXml) {
  const map = Object.create(null);
  for (const time of extractElementBlocks(timeSeriesXml, "TimeDefine")) {
    const id = readAttribute(time.attributes, "timeId");
    const dateTime = readTag(time.inner, "DateTime");
    if (id && dateTime && Number.isFinite(Date.parse(dateTime))) map[id] = dateTime;
  }
  return map;
}

function getPropertyValues(itemXml, propertyType, partName, valueName) {
  const values = [];
  for (const property of extractElementBlocks(itemXml, "Property")) {
    if (readTag(property.inner, "Type") !== propertyType) continue;
    const part = extractElementBlocks(property.inner, partName)[0];
    if (!part) continue;
    for (const value of extractElementBlocks(part.inner, valueName)) {
      values.push({
        refId: readAttribute(value.attributes, "refID"),
        type: readAttribute(value.attributes, "type"),
        value: readElementText(value.inner),
        condition: readAttribute(value.attributes, "condition"),
        unit: readAttribute(value.attributes, "unit")
      });
    }
  }
  return values;
}

function numericValue(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function mergeTimedValue(target, dateTime, key, value) {
  if (!dateTime) return;
  if (!target.has(dateTime)) target.set(dateTime, { dateTime });
  target.get(dateTime)[key] = value;
}

function getJstDateString(timestamp) {
  const jst = new Date(timestamp + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

function selectCurrentForecast(timeSeries, nowMs) {
  if (!timeSeries.length) return null;
  return timeSeries.find(item => Date.parse(item.dateTime) >= nowMs) || timeSeries[timeSeries.length - 1];
}

function parseVpfd51Forecast(xml, nowMs = Date.now()) {
  const infos = extractElementBlocks(xml, "MeteorologicalInfos");
  const timed = new Map();
  const dailyTemperatures = [];
  let area = null;
  let station = null;

  for (const info of infos) {
    const infoType = readAttribute(info.attributes, "type");
    if (infoType === "区域予報") {
      for (const series of extractElementBlocks(info.inner, "TimeSeriesInfo")) {
        const timeMap = getTimeDefineMap(series.inner);
        for (const item of extractElementBlocks(series.inner, "Item")) {
          const target = getForecastTarget(item.inner, "Area");
          if (!target || target.name !== SAPPORO_AREA_NAME) continue;
          area = target;
          const weatherValues = getPropertyValues(item.inner, "３時間内卓越天気", "WeatherPart", "Weather");
          for (const value of weatherValues) mergeTimedValue(timed, timeMap[value.refId], "weather", value.value || null);
          const windDirections = getPropertyValues(item.inner, "３時間内代表風", "WindDirectionPart", "WindDirection");
          for (const value of windDirections) mergeTimedValue(timed, timeMap[value.refId], "windDirection", value.value || null);
          const windSpeeds = getPropertyValues(item.inner, "３時間内代表風", "WindSpeedPart", "WindSpeedLevel");
          for (const value of windSpeeds) mergeTimedValue(timed, timeMap[value.refId], "windSpeedLevel", numericValue(value.value));
          const probabilities = getPropertyValues(item.inner, "降水確率", "ProbabilityOfPrecipitationPart", "ProbabilityOfPrecipitation");
          for (const value of probabilities) {
            const dateTime = timeMap[value.refId];
            if (dateTime) mergeTimedValue(timed, dateTime, "precipitationProbability", numericValue(value.value));
          }
        }
      }
    } else if (infoType === "地点予報") {
      for (const series of extractElementBlocks(info.inner, "TimeSeriesInfo")) {
        const timeMap = getTimeDefineMap(series.inner);
        for (const item of extractElementBlocks(series.inner, "Item")) {
          const target = getForecastTarget(item.inner, "Station");
          if (!target || target.name !== SAPPORO_STATION_NAME) continue;
          station = target;
          const hourlyTemperatures = getPropertyValues(item.inner, "３時間毎気温", "TemperaturePart", "Temperature");
          for (const value of hourlyTemperatures) {
            mergeTimedValue(timed, timeMap[value.refId], "temperature", numericValue(value.value));
          }
          for (const property of extractElementBlocks(item.inner, "Property")) {
            const propertyType = readTag(property.inner, "Type");
            if (!["日中の最高気温", "最高気温", "朝の最低気温"].includes(propertyType)) continue;
            const part = extractElementBlocks(property.inner, "TemperaturePart")[0];
            if (!part) continue;
            for (const value of extractElementBlocks(part.inner, "Temperature")) {
              const dateTime = timeMap[readAttribute(value.attributes, "refID")];
              if (!dateTime) continue;
              dailyTemperatures.push({
                dateTime,
                type: readAttribute(value.attributes, "type") || propertyType,
                value: numericValue(readElementText(value.inner))
              });
            }
          }
        }
      }
    }
  }

  const timeSeries = Array.from(timed.values()).sort((a, b) => Date.parse(a.dateTime) - Date.parse(b.dateTime));
  const today = getJstDateString(nowMs);
  const todayValues = dailyTemperatures.filter(item => item.dateTime.slice(0, 10) === today && item.value !== null);
  const high = todayValues.find(item => item.type === "最高気温") || todayValues.find(item => item.type === "日中の最高気温") || null;
  const low = todayValues.find(item => item.type === "朝の最低気温") || null;
  return {
    area,
    station,
    timeSeries,
    current: selectCurrentForecast(timeSeries, nowMs),
    dailyTemperatures: dailyTemperatures.sort((a, b) => Date.parse(a.dateTime) - Date.parse(b.dateTime)),
    todayHighLow: { date: today, high: high ? high.value : null, low: low ? low.value : null }
  };
}

function parseVpfw50Forecast(xml) {
  const infos = extractElementBlocks(xml, "MeteorologicalInfos");
  const timed = new Map();
  let area = null;
  let station = null;
  for (const info of infos) {
    const infoType = readAttribute(info.attributes, "type");
    for (const series of extractElementBlocks(info.inner, "TimeSeriesInfo")) {
      const timeMap = getTimeDefineMap(series.inner);
      for (const item of extractElementBlocks(series.inner, "Item")) {
        const targetTag = infoType === "区域予報" ? "Area" : infoType === "地点予報" ? "Station" : null;
        if (!targetTag) continue;
        const target = getForecastTarget(item.inner, targetTag);
        const expectedName = targetTag === "Area" ? SAPPORO_AREA_NAME : SAPPORO_STATION_NAME;
        if (!target || target.name !== expectedName) continue;
        if (targetTag === "Area") area = target; else station = target;
        if (targetTag === "Area") {
          for (const value of getPropertyValues(item.inner, "天気", "WeatherPart", "Weather")) {
            mergeTimedValue(timed, timeMap[value.refId], "weather", value.value || null);
          }
          for (const value of getPropertyValues(item.inner, "降水確率", "ProbabilityOfPrecipitationPart", "ProbabilityOfPrecipitation")) {
            mergeTimedValue(timed, timeMap[value.refId], "precipitationProbability", numericValue(value.value));
          }
          for (const value of getPropertyValues(item.inner, "信頼度", "ReliabilityClassPart", "ReliabilityClass")) {
            mergeTimedValue(timed, timeMap[value.refId], "reliability", value.value || null);
          }
        } else {
          for (const propertyType of ["最高気温", "最低気温"]) {
            for (const value of getPropertyValues(item.inner, propertyType, "TemperaturePart", "Temperature")) {
              mergeTimedValue(timed, timeMap[value.refId], propertyType === "最高気温" ? "high" : "low", numericValue(value.value));
            }
          }
        }
      }
    }
  }
  const days = Array.from(timed.values()).sort((a, b) => Date.parse(a.dateTime) - Date.parse(b.dateTime));
  return { area, station, days };
}
async function inspectLatestForecast() {
  const { entries, cached } = await getForecastTelegramLinks();
  const selected = {
    daily: entries.find(entry => entry.code === "VPFD51") || null,
    weekly: entries.find(entry => entry.code === "VPFW50") || null
  };
  if (!selected.daily && !selected.weekly) throw new Error("JMA_FORECAST_TELEGRAM_NOT_FOUND");

  const [dailyXml, weeklyXml] = await Promise.all([
    selected.daily ? fetchText(selected.daily.id, MAX_TELEGRAM_BYTES) : Promise.resolve(null),
    selected.weekly ? fetchText(selected.weekly.id, MAX_TELEGRAM_BYTES) : Promise.resolve(null)
  ]);
  const primaryXml = dailyXml || weeklyXml;
  const primaryTelegram = selected.daily || selected.weekly;
  const title = readTag(primaryXml, "Title");
  const reportDateTime = readTag(primaryXml, "ReportDateTime");
  const targetDateTime = readTag(primaryXml, "TargetDateTime");
  const publishingOffice = readTag(primaryXml, "PublishingOffice");
  const infoType = readTag(primaryXml, "InfoType");
  if (!title || !reportDateTime || !publishingOffice) throw new Error("JMA_TELEGRAM_HEADER_INCOMPLETE");

  const dailyInfoType = dailyXml ? readTag(dailyXml, "InfoType") : null;
  const weeklyInfoType = weeklyXml ? readTag(weeklyXml, "InfoType") : null;
  const dailyInfoStatus = classifyInfoType(dailyInfoType);
  const weeklyInfoStatus = classifyInfoType(weeklyInfoType);
  const nowMs = Date.now();
  const dailyForecast = dailyXml && dailyInfoStatus === "active" ? parseVpfd51Forecast(dailyXml, nowMs) : null;
  const weeklyForecast = weeklyXml && weeklyInfoStatus === "active" ? parseVpfw50Forecast(weeklyXml) : null;
  const current = dailyForecast ? dailyForecast.current : null;
  const forecastValuesReady = Boolean(current && current.weather && current.temperature !== null);
  const structureXml = dailyXml || weeklyXml;
  const fetchedAt = new Date().toISOString();

  return {
    provider: "jma",
    source: "気象庁 防災情報XML",
    attribution: "出典：気象庁（気象庁の公開データを基にJ.A.R.V.I.S.が加工・表示）",
    feedCached: cached,
    fetchedAt,
    selected,
    inspectedTelegram: {
      code: primaryTelegram.code,
      title,
      reportDateTime,
      targetDateTime,
      publishingOffice,
      infoType,
      infoStatus: classifyInfoType(infoType)
    },
    inspectedWeeklyTelegram: weeklyXml ? {
      code: selected.weekly.code,
      title: readTag(weeklyXml, "Title"),
      reportDateTime: readTag(weeklyXml, "ReportDateTime"),
      targetDateTime: readTag(weeklyXml, "TargetDateTime"),
      publishingOffice: readTag(weeklyXml, "PublishingOffice"),
      infoType: weeklyInfoType,
      infoStatus: weeklyInfoStatus
    } : null,
    forecastAreas: extractForecastAreas(structureXml),
    forecastStations: extractForecastStations(structureXml),
    forecastStructure: summarizeForecastStructure(structureXml),
    forecastCanceled: dailyInfoStatus === "canceled",
    weeklyForecastCanceled: weeklyInfoStatus === "canceled",
    forecastValuesReady,
    forecast: {
      current,
      threeHourly: dailyForecast ? dailyForecast.timeSeries : [],
      dailyTemperatures: dailyForecast ? dailyForecast.dailyTemperatures : [],
      todayHighLow: dailyForecast ? dailyForecast.todayHighLow : null,
      weekly: weeklyForecast ? weeklyForecast.days : [],
      targets: dailyForecast ? { area: dailyForecast.area, station: dailyForecast.station } : findSapporoForecastTargets(structureXml)
    },
    note: forecastValuesReady
      ? "札幌の3時間予報を取得・解析しました。予報時刻と発表時刻を併せて表示してください。"
      : "札幌の有効な3時間予報を確認できませんでした。架空の値は表示しません。"
  };
}

module.exports = { inspectLatestForecast, parseFeedEntries, readTag, extractForecastAreas, extractForecastStations, findSapporoArea, findSapporoStation, findSapporoForecastTargets, classifyInfoType, summarizeForecastStructure };
