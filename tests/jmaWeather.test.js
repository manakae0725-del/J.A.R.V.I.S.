"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseFeedEntries, readTag, extractForecastAreas, findSapporoArea } = require("../lib/jmaWeather");

test("selects JMA VPFD51 and VPFW50 telegrams from Atom feed", () => {
  const xml = `<?xml version="1.0"?>
  <feed xmlns="http://www.w3.org/2005/Atom">
    <entry>
      <id>https://www.data.jma.go.jp/developer/xml/data/20261103090000_0_VPFD51_1.xml</id>
      <title>府県天気予報（Ｒ１）</title>
      <updated>2026-11-03T09:00:00Z</updated>
    </entry>
    <entry>
      <id>https://www.data.jma.go.jp/developer/xml/data/20261103080000_0_VPFW50_1.xml</id>
      <title>府県週間天気予報</title>
      <updated>2026-11-03T08:00:00Z</updated>
    </entry>
    <entry>
      <id>https://www.data.jma.go.jp/developer/xml/data/20261103070000_0_VPFD51_2.xml</id>
      <title>府県天気予報（Ｒ１）</title>
      <updated>2026-11-03T07:00:00Z</updated>
    </entry>
  </feed>`;
  const entries = parseFeedEntries(xml);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].code, "VPFD51");
  assert.match(entries[0].id, /20261103090000/);
  assert.equal(entries[2].code, "VPFD51");
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
  const xml = `<Report><Area><Name>石狩地方</Name><Code>016000</Code><Area><Name>札幌</Name><Code>016010</Code></Area></Area></Report>`;
  const areas = extractForecastAreas(xml);
  assert.deepEqual(areas, [{ code: "016000", name: "石狩地方" }, { code: "016010", name: "札幌" }]);
  assert.deepEqual(findSapporoArea(areas), { code: "016010", name: "札幌" });
});
test("extracts nested Area elements with XML namespaces and attribute variations", () => {
  const xml = `<j:Report xmlns:j="urn:jma">
    <j:Area name="region">
      <j:Name>石狩地方</j:Name><j:Code codeType="AreaForecast">016000</j:Code>
      <j:Area extra="x"><j:Name>札幌</j:Name><j:Code>016010</j:Code></j:Area>
    </j:Area>
  </j:Report>`;
  const areas = extractForecastAreas(xml);
  assert.deepEqual(areas, [
    { code: "016000", name: "石狩地方" },
    { code: "016010", name: "札幌" }
  ]);
  assert.deepEqual(findSapporoArea(areas), { code: "016010", name: "札幌" });
});

test("ignores Area elements without a code or name", () => {
  const xml = `<Report>
    <Area><Name>コードなし</Name></Area>
    <Area><Code>016010</Code></Area>
    <Area><Name>函館</Name><Code>016020</Code></Area>
  </Report>`;
  assert.deepEqual(extractForecastAreas(xml), [{ code: "016020", name: "函館" }]);
  assert.equal(findSapporoArea(extractForecastAreas(xml)), null);
});
