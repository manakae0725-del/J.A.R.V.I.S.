const test = require("node:test");
const assert = require("node:assert/strict");
const { isExplicitMetricLookupIntent } = require("../lib/spreadsheetIntent");

const cases = [
  ["今日の売上はいくらですか？", true],
  ["今月の売上を集計してください。", true],
  ["売上を集計して", true],
  ["売上の合計を見せて", true],
  ["先月の店販売上の実績を確認してください。", true],
  ["美容室の予約管理システムを設計してください。売上集計まで含めてください。", false],
  ["今月の売上データを分析し、前月と比較して傾向と原因を整理してください。", false],
  ["売上という言葉の意味を教えてください。", false],
  ["売上を考慮した事業計画を設計してください。", false],
  ["予約システムに売上集計機能を含めてください。", false]
];

for (const [input, expected] of cases) {
  test("spreadsheet metric intent: " + input, () => {
    assert.equal(isExplicitMetricLookupIntent(input), expected);
  });
}
