# F.R.I.D.A.Y. Integration Contract (Design Baseline)

Status: design only. This document does not implement or deploy F.R.I.D.A.Y.

## Goal

Keep F.R.I.D.A.Y. as an independent monitoring and safety system that can report to J.A.R.V.I.S. without giving J.A.R.V.I.S. authority to weaken, disable, or rewrite F.R.I.D.A.Y.'s monitoring.

Principle: **J.A.R.V.I.S. does the work; F.R.I.D.A.Y. watches safety.**

## System boundaries

- J.A.R.V.I.S. remains the user-facing orchestrator for tasks, connected AI providers, Google integrations, and approved actions.
- F.R.I.D.A.Y. is a separately deployed service/process with its own identity, credentials, configuration, logs, and alert path.
- Do not put F.R.I.D.A.Y.'s enforcement logic inside a prompt or rely on an LLM to enforce its own safety rules.
- Do not share privileged credentials between the two systems. J.A.R.V.I.S. must not have write access to F.R.I.D.A.Y.'s configuration, logs, or deployment.
- F.R.I.D.A.Y. must alert the user through a path that does not depend on J.A.R.V.I.S. being available.

## Initial communication contract

Use a narrow, versioned event interface. Start with F.R.I.D.A.Y. sending events to J.A.R.V.I.S.; do not provide a general-purpose command channel from J.A.R.V.I.S. to F.R.I.D.A.Y.

Suggested event fields:
- `schema_version`: currently `1`
- `event_id`: unique identifier for replay protection
- `occurred_at`: UTC timestamp
- `severity`: `info`, `warning`, `high`, or `critical`
- `category`: stable machine-readable category
- `summary`: short sanitized description
- `evidence_ref`: optional reference to evidence held in F.R.I.D.A.Y.; avoid sending secrets or full sensitive logs
- `recommended_action`: advisory only, never an executable command

J.A.R.V.I.S. should acknowledge receipt, record the event, and present it to the user. An acknowledgement is not proof that the alert was seen or acted upon.

## Authentication and transport

- Use HTTPS only.
- Authenticate each event using a dedicated service credential or request signature, separate from all Google, Gemini, and Supabase credentials.
- Include timestamp and unique event ID; reject stale requests and duplicate IDs.
- Apply request size limits, rate limits, schema validation, and secret-safe error responses.
- Store credentials only in server-side environment variables/secret storage. Never expose them in browser code, logs, URLs, or prompts.
- Rotate credentials independently and document a revocation procedure.
- Do not trust a claimed severity or action solely because it appears in the payload; validate sender identity and schema.

## Authority and safety

- J.A.R.V.I.S. may read and summarize F.R.I.D.A.Y. events. It must not be able to modify F.R.I.D.A.Y. monitoring rules, silence alerts, erase its logs, or disable its service.
- Any future request channel must be explicitly allowlisted and separately authorized. No arbitrary shell commands, SQL, deployment changes, or configuration writes.
- Monitoring and notification are distinct from enforcement. To block a dangerous operation, the relevant action must pass through an independent policy gate that can deny it. An alert alone cannot guarantee that an operation is stopped.
- Default to alert-and-deny for high-risk operations when the independent policy gate is unavailable; for ordinary low-risk tasks, J.A.R.V.I.S. can continue if F.R.I.D.A.Y. is offline.
- Emergency stop permissions, if implemented, must be narrow, auditable, and unable to expand privileges or disable monitoring.

## Availability and failure handling

- F.R.I.D.A.Y. must continue collecting local/remote monitoring signals and issuing its own alerts when J.A.R.V.I.S. is offline.
- If J.A.R.V.I.S. is unavailable, queue events with bounded retention and retry with backoff; do not retry indefinitely or flood the receiver.
- If F.R.I.D.A.Y. is unavailable, J.A.R.V.I.S. must mark monitoring as degraded and must not claim that safety monitoring is active.
- Deduplicate repeated alerts and preserve timestamps and source references.
- Never silently treat an unconfirmed alert as resolved.

## Implementation sequence

1. Keep this contract as a design baseline while J.A.R.V.I.S. features are completed.
2. Before implementing the connector, define the actual F.R.I.D.A.Y. runtime/hosting and alert channel.
3. Add a read-only, authenticated event receiver to J.A.R.V.I.S. on a development branch.
4. Test valid events, invalid signatures, stale timestamps, duplicate IDs, oversized payloads, rate limits, receiver outage, and secret redaction.
5. Build F.R.I.D.A.Y. independently and verify that J.A.R.V.I.S. cannot alter its configuration or suppress its alerts.
6. Enable production integration only after end-to-end tests and an explicit deployment review.

## Not decided yet

- F.R.I.D.A.Y. hosting/runtime and who owns its deployment.
- Independent alert delivery channel.
- The precise categories and thresholds for monitored events.
- Whether a specific high-risk operation needs a policy gate and which system enforces it.
- Retention period for event metadata and evidence.

These decisions should be made before writing production integration code.