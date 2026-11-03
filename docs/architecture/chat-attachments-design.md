# J.A.R.V.I.S. Chat Attachments — Design

Date: 2026-11-02
Branch: `perf/response-speed-memory-cache`
Status: generic attachment flow implemented on the development branch; finance-specific parsing and persistence remain design-only. Video support is deferred.

## Goal

Allow a user to attach files and images directly in the J.A.R.V.I.S. chat composer, alongside ordinary text. The same feature supports:
- Household finance: payslips, receipts, invoices, statements, and supporting images.
- General assistant use: screenshots, photos, PDFs, and text documents.
- Follow-up questions about an attachment in the same conversation.

Google Drive is not a prerequisite for household finance. Kaede does not need access to Manato's Drive. Each user uploads their own file through their own authenticated J.A.R.V.I.S. session.

## Implemented code facts (development branch)

- The chat composer in `public/index.html` supports selecting image, PDF, and plain-text attachments.
- Attachments are sent through the existing `/api/gemini` route; no separate API route was added for upload handling.
- `api/gemini.js` contains the signed-upload preparation and attachment processing path.
- Current user-facing limits: up to 5 files per message and 20 MB total. Supported formats in the current UI include JPEG, PNG, WebP, PDF, and plain text.
- A mobile filename-overflow issue was fixed in commit `6f9e5d1c3a8418b91755170d8f1610ec76572bcf`. The user chose not to run additional attachment-specific tests after this fix; do not describe the fix as independently verified by a new test.
- Video selection/processing is not supported and is deferred.
- The household-finance feature must reuse this existing attachment path; it must not infer that a chat attachment is automatically a saved finance document or a confirmed ledger record.
- Do not add a new `api/**` route until the Vercel Hobby 12-function limit is measured against the exact source tree. Prefer extending the existing authenticated `/api/gemini` route through explicit modes/actions.

## Proposed user experience

1. Add an attachment control beside the existing text input / transmit button.
2. iPhone supports Files picker and Photos/Camera selection; desktop supports file picker and drag-and-drop.
3. Show a compact preview list with filename, type, size, remove control, and image thumbnail where applicable.
4. Text and attachments are sent as one conversation turn. Empty text is allowed when at least one attachment is selected.
5. The assistant can answer questions about the attached content and use the extracted facts in the current turn.
6. For household finance, J.A.R.V.I.S. first extracts candidate values, then asks the owner to confirm before creating income/expense/payroll records.
7. Attachments are temporary by default. Persist a document only after an explicit user request such as “save this document”; payroll records store normalized confirmed values and minimal file metadata rather than silently retaining the original.

## Recommended secure transfer architecture

Use a private Supabase Storage bucket for short-lived uploads, not public URLs and not base64 in the browser's conversation JSON.

1. The signed-in client requests an upload authorization from the existing authenticated API route.
2. Server validates the caller via `requireAuth`, checks allowlisted file MIME/size/count, and creates a server-controlled object path containing the authenticated user ID and random identifier.
3. Server issues a short-lived signed upload URL for the private bucket. The client uploads the raw file directly to Storage; file bytes do not pass through Vercel's request-body parser.
4. Client sends only opaque attachment IDs/object paths plus text to `/api/gemini`.
5. Server revalidates the caller and verifies every object belongs to that caller and an unexpired upload record. Never trust a client-supplied arbitrary bucket path.
6. Server downloads the file bytes from private Storage and passes supported MIME types to Gemini Interactions as multimodal content (image/document/text). Do not give the model a public or permanent file URL.
7. After successful analysis, delete temporary objects and mark upload records consumed. A scheduled cleanup removes abandoned uploads. If cleanup cannot be guaranteed initially, enforce a short TTL and opportunistic cleanup.
8. No file bytes, OCR text, payslip values, signed URLs, or access tokens in application logs.

Supabase Storage private buckets enforce access control on upload/download; signed upload URLs are temporary bearer capabilities. The bucket and policies must be designed accordingly. See official docs: https://supabase.com/docs/guides/storage/buckets/fundamentals and https://supabase.com/docs/reference/javascript/file-buckets-uploadtosignedurl.

## Initial scope and limits

- First supported formats: JPEG, PNG, WebP, PDF, and plain text. Add HEIC and Office formats only after verifying runtime conversion / model support.
- Initial conservative limits: up to 5 files per message; image 10 MB each; PDF 15 MB each; text 1 MB each; total 20 MB per message. Revisit after measuring Vercel memory/runtime and Gemini token/cost impact.
- Reject MIME/extension mismatches, zero-byte files, oversized files, unsupported formats, malformed files, and suspicious filenames. Use server-side MIME sniffing; the browser-provided MIME type is not authoritative.
- Random object keys; never use raw filenames as storage paths.
- Private bucket; no public bucket, public URL, or permanent signed read URL.
- Keep file content out of conversation history unless the user explicitly chooses to retain it. Store only attachment metadata needed for the active turn, with short expiry.
- Avoid OCR as a separate paid service initially. Gemini can interpret PDFs using native vision and can extract tables/layout; use model output as untrusted candidate data requiring confirmation for finance actions.
- For large files or files reused across turns, evaluate Gemini Files API. Uploaded Gemini files are retained for 48 hours; if used, delete when supported and document retention. Prefer inline multimodal input for small one-shot files.

## Security and privacy

- User A cannot upload, read, analyze, or delete User B's temporary objects.
- The client cannot select another user's object key or set ownership/retention fields.
- Each household member uploads their own payslip or receipt. The other member sees confirmed shared finance fields, not private chat attachments or the uploader's unrelated documents.
- Household sharing of a parsed salary requires the salary owner to explicitly confirm it.
- Prompt injection inside PDFs/images is untrusted document content, not instructions. The system prompt must explicitly treat attachment contents as data.
- Redact sensitive data from errors and telemetry. Do not log raw model input or attachment content.
- Rate-limit upload authorization and analysis separately; impose per-user quotas and cleanup.
- Do not create or modify Storage buckets/policies or DB tables until the exact design and SQL are reviewed and approved.

## Vercel / implementation constraints

- Vercel Hobby functions have a 12-function deployment cap. Do not create a new API file until current function count is confirmed.
- Extend `/api/gemini` with narrowly scoped actions or an internal upload authorization helper.
- Keep upload bytes off the Vercel request body by using signed Storage uploads.
- The existing `api/gemini.js` endpoint has long-running AI paths; validate maximum file size, total memory use, and execution time before enabling multiple PDFs.
- Do not change Production, main, or live Supabase during initial implementation.

## Implementation stages

1. UI attachment selection, previews, removal, and request-state model.
2. Private Storage upload authorization and temporary upload lifecycle.
3. Gemini multimodal request handling for images and PDFs.
4. Attachment safety tests and two-account isolation tests.
5. Finance-specific payslip/receipt extraction schemas and owner confirmation.
6. Explicit save/retention workflow, quotas, cleanup, and user-facing errors.
7. Dashboard and ledger integration after core finance schema is approved.

## Required tests

- No attachment: existing text-only flow unchanged.
- Image-only and text-plus-image requests work.
- PDF-only and text-plus-PDF requests work.
- Multiple attachments within limits work.
- Invalid MIME, spoofed extension, malformed file, zero-byte, oversize, and too many files rejected.
- Signed URL expiry and replay behavior understood and bounded.
- Cross-user upload/read/delete attempts fail.
- Arbitrary object paths and altered ownership are rejected.
- Upload interrupted / analysis failed / cleanup failed paths are safe and recoverable.
- No attachment content or sensitive payroll data appears in logs.
- Existing streaming, Commander routing, voice output, and conversation continuity remain unchanged.
- Finance extraction never writes a transaction or salary record without explicit confirmation.
