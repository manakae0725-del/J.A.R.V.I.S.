function getAutoCommanderConfig({ autoCommander, text, env = process.env }) {
  const taskText = autoCommander === true && typeof text === "string" ? text.trim() : "";
  const complexTaskPattern = /(?:比較|分析|設計|監査|検証|予測|戦略|計画|原因|改善|要件|アーキテクチャ|セキュリティ|脆弱性|複数の観点|メリット.{0,8}デメリット|compare|analy[sz]e|architecture|security audit|threat model|root cause|forecast|strategy|trade.?off|review the code)/i;
  const eligible =
    env.JARVIS_AUTO_COMMANDER_ENABLED === "true" &&
    env.JARVIS_AI_COUNCIL_ENABLED === "true" &&
    taskText.length >= 80 &&
    (complexTaskPattern.test(taskText) || taskText.length >= 1200) &&
    env.JARVIS_AI_COUNCIL_PAID_PROVIDERS_ENABLED === "true";
  const provider =
    env.OPENAI_API_KEY && env.JARVIS_OPENAI_MODEL
      ? "openai"
      : env.ANTHROPIC_API_KEY && env.JARVIS_ANTHROPIC_MODEL
        ? "anthropic"
        : null;
  return { taskText, eligible, provider };
}

module.exports = { getAutoCommanderConfig };
