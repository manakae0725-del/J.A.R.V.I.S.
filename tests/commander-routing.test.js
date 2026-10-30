const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyCommanderTask, getAutoCommanderConfig } = require("../lib/commanderRouting");

const enabledEnv = {
  JARVIS_AUTO_COMMANDER_ENABLED: "true",
  JARVIS_AI_COUNCIL_ENABLED: "true",
  JARVIS_AI_COUNCIL_PAID_PROVIDERS_ENABLED: "true",
  OPENAI_API_KEY: "test-key-not-real",
  JARVIS_OPENAI_MODEL: "test-model",
  ANTHROPIC_API_KEY: "test-key-not-real",
  JARVIS_ANTHROPIC_MODEL: "test-model"
};
const complexTask = "このシステムのセキュリティを分析し、改善案を比較してください。" + "追加情報".repeat(20);

test("automatic routing is disabled unless all feature and paid-provider flags are enabled", () => {
  for (const key of [
    "JARVIS_AUTO_COMMANDER_ENABLED",
    "JARVIS_AI_COUNCIL_ENABLED",
    "JARVIS_AI_COUNCIL_PAID_PROVIDERS_ENABLED"
  ]) {
    const env = { ...enabledEnv, [key]: "false" };
    assert.equal(getAutoCommanderConfig({ autoCommander: true, text: complexTask, env }).eligible, false);
  }
});

test("requires explicit autoCommander request, minimum length, and a complex-task signal", () => {
  assert.equal(getAutoCommanderConfig({ autoCommander: false, text: complexTask, env: enabledEnv }).eligible, false);
  assert.equal(getAutoCommanderConfig({ autoCommander: true, text: "分析して", env: enabledEnv }).eligible, false);
  assert.equal(getAutoCommanderConfig({ autoCommander: true, text: "短い依頼です。" + "通常文".repeat(30), env: enabledEnv }).eligible, false);
  assert.equal(getAutoCommanderConfig({ autoCommander: true, text: complexTask, env: enabledEnv }).eligible, true);
});

test("length alone never triggers paid-provider routing", () => {
  assert.equal(getAutoCommanderConfig({ autoCommander: true, text: "通常の依頼です。" + "文章".repeat(620), env: enabledEnv }).eligible, false);
});

test("selects one configured paid provider, preferring OpenAI and falling back to Anthropic", () => {
  assert.equal(getAutoCommanderConfig({ autoCommander: true, text: complexTask, env: enabledEnv }).provider, "openai");
  const anthropicOnly = { ...enabledEnv, OPENAI_API_KEY: "", JARVIS_OPENAI_MODEL: "" };
  assert.equal(getAutoCommanderConfig({ autoCommander: true, text: complexTask, env: anthropicOnly }).provider, "anthropic");
  const none = { ...enabledEnv, OPENAI_API_KEY: "", JARVIS_OPENAI_MODEL: "", ANTHROPIC_API_KEY: "", JARVIS_ANTHROPIC_MODEL: "" };
  assert.equal(getAutoCommanderConfig({ autoCommander: true, text: complexTask, env: none }).provider, null);
});


const realisticRequests = [
  ["通常の挨拶", "おはようございます。今日もよろしくお願いします。", false],
  ["短い単純依頼", "今日の予定を教えてください。", false],
  ["複雑な分析依頼", "今月の売上データを分析し、前月と比較して傾向と原因を整理し、来月の改善策を具体的に提案してください。".repeat(2), true],
  ["コード監査依頼", "認証処理とAPIのセキュリティを監査し、脆弱性の可能性と改善策を優先順位付きで説明してください。".repeat(2), true],
  ["単純依頼を長文化しただけ", "明日の予定を教えてください。".repeat(15), false]
];

for (const [name, text, expected] of realisticRequests) {
  test("realistic routing: " + name, () => {
    const actual = getAutoCommanderConfig({ autoCommander: true, text, env: enabledEnv });
    assert.equal(actual.eligible, expected);
    if (expected) assert.equal(actual.provider, "openai");
  });
}

test("ordinary conversation does not route without explicit autoCommander request", () => {
  assert.equal(
    getAutoCommanderConfig({
      autoCommander: false,
      text: "セキュリティを分析してください。".repeat(5),
      env: enabledEnv
    }).eligible,
    false
  );
});

test("paid provider calls remain disabled when paid-provider flag is false", () => {
  assert.equal(
    getAutoCommanderConfig({
      autoCommander: true,
      text: "売上を分析して改善案を比較してください。".repeat(4),
      env: { ...enabledEnv, JARVIS_AI_COUNCIL_PAID_PROVIDERS_ENABLED: "false" }
    }).eligible,
    false
  );
});

const semanticCases = [
  ["simple greeting", "おはようございます。今日もよろしくお願いします。", false],
  ["definition mentioning analysis", "分析という言葉の意味を教えてください。", false],
  ["general question mentioning security", "セキュリティとは何ですか？", false],
  ["action verb without work context", "比較してください。", false],
  ["simple task padded with repeated text", "明日の予定を教えてください。" + "文章".repeat(100), false],
  ["business analysis with context", "今月の売上データを分析し、前月と比較して傾向と原因を整理し、来月の改善策を具体的に提案してください。", true],
  ["security audit with context", "認証処理とAPIのセキュリティを監査し、脆弱性の可能性と改善策を優先順位付きで説明してください。", true],
  ["architecture design with requirements", "新しい予約管理システムの要件を整理し、構成を設計して複数案のメリットとデメリットを比較してください。", true]
  ,["code review phrasing", "このコードの問題点を洗い出して、修正すべき箇所を教えてください。", true]
  ,["business cause investigation", "今月は売上が落ちています。原因を調査して改善案を出してください。", true]
  ,["routine status question", "今日の売上はいくらですか？", false]
  ,["short business comparison", "売上を比較してください。", true]
  ,["general security explanation", "セキュリティについて教えてください。", false]
  ,["short code review request", "このコードをレビューしてください。", true]
  ,["simple business status with context", "今月の売上はいくらですか？", false]
  ,["short architecture design request", "予約管理システムを設計してください。", true]
];

for (const [name, text, expected] of semanticCases) {
  test("semantic classification: " + name, () => {
    assert.equal(classifyCommanderTask(text).shouldDelegate, expected);
  });
}

test("classification is exposed even when routing flags are disabled", () => {
  const result = getAutoCommanderConfig({
    autoCommander: true,
    text: "今月の売上データを分析し、前月と比較して改善策を提案してください。",
    env: { ...enabledEnv, JARVIS_AUTO_COMMANDER_ENABLED: "false" }
  });
  assert.equal(result.classification.intent, "specialist_analysis");
  assert.equal(result.eligible, false);
  assert.equal(result.provider, null);
});
