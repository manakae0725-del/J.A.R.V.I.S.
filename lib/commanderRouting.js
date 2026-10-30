const SIMPLE_CONVERSATION_PATTERN = /^(?:おはよう(?:ございます)?|こんにちは|こんばんは|おやすみなさい|ありがとう(?:ございます)?|ありがとうございます|了解(?:です)?|承知しました|はい|いいえ|ok|okay|thanks?|助かりました|よろしくお願いします)[。！!？?\s]*$/i;
const META_OR_DEFINITION_PATTERN = /(?:という言葉|の意味|とは何|って何|について教えて|とはどういう|例文|翻訳|訳して|要約して|短くして|言い換えて)/i;
const HIGH_COMPLEXITY_ACTION = /(?:比較|分析|設計|監査|検証|予測|立案|評価|診断|最適化|調査|点検|レビュー|見直し|問題点.{0,8}(?:洗い出し|特定)|原因.{0,8}(?:特定|究明|分析|調査)|改善案|戦略|アーキテクチャ|脆弱性|リスク評価|費用対効果|メリット.{0,12}デメリット|compare|analy[sz]e|design|audit|verify|forecast|evaluate|optimi[sz]e|investigate|review|root cause|threat model|trade.?off)/i;
const COMPLEXITY_CONTEXT = /(?:売上|収益|顧客|予約|業務|経営|事業|家計|予算|データ|数値|傾向|原因|施策|計画|要件|仕様|構成|コード|実装|認証|API|セキュリティ|脆弱性|ログ|障害|システム|複数|月次|前年比|前月比|security|system|code|data|business|revenue|customer|architecture|implementation)/i;
const EXPLICIT_MULTI_STEP = /(?:複数の観点|優先順位|手順を整理|段階的に|根拠を示して|具体的な改善|選択肢.{0,12}比較|原因.{0,12}対策|現状.{0,12}課題.{0,12}改善)/i;

function classifyCommanderTask(value) {
  const taskText = typeof value === "string" ? value.trim() : "";
  if (!taskText) return { intent: "empty", complexity: "low", shouldDelegate: false, reason: "empty" };
  if (SIMPLE_CONVERSATION_PATTERN.test(taskText)) {
    return { intent: "conversation", complexity: "low", shouldDelegate: false, reason: "simple_conversation" };
  }
  if (META_OR_DEFINITION_PATTERN.test(taskText) && !EXPLICIT_MULTI_STEP.test(taskText)) {
    return { intent: "information", complexity: "low", shouldDelegate: false, reason: "definition_or_transformation" };
  }

  const hasComplexAction = HIGH_COMPLEXITY_ACTION.test(taskText);
  const hasContext = COMPLEXITY_CONTEXT.test(taskText);
  const hasMultiStep = EXPLICIT_MULTI_STEP.test(taskText);
  const hasMultipleQuestions = (taskText.match(/[?？]/g) || []).length >= 2;
  const hasStructuredRequest = /(?:整理し|洗い出し|具体的に提案|優先順位を付け|根拠とともに|複数案|比較検討)/.test(taskText);

  // Length alone never triggers a paid provider. A meaningful task signal is required.
  const shouldDelegate = hasComplexAction && (hasContext || hasMultiStep || hasStructuredRequest);
  return {
    intent: shouldDelegate ? "specialist_analysis" : "general",
    complexity: shouldDelegate || hasMultipleQuestions ? "high" : "low",
    shouldDelegate,
    reason: shouldDelegate
      ? hasMultiStep || hasStructuredRequest ? "multi_step_complex_task" : "complex_action_with_context"
      : "no_sufficient_complexity_signal"
  };
}

function getAutoCommanderConfig({ autoCommander, text, env = process.env }) {
  const taskText = autoCommander === true && typeof text === "string" ? text.trim() : "";
  const classification = classifyCommanderTask(taskText);
  const flagsEnabled =
    env.JARVIS_AUTO_COMMANDER_ENABLED === "true" &&
    env.JARVIS_AI_COUNCIL_ENABLED === "true" &&
    env.JARVIS_AI_COUNCIL_PAID_PROVIDERS_ENABLED === "true";
  const provider =
    env.OPENAI_API_KEY && env.JARVIS_OPENAI_MODEL
      ? "openai"
      : env.ANTHROPIC_API_KEY && env.JARVIS_ANTHROPIC_MODEL
        ? "anthropic"
        : null;
  const eligible = Boolean(
    autoCommander === true &&
    flagsEnabled &&
    classification.shouldDelegate &&
    provider
  );
  return { taskText, eligible, provider: eligible ? provider : null, classification };
}

module.exports = { classifyCommanderTask, getAutoCommanderConfig };
