"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readBoundedResponseBody, parseFeedEntries, readTag, extractForecastAreas, extractForecastStations, findSapporoArea, findSapporoStation, findSapporoForecastTargets, classifyInfoType, summarizeForecastStructure, parseVpfd51Forecast, parseVpfw50Forecast, resolveHokkaidoForecastArea } = require("../lib/jmaWeather");

test("selects JMA VPFD51 and VPFW50 telegrams from Atom feed", () => {
  const xml = `<?xml version="1.0"?>
  <feed xmlns="http://www.w3.org/2005/Atom">
    <entry>
      <id>https://www.data.jma.go.jp/developer/xml/data/20261103090000_0_VPFD51_016000.xml</id>
      <title>府県天気予報（Ｒ１）</title>
      <updated>2026-11-03T09:00:00Z</updated>
    </entry>
    <entry>
      <id>https://www.data.jma.go.jp/developer/xml/data/20261103080000_0_VPFW50_016000.xml</id>
      <title>府県週間天気予報</title>
      <updated>2026-11-03T08:00:00Z</updated>
    </entry>
    <entry>
      <id>https://www.data.jma.go.jp/developer/xml/data/20261103070000_0_VPFD51_020000.xml</id>
      <title>府県天気予報（Ｒ１）</title>
      <updated>2026-11-03T07:00:00Z</updated>
    </entry>
  </feed>`;
  const entries = parseFeedEntries(xml);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].code, "VPFD51");
  assert.equal(entries[0].areaCode, "016000");
  assert.match(entries[0].id, /20261103090000/);
  assert.equal(entries[2].code, "VPFD51");
  assert.equal(entries[2].areaCode, "020000");
});

test("rejects telegram URLs outside the official JMA host and path", () => {
  const xml = `<feed>
    <entry><id>https://example.com/developer/xml/data/a_VPFD51.xml</id><title>VPFD51</title><updated>2026-11-03T09:00:00Z</updated></entry>
    <entry><id>https://www.data.jma.go.jp/other/a_VPFD51.xml</id><title>VPFD51</title><updated>2026-11-03T09:00:00Z</updated></entry>
  </feed>`;
  assert.deepEqual(parseFeedEntries(xml), []);
});

test("rejects malformed non-Atom input", () => {
  assert.throws(() => parseFeedEntries("<html>not a feed</html>"), /JMA_INVALID_ATOM_FEED/);
});


test("reads namespaced XML tags and decodes entities", () => {
  const xml = `<j:Report xmlns:j="urn:test"><j:Title>Forecast &amp; Warning</j:Title></j:Report>`;
  assert.equal(readTag(xml, "Title"), "Forecast & Warning");
});

test("returns null for absent XML tags", () => {
  assert.equal(readTag("<Report><Title>Weather</Title></Report>", "Missing"), null);
});

test("extracts forecast area codes and names from Area elements", () => {
  const xml = `<Report><Area><Name>石狩地方</Name><Code>016010</Code></Area></Report>`;
  const areas = extractForecastAreas(xml);
  assert.deepEqual(areas, [{ code: "016010", name: "石狩地方" }]);
  assert.deepEqual(findSapporoArea(areas), { code: "016010", name: "石狩地方" });
  assert.deepEqual(findSapporoArea([{ code: "016000", name: "石狩・空知・後志地方" }]), { code: "016000", name: "石狩・空知・後志地方" });
});
test("extracts nested Area elements with XML namespaces and attribute variations", () => {
  const xml = `<j:Report xmlns:j="urn:jma">
    <j:Area name="region">
      <j:Name>親区域</j:Name><j:Code codeType="AreaForecast">000001</j:Code>
      <j:Area><j:Name>子区域</j:Name><j:Code>000002</j:Code></j:Area>
    </j:Area>
  </j:Report>`;
  const areas = extractForecastAreas(xml);
  assert.deepEqual(areas, [
    { code: "000001", name: "親区域" },
    { code: "000002", name: "子区域" }
  ]);
  assert.equal(findSapporoArea(areas), null);
});

test("ignores Area elements without a code or name", () => {
  const xml = `<Report>
    <Area><Name>コードなし</Name></Area>
    <Area><Code>016010</Code></Area>
    <Area><Name>テスト区域</Name><Code>000003</Code></Area>
  </Report>`;
  assert.deepEqual(extractForecastAreas(xml), [{ code: "000003", name: "テスト区域" }]);
  assert.equal(findSapporoArea(extractForecastAreas(xml)), null);
});
test("extracts the Sapporo representative station independently from its forecast area", () => {
  const xml = `<Report>
    <MeteorologicalInfos type="区域予報"><TimeSeriesInfo><Item><Area><Name>石狩地方</Name><Code>016010</Code></Area></Item></TimeSeriesInfo></MeteorologicalInfos>
    <MeteorologicalInfos type="地点予報"><TimeSeriesInfo><Item><Station><Name>札幌</Name><Code>14163</Code></Station></Item></TimeSeriesInfo></MeteorologicalInfos>
  </Report>`;
  const stations = extractForecastStations(xml);
  assert.deepEqual(stations, [{ code: "14163", name: "札幌" }]);
  assert.deepEqual(findSapporoStation(stations), { code: "14163", name: "札幌" });
  assert.deepEqual(findSapporoForecastTargets(xml), {
    area: { code: "016010", name: "石狩地方" },
    station: { code: "14163", name: "札幌" }
  });
});
test("classifies JMA forecast publication, correction, and cancellation", () => {
  assert.equal(classifyInfoType("発表"), "active");
  assert.equal(classifyInfoType("訂正"), "active");
  assert.equal(classifyInfoType("取消"), "canceled");
  assert.equal(classifyInfoType(null), "unknown");
});
test("summarizes namespaced VPFD51 MeteorologicalInfos and TimeSeriesInfo structure", () => {
  const xml = `<j:Report xmlns:j="urn:jma"><j:Body>
    <j:MeteorologicalInfos type="区域予報"><j:TimeSeriesInfo>
      <j:TimeDefines><j:TimeDefine timeId="1"><j:DateTime>2026-11-03T18:00:00+09:00</j:DateTime></j:TimeDefine></j:TimeDefines>
      <j:Item><j:Kind><j:Property><j:Type>３時間内卓越天気</j:Type></j:Property></j:Kind><j:Area><j:Name>石狩地方</j:Name><j:Code>016010</j:Code></j:Area></j:Item>
    </j:TimeSeriesInfo></j:MeteorologicalInfos>
  </j:Body></j:Report>`;
  const summary = summarizeForecastStructure(xml);
  assert.equal(summary.length, 1);
  assert.equal(summary[0].type, "区域予報");
  assert.equal(summary[0].timeSeries[0].timeDefines[0].id, "1");
  assert.equal(summary[0].timeSeries[0].timeDefines[0].dateTime, "2026-11-03T18:00:00+09:00");
  assert.deepEqual(summary[0].timeSeries[0].items[0].kinds, ["３時間内卓越天気"]);
  assert.equal(summary[0].timeSeries[0].items[0].areaName, "石狩地方");
});
test("rejects JMA telegram URLs with credentials, nonstandard ports, or query strings", () => {
  const xml = `<feed>
    <entry><id>https://user@www.data.jma.go.jp/developer/xml/data/a_VPFD51.xml</id><title>VPFD51</title><updated>2026-11-03T09:00:00Z</updated></entry>
    <entry><id>https://www.data.jma.go.jp:8443/developer/xml/data/b_VPFD51.xml</id><title>VPFD51</title><updated>2026-11-03T09:00:00Z</updated></entry>
    <entry><id>https://www.data.jma.go.jp/developer/xml/data/c_VPFD51.xml?next=1</id><title>VPFD51</title><updated>2026-11-03T09:00:00Z</updated></entry>
    <entry><id>https://www.data.jma.go.jp/developer/xml/data/d_VPFD51.xml</id><title>VPFD51</title><updated>invalid-date</updated></entry>
  </feed>`;
  assert.deepEqual(parseFeedEntries(xml), []);
});
test("parses Sapporo three-hour weather and temperature from VPFD51 XML", () => {
  const xml = `<Report xmlns:jmx_eb="urn:element"><Body>
    <MeteorologicalInfos type="区域予報"><TimeSeriesInfo>
      <TimeDefines>
        <TimeDefine timeId="1"><DateTime>2026-11-03T12:00:00+09:00</DateTime></TimeDefine>
        <TimeDefine timeId="2"><DateTime>2026-11-03T15:00:00+09:00</DateTime></TimeDefine>
      </TimeDefines>
      <Item>
        <Kind><Property><Type>３時間内卓越天気</Type><WeatherPart>
          <jmx_eb:Weather refID="1" type="天気">晴れ</jmx_eb:Weather>
          <jmx_eb:Weather refID="2" type="天気">くもり</jmx_eb:Weather>
        </WeatherPart></Property></Kind>
        <Kind><Property><Type>３時間内代表風</Type>
          <WindDirectionPart><jmx_eb:WindDirection refID="1">北</jmx_eb:WindDirection></WindDirectionPart>
          <WindSpeedPart><jmx_eb:WindSpeedLevel refID="1">2</jmx_eb:WindSpeedLevel></WindSpeedPart>
        </Property></Kind>
        <Area><Name>石狩地方</Name><Code>016010</Code></Area>
      </Item>
    </TimeSeriesInfo></MeteorologicalInfos>
    <MeteorologicalInfos type="地点予報"><TimeSeriesInfo>
      <TimeDefines>
        <TimeDefine timeId="1"><DateTime>2026-11-03T12:00:00+09:00</DateTime></TimeDefine>
        <TimeDefine timeId="2"><DateTime>2026-11-03T15:00:00+09:00</DateTime></TimeDefine>
      </TimeDefines>
      <Item><Kind><Property><Type>３時間毎気温</Type><TemperaturePart>
        <jmx_eb:Temperature refID="1" type="気温" unit="度">5</jmx_eb:Temperature>
        <jmx_eb:Temperature refID="2" type="気温" unit="度">4</jmx_eb:Temperature>
      </TemperaturePart></Property></Kind><Station><Name>札幌</Name><Code>14163</Code></Station></Item>
    </TimeSeriesInfo><TimeSeriesInfo>
      <TimeDefines><TimeDefine timeId="1"><DateTime>2026-11-03T00:00:00+09:00</DateTime></TimeDefine></TimeDefines>
      <Item>
        <Kind><Property><Type>最高気温</Type><TemperaturePart><jmx_eb:Temperature refID="1" type="最高気温">8</jmx_eb:Temperature></TemperaturePart></Property></Kind>
        <Kind><Property><Type>朝の最低気温</Type><TemperaturePart><jmx_eb:Temperature refID="1" type="朝の最低気温">1</jmx_eb:Temperature></TemperaturePart></Property></Kind>
        <Station><Name>札幌</Name><Code>14163</Code></Station>
      </Item>
    </TimeSeriesInfo></MeteorologicalInfos>
  </Body></Report>`;
  const parsed = parseVpfd51Forecast(xml, Date.parse("2026-11-03T11:30:00+09:00"));
  assert.deepEqual(parsed.area, { name: "石狩地方", code: "016010" });
  assert.deepEqual(parsed.station, { name: "札幌", code: "14163" });
  assert.equal(parsed.current.weather, "晴れ");
  assert.equal(parsed.current.temperature, 5);
  assert.equal(parsed.current.windDirection, "北");
  assert.equal(parsed.current.windSpeedLevel, 2);
  assert.deepEqual(parsed.todayHighLow, { date: "2026-11-03", high: 8, low: 1 });
  const active = parseVpfd51Forecast(xml, Date.parse("2026-11-03T13:00:00+09:00"));
  assert.equal(active.current.dateTime, "2026-11-03T12:00:00+09:00");
});

test("parses Sapporo weekly weather, precipitation, and temperatures from VPFW50 XML", () => {
  const xml = `<Report xmlns:jmx_eb="urn:element"><Body>
    <MeteorologicalInfos type="区域予報"><TimeSeriesInfo>
      <TimeDefines><TimeDefine timeId="1"><DateTime>2026-11-04T00:00:00+09:00</DateTime></TimeDefine></TimeDefines>
      <Item>
        <Kind><Property><Type>天気</Type><WeatherPart><jmx_eb:Weather refID="1">雪</jmx_eb:Weather></WeatherPart></Property></Kind>
        <Kind><Property><Type>降水確率</Type><ProbabilityOfPrecipitationPart><jmx_eb:ProbabilityOfPrecipitation refID="1">60</jmx_eb:ProbabilityOfPrecipitation></ProbabilityOfPrecipitationPart></Property></Kind>
        <Area><Name>石狩・空知・後志地方</Name><Code>016000</Code></Area>
      </Item>
    </TimeSeriesInfo></MeteorologicalInfos>
    <MeteorologicalInfos type="地点予報"><TimeSeriesInfo>
      <TimeDefines><TimeDefine timeId="1"><DateTime>2026-11-04T00:00:00+09:00</DateTime></TimeDefine></TimeDefines>
      <Item>
        <Kind><Property><Type>最高気温</Type><TemperaturePart><jmx_eb:Temperature refID="1">4</jmx_eb:Temperature></TemperaturePart></Property></Kind>
        <Kind><Property><Type>最低気温</Type><TemperaturePart><jmx_eb:Temperature refID="1">-3</jmx_eb:Temperature></TemperaturePart></Property></Kind>
        <Station><Name>札幌</Name><Code>14163</Code></Station>
      </Item>
    </TimeSeriesInfo></MeteorologicalInfos>
  </Body></Report>`;
  const parsed = parseVpfw50Forecast(xml);
  assert.deepEqual(parsed.area, { name: "石狩・空知・後志地方", code: "016000" });
  assert.deepEqual(parsed.days, [{ dateTime: "2026-11-04T00:00:00+09:00", weather: "雪", precipitationProbability: 60, high: 4, low: -3 }]);
});


test("reads a streamed UTF-8 response within the byte limit", async () => {
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from("札"));
      controller.enqueue(Buffer.from("幌"));
      controller.close();
    }
  }));
  assert.equal(await readBoundedResponseBody(response, Buffer.byteLength("札幌", "utf8")), "札幌");
});

test("rejects an oversized streamed response and cancels the stream", async () => {
  let canceled = false;
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from("1234"));
      controller.enqueue(Buffer.from("5678"));
    },
    cancel() {
      canceled = true;
    }
  }));
  await assert.rejects(readBoundedResponseBody(response, 5), /JMA_RESPONSE_TOO_LARGE/);
  assert.equal(canceled, true);
});

test("enforces the byte limit when a response has no readable stream", async () => {
  const response = { body: null, text: async () => "札幌" };
  assert.equal(await readBoundedResponseBody(response, 6), "札幌");
  await assert.rejects(readBoundedResponseBody(response, 5), /JMA_RESPONSE_TOO_LARGE/);
});


test("resolves Hokkaido forecast regions and representative cities", () => {
  assert.equal(resolveHokkaidoForecastArea("明日の旭川の天気").code, "012000");
  const tokachi = resolveHokkaidoForecastArea("帯広の週間天気");
  assert.equal(tokachi.code, "014030");
  assert.equal(tokachi.feedAreaCode, "014100");
  assert.deepEqual(tokachi.areaNames, ["十勝地方"]);
  assert.deepEqual(tokachi.weeklyAreaNames, ["十勝地方"]);
  assert.deepEqual(tokachi.stations, ["帯広"]);
  assert.equal(resolveHokkaidoForecastArea("釧路の天気").code, "014100");
  assert.deepEqual(resolveHokkaidoForecastArea("小樽の天気").stations, ["倶知安"]);
  assert.deepEqual(resolveHokkaidoForecastArea("苫小牧の天気").stations, ["室蘭"]);
  assert.equal(resolveHokkaidoForecastArea("紋別の天気").label, "紋別地方");
  assert.equal(resolveHokkaidoForecastArea("札幌の天気").code, "016000");
  assert.equal(resolveHokkaidoForecastArea(" 札幌 の 天気 ").code, "016000");
  assert.equal(resolveHokkaidoForecastArea("北海道の天気"), null);
  assert.equal(resolveHokkaidoForecastArea("東京の天気"), null);
});

test("selects today's high and low by JST calendar date when XML timestamps use UTC", () => {
  const xml = `<Report><MeteorologicalInfos type="地点予報"><TimeSeriesInfo>
    <TimeDefines><TimeDefine timeId="1"><DateTime>2026-11-02T15:00:00Z</DateTime></TimeDefine></TimeDefines>
    <Item><Kind>
      <Property><Type>日中の最高気温</Type><TemperaturePart><Temperature refID="1" type="日中の最高気温" unit="度">9</Temperature></TemperaturePart></Property>
      <Property><Type>朝の最低気温</Type><TemperaturePart><Temperature refID="1" type="朝の最低気温" unit="度">2</Temperature></TemperaturePart></Property>
    </Kind><Station><Name>札幌</Name><Code>14163</Code></Station></Item>
  </TimeSeriesInfo></MeteorologicalInfos></Report>`;
  const parsed = parseVpfd51Forecast(xml, Date.parse("2026-11-03T01:00:00+09:00"));
  assert.deepEqual(parsed.todayHighLow, { date: "2026-11-03", high: 9, low: 2 });
});

test("falls back to weekly forecast for today's HUD high and low when daily extremes are absent", () => {
  const { selectTodayHighLow } = require("../lib/jmaWeather");
  const now = Date.parse("2026-11-04T21:28:00+09:00");
  const weekly = [
    { dateTime: "2026-11-04T00:00:00+09:00", high: 7, low: 1 },
    { dateTime: "2026-11-05T00:00:00+09:00", high: 8, low: 2 }
  ];
  assert.deepEqual(selectTodayHighLow({ date: "2026-11-04", high: null, low: null }, weekly, now), {
    date: "2026-11-04", high: 7, low: 1
  });
  assert.deepEqual(selectTodayHighLow(null, weekly, now), {
    date: "2026-11-04", high: 7, low: 1
  });
});

