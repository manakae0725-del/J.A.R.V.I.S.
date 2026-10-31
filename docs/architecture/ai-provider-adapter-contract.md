# AI Provider Adapter Contract

Status: implementation contract for development work. This is not an active API endpoint and does not make provider calls.

## Adapter API

Each provider adapter should expose the same internal method:

```js
async function generate({
  taskId,
  systemInstruction,
  userInput,
  context,
  outputFormat,
  deadlineMs,
  maxOutputTokens,
  signal
}) {
  // returns normalized result or throws a normalized provider error
}
```

The implementation must follow the repository's existing module style and runtime conventions. Do not paste this illustrative signature directly into production without checking the current codebase.

## Normalized success result

```json
{
  "ok": true,
  "provider": "gemini | openai | anthropic",
  "model": "configured-model-id",
  "text": "provider response text",
  "structured": null,
  "usage": {
    "inputTokens": null,
    "outputTokens": null
  },
  "durationMs": 0,
  "requestId": null
}
```

Token counts and request IDs are nullable because provider APIs differ. Never fabricate missing usage values.

## Normalized error classes

- `CONFIGURATION_MISSING`: required server-side key or model setting is missing.
- `AUTHENTICATION_FAILED`: provider rejected credentials.
- `RATE_LIMITED`: provider throttled the request; respect retry guidance and do not retry immediately in a loop.
- `TIMEOUT`: deadline exceeded.
- `CANCELLED`: caller cancelled the task.
- `PROVIDER_UNAVAILABLE`: temporary upstream failure.
- `INVALID_RESPONSE`: malformed or unsupported provider response.
- `BUDGET_EXCEEDED`: configured local usage/cost limit reached.
- `UNKNOWN_PROVIDER_ERROR`: sanitized fallback class.

User-facing messages must not expose keys, raw authorization headers, full upstream bodies, or sensitive prompts.

## Routing contract

The commander supplies an allowlisted provider ID; model output cannot choose a new provider, arbitrary URL, or credential. The routing layer:
1. checks task policy and configured provider availability;
2. computes the deadline and applicable usage budget;
3. passes only minimum necessary context;
4. invokes the adapter with cancellation support;
5. validates the normalized response;
6. records sanitized usage/status metadata if the existing logging path is available;
7. applies bounded retry/fallback rules;
8. returns a partial result or a clear error when no eligible provider remains.

## Cost control

- Provider adapters must not perform hidden retries beyond a documented bounded policy.
- Set a maximum output token count for every request.
- Do not automatically fan out to all providers.
- Do not infer USD/JPY conversion or total costs from token counts without current pricing and exchange-rate inputs.
- Until actual model IDs, prices, and budget limits are confirmed, paid OpenAI and Anthropic calls remain disabled by configuration.
- Unit tests use fake adapters and must not call provider APIs.

## Required test cases

1. Provider missing configuration.
2. Valid normalized response.
3. Malformed provider response.
4. Timeout and cancellation.
5. Rate limit with retry-after handling.
6. Authentication failure.
7. Budget exhausted before call.
8. Secret redaction in logs and errors.
9. Fallback to one configured provider without a fan-out loop.
10. Disagreement between providers is surfaced, not silently flattened.
11. Per-user context is minimized and never crosses user boundaries.
12. External writes are still blocked unless the separate policy gate authorizes them.

## Integration constraints

- Keep the existing Gemini endpoint behavior and authentication/rate-limit checks intact.
- Reuse existing usage logging when compatible; do not add a parallel logging system without need.
- Keep provider API keys server-side.
- Do not introduce a new dependency if the existing runtime can implement the required HTTP calls safely.
- Do not enable new providers in production until mocked tests, preview checks, cost controls, and secret-redaction checks pass.
