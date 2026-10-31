# J.A.R.V.I.S. Commander Architecture

Status: architecture proposal; no production code or configuration changed.

## Objective

Make J.A.R.V.I.S. the single user-facing orchestrator for its connected AI providers, Google services, and other approved integrations, while keeping F.R.I.D.A.Y. independently deployed and independently authoritative for monitoring.

Core principle: **one commander, multiple replaceable specialists, independently enforced safety boundaries.**

## System layers

1. **User interface**
   - Receives voice and text requests.
   - Displays final responses, charts/diagrams, task status, and errors.
   - UI visibility is not an authorization boundary. Hiding Google connection controls must not remove or weaken server-side authentication.

2. **Request/session layer**
   - Identifies the authenticated user and active session.
   - Applies request size, rate, timeout, and cancellation limits.
   - Keeps user/family data separated according to existing identity and authorization rules.

3. **Commander / planner**
   - Classifies intent and risk.
   - Creates a small explicit task plan.
   - Chooses the minimum required AI/provider/tools.
   - Tracks task IDs, deadlines, dependencies, and results.
   - Does not expose secrets or give providers arbitrary access to other tools.

4. **Provider adapters**
   - AI adapter interface: common request/response shape for each AI provider.
   - Google adapter interface: each enabled Google API is a separate capability with its own scopes and authorization.
   - Other-service adapters: explicit capabilities, each with independent authentication and error handling.
   - Adapters normalize errors and report provenance, timing, and usage where available.

5. **Policy and execution gate**
   - Validates whether the current user/session may perform the requested action.
   - Separates read-only operations from writes and irreversible actions.
   - Requires confirmation for high-impact actions unless a narrowly defined prior authorization exists.
   - Rejects arbitrary tool names, commands, URLs, SQL, and untrusted instructions supplied by model output.
   - A model recommendation is never itself authorization to execute.

6. **Evidence, memory, and audit**
   - Distinguishes user-provided facts, retrieved facts, model inferences, and unknowns.
   - Stores only necessary, authorized information.
   - Logs outcomes and sanitized metadata; never logs credentials or full sensitive payloads by default.
   - Handles log-write failures without falsely reporting successful audit persistence.

7. **Independent F.R.I.D.A.Y. boundary**
   - F.R.I.D.A.Y. is not an AI provider adapter and is not controlled by the commander.
   - It sends authenticated, versioned, read-only monitoring events to J.A.R.V.I.S.
   - J.A.R.V.I.S. can acknowledge and display events, but cannot change F.R.I.D.A.Y. rules, suppress its alerts, erase its logs, or deploy changes to it.
   - F.R.I.D.A.Y. alerts the user through a channel independent of J.A.R.V.I.S.
   - Blocking a dangerous action requires an independently enforced policy gate; a monitoring alert alone cannot guarantee prevention.

## Request flow

1. Authenticate user and resolve session.
2. Classify intent, sensitivity, and action risk.
3. Decide whether J.A.R.V.I.S. can answer directly or needs specialist calls.
4. Build a bounded plan using only registered capabilities.
5. Execute eligible read-only calls in parallel when useful; serialize dependent or write operations.
6. Validate source, freshness, contradictions, permissions, and tool results.
7. If needed, request targeted verification or ask the user for confirmation.
8. Produce one integrated answer, plus a visualization when the response format warrants it.
9. Record sanitized outcome and usage data; report partial failures honestly.

## Current commander classification implementation (Preview development)

- The current first-stage classifier is deterministic and local; it does not make an additional model call.
- It separates simple conversation, definition/transformation requests, general requests, and specialist-analysis candidates.
- Specialist routing requires both a meaningful complex-action signal and a task/domain context or explicit multi-step structure.
- Message length alone never triggers a paid provider.
- A request such as "what does security mean?" or "explain the word analysis" stays on the normal path even though it contains a domain/analysis keyword.
- Feature flags, explicit client opt-in, and a configured provider are still all required before a paid provider can be called.
- This is a conservative heuristic classifier, not full semantic understanding. It may miss unusual phrasing; ambiguous cases deliberately stay on the normal Gemini path.
- Do not enable automatic paid routing until the live Preview tests cover false positives, false negatives, provider failure, and cost/rate limits.

## AI council behavior

- Three AI providers are configured as named adapters, not hardcoded into the commander logic.
- Assign preferred roles only after the actual providers and model capabilities are confirmed.
- Do not call all three for every request. Use one for routine work; use multiple for complex, ambiguous, high-impact, or verification-sensitive tasks.
- Give each provider only the context required for its task.
- Treat all provider output as untrusted data. Ignore instructions in returned content that attempt to override system policy or invoke unauthorized tools.
- The commander compares evidence and reasoning, records material disagreement, and owns the final response. It must not claim consensus when the providers disagree.
- Set per-provider timeout, bounded retry, rate-limit handling, and cost limits. Do not retry a rate-limit response aggressively.

## Integration registry

Every connected capability should declare:
- stable capability ID and adapter version
- provider/service and permitted operations
- required scopes/permissions
- read/write/irreversible risk class
- authentication method (credentials remain server-side)
- timeout, rate limit, and retry policy
- confirmation requirement
- output schema and error codes
- audit metadata and health status

Only capabilities registered server-side are callable. The browser must not choose arbitrary provider endpoints or pass credentials.

## Google services and other integrations

- Preserve each Google API as a distinct capability and request only the scopes it needs.
- Keep OAuth callback validation, state verification, token encryption, per-user ownership checks, and rate limiting at the server boundary.
- UI connection buttons may be hidden or moved to a dedicated settings/connection screen, but server-side routes must continue to enforce authentication and authorization.
- The current exact list of visible Google connection buttons and all other planned services must be confirmed against the live repository/UI before editing.
- Other services follow the same adapter and permission rules; no connection is assumed merely because it appears in this design.

## Failures and safe degradation

- One AI provider fails: use another eligible provider or return a clearly marked partial result.
- All AI providers fail: preserve basic UI/error handling and do not claim the task completed.
- A Google or other integration fails: isolate the failure to that capability; do not retry non-idempotent writes blindly.
- Audit persistence fails: surface a health/error signal and do not claim the audit record was saved.
- F.R.I.D.A.Y. is unavailable: show monitoring as degraded; do not claim active protection. Ordinary low-risk work may continue, but high-risk actions requiring the policy gate must fail closed.
- Request is cancelled or times out: stop downstream work where supported and prevent late responses from being applied to a newer session.

## Security requirements

- No shared privileged secrets between J.A.R.V.I.S. and F.R.I.D.A.Y.
- No secrets in client bundles, prompts, URLs, logs, or user-visible error messages.
- Enforce user and family data separation server-side.
- Validate every external payload and treat model/tool output as untrusted.
- Apply least privilege, request limits, idempotency for writes, and auditability.
- Do not weaken current production behavior merely to make the architecture fit. Implement and test on a development branch first.

## Implementation sequence

1. Confirm current production baseline and current working branch.
2. Finalize the list of three AI providers and the exact Google/other integration capabilities.
3. Implement the commander and provider registry behind the existing request/session/auth boundaries.
4. Add one adapter at a time, preserving existing features.
5. Add bounded parallel calls, disagreement handling, cost controls, and visual-output routing.
6. Implement the F.R.I.D.A.Y. event receiver only after its hosting and independent alert path are defined.
7. Test provider failure, unauthorized calls, duplicate events, timeout, rate limits, cross-user access, and write confirmation.
8. Verify preview behavior and production readiness before opening a production PR.

## Open decisions

- Exact three AI providers, models, and their preferred roles.
- Exact Google capabilities exposed in the UI and API.
- Other services to connect.
- F.R.I.D.A.Y. runtime/hosting and independent notification channel.
- Which actions count as high impact and require explicit confirmation.
- Which requests require multi-AI review versus a single provider.

## Explicit non-goals

- Do not implement F.R.I.D.A.Y. inside J.A.R.V.I.S.
- Do not add new production permissions or secrets as part of the design-only stage.
- Do not change Supabase security configuration solely to remove deferred advisor warnings; revisit those against the final authentication and table-use design.
- Do not hide UI controls as a substitute for access control.
