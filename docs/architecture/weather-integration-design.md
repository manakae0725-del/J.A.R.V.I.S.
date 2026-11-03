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

- Retrieve weather once in the morning at 07:30 JST and once in the evening at 22:00 JST (Asia/Tokyo). These times may be made configurable later.
- Scheduled retrieval refreshes the HUD only. Automatic spoken announcements are not enabled; that behavior remains a separate future decision.
- Do not continuously poll weather during the day.
- Allow an on-demand refresh through a voice command.
- Keep the last successful result visible in the HUD.
- Use Sapporo, Japan as the initial configured location; do not request browser GPS or infer a more precise address. A location setting can be added later.
- Safari browser geolocation and the earlier Open-Meteo approach were discontinued; do not reintroduce them without a new decision.
- Google Cloud registration and Google Weather API setup are deferred. Do not ask the user to register or enable billing for the current weather implementation. Revisit Google Cloud only if a concrete future integration requires it.
- Minimize cost and do not add a recurring paid service without explicit approval.

## Provider re-evaluation (2026-11-03)

**Google Weather API is not suitable for the initial Japan deployment.** Google's official FAQ explicitly excludes Japan and South Korea from coverage. Do not enable the Weather API for J.A.R.V.I.S. Japan weather retrieval, create a production Weather API key, or activate billing for this purpose. A Google Cloud account may still be useful for unrelated Google integrations, but registration is currently deferred.

### Japan-capable candidates under review

- **Japan Meteorological Agency (JMA) public data:** JMA publishes prefectural forecasts, weekly forecasts, observations, and machine-readable disaster-weather XML. Its information catalog documents forecast content and publication frequency. However, a stable, supported public REST forecast API/SLA is not established by these pages; website JSON endpoints used by third parties must be treated as undocumented and potentially changeable. Check JMA's content terms and attribution requirements before implementation.
- **TenkiNow (unofficial AMeDAS observation API):** a no-key JSON service for nearby station observations, not forecasts. Its own documentation says it is unofficial, returns station observations rather than interpolated point estimates, and should not be used for safety-critical purposes. It could be an optional current-observation source, not the forecast source.
- **Japan Weather Association Weather Data API:** Japan-specific high-resolution data and forecast coverage, but it is a paid commercial service. Its published pricing starts at JPY 32,000/month for credit-card billing; not appropriate for the current cost-minimizing household use unless the scope changes and the user explicitly approves.
- **Google Weather API:** excluded for Japan due to the provider's stated coverage restriction.

### Current decision

Provider selection remains **OPEN**. Prefer a stable, Japan-supported, low-cost source with clear display/cache/redistribution terms. Do not commit to a paid provider or introduce a new API key until source coverage, legal terms, cost, and required forecast fields have been checked. Keep the internal normalized weather model provider-neutral so the UI and scheduler do not depend on one vendor.

## Proposed architecture

1. Use a Japan-supported weather source selected after the provider re-evaluation above. Keep the provider behind a server-side adapter.
2. Keep the API key server-side only. The browser must call the existing authenticated J.A.R.V.I.S. API layer; never expose a Weather API key in `public/index.html`.
3. Extend the existing `/api/gemini` handler with a bounded weather operation, or share an internal weather module from that handler. Do not add a standalone Vercel API route unless the current function count and deployment constraints have been rechecked.
4. Normalize provider responses into one internal weather model: location, observation/fetch time, current temperature/condition, daily high/low, hourly forecast entries, precipitation probability, and provider/source metadata. Preserve provider timestamps and timezone.
5. Use the configured location (initially Sapporo, Japan) rather than requesting GPS permission from Safari. Make the location changeable through settings in a later UI step. Do not silently infer a more precise address.
6. Cache the last successful normalized response per authenticated user/device using a storage design that does not misuse conversational memory. Until an approved persistent store is available, a device-local cache may be used for HUD continuity, clearly labeled with its last-updated time. Do not create finance tables or use the household-finance schema for weather.
7. Bind the HUD fields to actual cached data. Show a clear unavailable/stale state instead of sample weather values when no valid result exists.
8. The existing background scheduler may dispatch weather refreshes only at 07:30 and 22:00 JST (Asia/Tokyo). These are the confirmed default times and may become configurable later. Scheduled work refreshes the HUD only; it does not speak an announcement. It must not make a Weather API request on every minute tick; use a due-time/last-success guard and idempotency.
9. On-demand voice requests should refresh or return a sufficiently recent cached result according to an explicit freshness rule. The assistant must state the observation/update time and distinguish current conditions from forecast.
10. Keep general web search available for questions outside the structured forecast scope; avoid making a second paid search call when a successful dedicated weather result already answers the request.

## Previously researched Google Weather API pricing and access (not selected for Japan)

This section is retained as historical research only. Google Weather API is not selected for Japan and Google Cloud registration is deferred.

- The official Weather API documentation lists current conditions, up to 10 days of daily forecasts, up to 240 hours of hourly forecasts, up to 24 hours of hourly history, and public weather alerts.
- Google documents that production use requires billing on the project and an API key or OAuth token on each request. This is not actionable for Japan because the API does not cover Japan.
- The current official pricing table lists a 10,000-request monthly free usage cap for the Weather Usage SKU, then a listed first paid tier of USD $0.15 per 1,000 requests (pricing tiers may vary by volume/region and must be rechecked before activation).
- The official Google Maps Platform page offers a no-credit-card demo key for a controlled sandbox; this is for prototyping and must not be assumed to be a production credential.
- With only two scheduled refreshes per day, a single endpoint would use about 60 requests per 30-day month per configured location, excluding on-demand requests. Separate current-conditions, hourly, and daily endpoints multiply that count. This estimate is historical and not relevant to the Japan provider decision.
- Do not activate billing or create/rotate production API keys without explicit user approval. Google Weather API is not selected for Japan.

## Implementation phases

### Phase A — Complete design
- Confirm the configured location behavior and timezone: initial location is Sapporo, Japan; timezone is Asia/Tokyo.
- Schedule is confirmed: 07:30 and 22:00 JST, configurable later.
- Default scheduled behavior is weather retrieval and HUD refresh only. Spoken announcements remain undecided and disabled.
- Define cache freshness, stale fallback, and failure behavior.
- Recheck API pricing, terms, request fields, and exact endpoint count for the selected Japan-capable provider.

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
- No paid weather subscription or provider without explicit user approval.
- No Google Cloud registration or billing activation for the current weather implementation.
- No new Vercel function unless function-count review and user approval allow it.
- No finance schema or household-finance implementation as part of weather work.
