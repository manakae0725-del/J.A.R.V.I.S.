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

**Correction (2026-11-03): Google Weather API does support Japan.** The current official FAQ states that Japan and South Korea are supported, with Japanese data supplied by Weathernews. The earlier conclusion that Japan was excluded was incorrect. However, Google Maps Platform service-specific terms prohibit using Weather API content to recreate a weather app or weather model whose primary purpose is weather information. The same terms limit caching to one hour for current conditions and hourly forecasts, 24 hours for daily forecasts, and 30 days for today's forecast. This is a significant mismatch with J.A.R.V.I.S.'s desired twice-daily retrieval and persistent last-success HUD cache. Google Weather API remains a candidate only if the ancillary-weather use within the broader assistant is confirmed as permitted and the cache/display design is changed to comply. Do not enable billing or create a key until that review is complete.

### Japan-capable candidates under review

- **Japan Meteorological Agency (JMA) public data:** JMA publishes prefectural forecasts, weekly forecasts, observations, and machine-readable disaster-weather XML. Its information catalog documents forecast content and publication frequency. However, a stable, supported public REST forecast API/SLA is not established by these pages; website JSON endpoints used by third parties must be treated as undocumented and potentially changeable. Check JMA's content terms and attribution requirements before implementation.
- **TenkiNow (unofficial AMeDAS observation API):** a no-key JSON service for nearby station observations, not forecasts. Its own documentation says it is unofficial, returns station observations rather than interpolated point estimates, and should not be used for safety-critical purposes. It could be an optional current-observation source, not the forecast source.
- **Japan Weather Association Weather Data API:** Japan-specific high-resolution data and forecast coverage, but it is a paid commercial service. Its published pricing starts at JPY 32,000/month for credit-card billing; not appropriate for the current cost-minimizing household use unless the scope changes and the user explicitly approves.
- **Google Weather API:** Japan is supported (Weathernews data), but usage restrictions and short cache periods may conflict with the persistent HUD requirement; see the correction above.

### Current decision

Provider selection: **JMA public XML selected as the primary source for the initial private household implementation**, subject to Preview validation. Current findings: (1) JMA public data can generally be reused under the JMA site terms with attribution and appropriate notes for edits, but undocumented website JSON endpoints are not stable contracts; (2) unofficial JMA wrapper APIs explicitly warn that their upstream endpoints may change or fail; (3) Google Weather API supports Japan, but its use and cache restrictions require a careful fit review; (4) JWA's supported commercial API starts at JPY 32,000/month and requires prior permission for commercial use and caching, so it is out of scope for now. The selected retrieval path is JMA's official PULL-type Atom feeds and the published JMA XML telegrams. Use the high-frequency feed only as an update index; retrieve only matching forecast telegrams and never redownload unchanged documents. Keep a provider adapter so a future source can replace JMA. Keep the normalized weather model provider-neutral.

## Proposed architecture

1. Use the JMA public XML PULL feed as the initial source behind a server-side adapter. Use the official regular feed for scheduled forecast telegrams and the relevant irregular feed only if/when warning data is added.
2. JMA public XML requires no API key or user registration. Fetch it server-side only through the existing authenticated J.A.R.V.I.S. API layer; never fetch the feed directly from the browser.
3. Extend the existing `/api/gemini` handler with a bounded weather operation, or share an internal weather module from that handler. Do not add a standalone Vercel API route unless the current function count and deployment constraints have been rechecked.
4. Normalize provider responses into one internal weather model: location, observation/fetch time, current temperature/condition, daily high/low, hourly forecast entries, precipitation probability, and provider/source metadata. Preserve provider timestamps and timezone.
5. Use the configured location (initially Sapporo, Japan) rather than requesting GPS permission from Safari. Make the location changeable through settings in a later UI step. Do not silently infer a more precise address.
6. Cache the last successful normalized response per authenticated user/device using a storage design that does not misuse conversational memory. Until an approved persistent store is available, a device-local cache may be used for HUD continuity, clearly labeled with its last-updated time. Do not create finance tables or use the household-finance schema for weather.
7. Bind the HUD fields to actual cached data. Show a clear unavailable/stale state instead of sample weather values when no valid result exists.
8. The existing background scheduler may dispatch weather refreshes only at 07:30 and 22:00 JST (Asia/Tokyo). Use a due-time guard and persisted last-success/idempotency state; query the Atom update index, compare telegram IDs/updated timestamps, and fetch only changed forecast documents. These are the confirmed default times and may become configurable later. Scheduled work refreshes the HUD only; it does not speak an announcement. It must not make a Weather API request on every minute tick; use a due-time/last-success guard and idempotency.
9. On-demand voice requests should refresh or return a sufficiently recent cached result according to an explicit freshness rule. The assistant must state the observation/update time and distinguish current conditions from forecast.
10. Keep general web search available for questions outside the structured forecast scope; avoid making a second paid search call when a successful dedicated weather result already answers the request.

## Google Weather API — corrected coverage, restrictions, and pricing

This section records current research. Google Weather API supports Japan, but is not selected yet; Google Cloud registration and billing remain deferred.

- The official FAQ states that Japan and South Korea are supported, with Japanese data supplied by Weathernews. It lists current conditions, hourly and daily forecasts, hourly history, and public weather alerts. Current conditions refresh about every 15 minutes; hourly and daily forecasts about every 30 minutes.
- Production use requires billing on the project and an API key or OAuth token on each request.
- The current official pricing table lists a 10,000-request monthly free usage cap for the Weather Usage SKU, then a listed first paid tier of USD $0.15 per 1,000 requests (pricing tiers may vary by volume/region and must be rechecked before activation).
- The official Google Maps Platform page offers a no-credit-card demo key for a controlled sandbox; this is for prototyping and must not be assumed to be a production credential.
- At two scheduled refreshes per day, one endpoint would use about 60 requests per 30-day month per configured location; each additional endpoint queried on each refresh adds another 60. On-demand refreshes add requests. The official price list currently shows 10,000 free monthly Weather Usage events, then USD $0.15 per 1,000 events in the first paid tier. A valid billing account is still required.
- Critical terms: current conditions and hourly forecast values may be cached for only one hour; daily forecast values for 24 hours; today's forecast for 30 days; hourly history for 240 hours; public alerts for one hour. Google also prohibits using Weather API content to recreate a weather app or weather model whose primary purpose is weather information. This may be compatible with a broader assistant that has an ancillary weather panel, but that interpretation must not be assumed without review. The one-hour cache limit conflicts with keeping the last successful current/hourly data visible between the 07:30 and 22:00 scheduled refreshes. Do not activate billing or create/rotate API keys without explicit user approval.

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


## JMA implementation notes (2026-11-03)

- Official PULL page: https://xml.kishou.go.jp/xmlpull.html
- The page publishes two Atom feeds (high-frequency updated every minute and long-term updated hourly). The high-frequency feed retains at least the latest 10 minutes; the long-term feed retains several days. These are update indexes, not a reason to fetch all telegrams on each tick.
- Public feed use requires no user registration. JMA warns that maintenance may delay/stop delivery and that it does not warrant actions based on the public XML. The system must retain last-successful data and clearly label its retrieval time.
- Relevant forecast telegrams: VPFD51 (prefectural forecast, three times daily/as needed) and VPFW50 (prefectural weekly forecast, twice daily, up to seven days). The official catalog documents weather, temperature, and precipitation probability fields.
- XML schema/dictionaries are versioned by JMA. Parser must tolerate optional/missing elements, reject unknown/incomplete payloads safely, preserve the telegram ID and report time, and be covered by fixtures for schema updates.
- Attribution in HUD: "出典：気象庁（府県天気予報・府県週間天気予報）". Since J.A.R.V.I.S. normalizes and presents the source data, label it "気象庁の公開データを基にJ.A.R.V.I.S.が加工・表示".
- JMA's terms require source attribution and a note when content is edited/processed. JMA also notes statutory limits under the Meteorological Service Act. This initial scope is a private household assistant for its authenticated household users, not a public forecast service or a commercial weather product. Do not redistribute forecasts publicly or represent J.A.R.V.I.S. as an official JMA service. If the scope changes to public/commercial forecast provision, obtain a legal review and confirm permit requirements first.
- JMA's PULL feed may be delayed or unavailable. Never treat it as an emergency-alert channel or guaranteed real-time warning service.
