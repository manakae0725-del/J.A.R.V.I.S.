// Keep spreadsheet reads limited to explicit metric lookups, not incidental business terminology.
const METRIC = "(?:総売上|店販売上|技術売上|売上|利益|客数|店販|販売|件数|数量)";
const PERIOD = "(?:今月|先月|今日|本日|今年|昨年|去年|月別|全期間|期間別)";

const DIRECT_LOOKUP_SUFFIX = /^(?:はいくら|を集計(?:して|してください|を見せて|結果を見せて)?|の集計(?:を見せて|して|してください)?|の合計|合計(?:を|は)|の実績|実績を(?:確認|見せて|教えて)|の推移|推移を(?:見せて|教えて)|の内訳|内訳を(?:見せて|教えて)|は何件|は何個|を見せて|を教えて)/;

function isExplicitMetricLookupIntent(value) {
  const text = typeof value === "string" ? value : "";
  const periodPattern = new RegExp(PERIOD + "(?:の)?" + METRIC + "(.{0,12})");
  const metricPattern = new RegExp(METRIC + "(.{0,12})");
  const periodMatch = text.match(periodPattern);
  if (periodMatch && DIRECT_LOOKUP_SUFFIX.test(periodMatch[1])) return true;
  const metricMatch = text.match(metricPattern);
  return Boolean(metricMatch && DIRECT_LOOKUP_SUFFIX.test(metricMatch[1]));
}

module.exports = { isExplicitMetricLookupIntent };
