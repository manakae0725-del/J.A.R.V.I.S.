# Weather Integration — Design

Status: design draft only. No dedicated Weather API integration, scheduled weather retrieval, or live HUD data binding has been deployed.

## Product intent

Provide J.A.R.V.I.S. with reliable current conditions and forecasts for the user's configured location. Weather is a dedicated structured data capability, separate from general web search. Conversational answers may still use the existing search system for broader weather questions or source verification.

## Existing implementation baseline (inspected 2026-11-03)

- `api/gemini.js` detects weather-related user text and converts it to a Serper query. The default location is currently hardcoded as `札幌市`; a limited set of Japanese city/ward names can override it.
- The existing Serper response's `data.weather` object is appended to the Gemini search context when present. It is not normalized into a stable application weather model.
- `lib/searchManager.js` treats weather as a reason to use the existing Serper search path; it does not provide a dedicated forecast data contract.
- `public/index.html` contains a WEATHER HUD card with hardcoded sample values (currently Tokyo, 13°C, cloudy, high 15°C, low 8°C, and sample hourly slots). The inspected code did not show a live weather-data binding or a refresh mechanism for this card.
- The existing background worker is already scheduled by Supabase `pg_cron` once per minute and calls the existing `/api/gemini` handler. Any scheduled weather work must reuse existing infrastructure where practical and must not create another Vercel function without checking the Hobby 12-function limit.
- No dedicated weather storage/cache, scheduled morning/evening weather task, or weather settings UI was found in the inspected files.

## User decisions and constraints

- Retrieve weather once in the morning and once in the evening.
- Do not continuously poll weather during the day.
- Allow an on-demand refresh through a voice command.
- Keep the last successful result visible in the HUD.
- Safari browser geolocation and the earlier Open-Meteo approach were discontinued; do not reintroduce them without a new decision.
- Prefer Google Weather integration as part of the Google/external-services phase.
- Minimize cost and avoid adding a recurring paid service without explicit approval.

## Proposed architecture

1. Use Google Maps Platform Weather API for structured weather data after verifying the final pricing, API terms, and billing setup.
2. Keep the API key server-side only. The browser must call the existing authenticated J.A.R.V.I.S. API layer; never expose the Weather API key in `public/index.html`.
3. Extend the existing `/api/gemini` handler with a bounded weather operation, or share an internal weather module from that handler. Do not add a standalone Vercel API route unless the current function count and deployment constraints have been rechecked.
4. Normalize provider responses into one internal weather model: location, observation/fetch time, current temperature/condition, daily high/low, hourly forecast entries, precipitation probability, and provider/source metadata. Preserve provider timestamps and timezone.
5. Use a configured location rather than requesting GPS permission from Safari. Make the location changeable through settings in a later UI step. Initial default can be Sapporo, Japan; do not silently infer a more precise address.
6. Cache the last successful normalized response per authenticated user/device using a storage design that does not misuse conversational memory. Until an approved persistent store is available, a device-local cache may be used for HUD continuity, clearly labeled with its last-updated time. Do not create finance tables or use the household-finance schema for weather.
7. Bind the HUD fields to actual cached data. Show a clear unavailable/stale state instead of sample weather values when no valid result exists.
8. The existing background scheduler may dispatch a weather refresh only at the two configured windows (morning and evening). It must not make a Weather API request on every minute tick; use a due-time/last-success guard and idempotency. The exact times and notification behavior require a separate decision before implementation.
9. On-demand voice requests should refresh or return a sufficiently recent cached result according to an explicit freshness rule. The assistant must state the observation/update time and distinguish current conditions from forecast.
10. Keep general web search available for questions outside the structured forecast scope; avoid making a second paid search call when a successful dedicated weather result already answers the request.

## Google Weather API cost and access notes (checked 2026-11-03)

- The official Weather API documentation lists current conditions, up to 10 days of daily forecasts, up to 240 hours of hourly forecasts, up to 24 hours of hourly history, and public weather alerts.
- Production use requires billing to be enabled on the Google Cloud project and an API key or OAuth token on each request.
- The current official pricing table lists a 10,000-request monthly free usage cap for the Weather Usage SKU, then a listed first paid tier of USD $0.15 per 1,000 requests (pricing tiers may vary by volume/region and must be rechecked before activation).
- The official Google Maps Platform page offers a no-credit-card demo key for a controlled sandbox; this is for prototyping and must not be assumed to be a production credential.
- With only two scheduled refreshes per day, a single endpoint would use about 60 requests per 30-day month per configured location, excluding on-demand requests. Separate current-conditions, hourly, and daily endpoints multiply that count. This is well below the published 10,000-request free cap at the expected household scale, but billing still must be enabled for production and overages remain possible.
- Do not activate billing or create/rotate production API keys without explicit user approval. Set quotas and billing alerts before production use.

## Implementation phases

### Phase A — Complete design
- Confirm the configured location behavior and timezone.
- Confirm morning/evening schedule times and whether a report should be spoken, shown in HUD, or both.
- Define cache freshness, stale fallback, and failure behavior.
- Recheck API pricing, terms, request fields, and exact endpoint count.

### Phase B — API and data normalization
- Add the server-side provider client using existing API routing.
- Add schema validation, timeouts, bounded response fields, and safe error handling.
- Add per-user/device cache without using conversational memory or finance data.
- Record request counts without logging precise location or API secrets.

### Phase C — HUD and conversational integration
- Replace all static sample values with data-bound fields.
- Add last-updated time and stale/unavailable states.
- Route weather questions to structured weather data when appropriate; retain general search fallback.

### Phase D — Schedule and verification
- Reuse the existing minute scheduler only with a due-time guard; no minute-by-minute weather API polling.
- Implement the two configured daily refresh windows and on-demand refresh.
- Test timezone boundaries, duplicate prevention, provider failure, stale cache, multiple users/devices, and voice/text modes.
- Deploy to Preview only. Production release and billing activation require explicit approval.

## Non-goals

- No continuous daytime polling.
- No browser geolocation prompt.
- No Open-Meteo reintroduction.
- No new paid weather subscription beyond the approved Google Weather API usage.
- No new Vercel function unless function-count review and user approval allow it.
- No finance schema or household-finance implementation as part of weather work.
