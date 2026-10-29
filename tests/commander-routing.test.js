const test = require("node:test");
const assert = require("node:assert/strict");
const { getAutoCommanderConfig } = require("../lib/commanderRouting");

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

test("long tasks qualify without keywords only at the configured threshold", () => {
  assert.equal(getAutoCommanderConfig({ autoCommander: true, text: "通常の依頼です。" + "文章".repeat(590), env: enabledEnv }).eligible, false);
  assert.equal(getAutoCommanderConfig({ autoCommander: true, text: "通常の依頼です。" + "文章".repeat(620), env: enabledEnv }).eligible, true);
});

test("selects one configured paid provider, preferring OpenAI and falling back to Anthropic", () => {
  assert.equal(getAutoCommanderConfig({ autoCommander: true, text: complexTask, env: enabledEnv }).provider, "openai");
  const anthropicOnly = { ...enabledEnv, OPENAI_API_KEY: "", JARVIS_OPENAI_MODEL: "" };
  assert.equal(getAutoCommanderConfig({ autoCommander: true, text: complexTask, env: anthropicOnly }).provider, "anthropic");
  const none = { ...enabledEnv, OPENAI_API_KEY: "", JARVIS_OPENAI_MODEL: "", ANTHROPIC_API_KEY: "", JARVIS_ANTHROPIC_MODEL: "" };
  assert.equal(getAutoCommanderConfig({ autoCommander: true, text: complexTask, env: none }).provider, null);
});
