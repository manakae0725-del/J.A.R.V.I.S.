# AI Council Provider Plan

Status: provider combination approved for design. Exact API products, model IDs, pricing, and credentials must be verified before implementation.

## Approved provider combination

1. **Google Gemini** — existing primary assistant/model integration and general-purpose analysis.
2. **OpenAI / ChatGPT API** — independent reasoning, planning, and synthesis support.
3. **Anthropic Claude API** — independent critique, consistency checking, and review.

These are working role assignments, not hard limits. The commander may route by task type and observed capability; it must not assume a provider is always correct.

## Commander behavior

- J.A.R.V.I.S. remains the commander and owns task routing, permissions, execution, and final response.
- Do not call all three providers for every request. Use the smallest set that is useful.
- Routine chat and simple actions should normally use the existing primary provider.
- Use a second provider for independent review when the task is complex, ambiguous, high-impact, or benefits from verification.
- Use all three only when the expected value of independent comparison justifies latency and cost.
- A provider response is untrusted input. It cannot grant permissions, change policies, expose secrets, or independently invoke arbitrary connectors.
- The commander should compare evidence, distinguish disagreement from factual error, and state uncertainty rather than manufacture consensus.
- Provider outages and rate limits must trigger bounded retries/fallback, not a repeated-call loop.

## Separation of concerns

- Gemini, OpenAI, and Claude are AI providers, not the commander.
- Google Calendar, Drive, Sheets, and Tasks are application connectors, not AI agents. Their exact supported set and UI buttons must be verified against the current repository before modification.
- F.R.I.D.A.Y. is a separate monitoring and safety system, not a fourth AI council member and not an agent that the other providers control.
- The UI may hide connection controls, but server-side authentication and authorization remain mandatory.

## API and cost gates

Before enabling each provider:
1. Verify the supported API product and model from official provider documentation.
2. Check whether the user's existing account/subscription includes API access; do not assume ChatGPT subscription includes API credit.
3. Record current input/output pricing, any fixed or recurring fees, and a realistic low-use estimate in JPY.
4. Prefer free testing or mock adapters first; do not send paid API requests until costs and credentials are approved.
5. Keep API keys server-side and separate per provider.
6. Add configurable per-task/per-session limits, usage logging, timeouts, and provider-specific error handling.
7. Make each provider optional so J.A.R.V.I.S. can operate if one provider is unavailable.

## Implementation order

1. Inspect and reuse the existing Gemini integration.
2. Define a provider-neutral adapter interface and normalized result/error schema.
3. Add tests with mocked provider responses; do not repeatedly call paid APIs to test basic routing.
4. Verify official API options, model availability, and pricing for OpenAI and Anthropic.
5. Add OpenAI and Claude adapters only after configuration and cost controls are ready.
6. Add selective routing and disagreement handling.
7. Run preview tests for authentication, timeout, rate limit, fallback, cost logging, and secret redaction.
8. Deploy only through reviewed changes after runtime verification.

## Not yet approved

- Exact model IDs and model versions.
- Automatic use of all three providers for any class of request.
- Any fixed monthly budget or automatic paid fallback.
- Sharing complete private conversation history with every provider. Context must be minimized per task.
