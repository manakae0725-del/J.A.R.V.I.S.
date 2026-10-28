const { requireAuth } = require("../_auth");
const { enforceRateLimit } = require("../_rateLimit");
const { googleApiRequest } = require("../_google/client");

const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeDateValue(value) {
  if (!isObject(value)) return null;
  if (typeof value.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.date)) {
    const parsed = Date.parse(`${value.date}T00:00:00Z`);
    if (!Number.isFinite(parsed)) return null;
    return { date: value.date };
  }
  if (typeof value.dateTime === "string" && value.dateTime.length <= 64 &&
      Number.isFinite(Date.parse(value.dateTime))) {
    const hasZone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(value.dateTime);
    const timeZone = typeof value.timeZone === "string" && value.timeZone.length <= 100
      ? value.timeZone
      : undefined;
    if (!hasZone && !timeZone) return null;
    return {
      dateTime: value.dateTime,
      ...(timeZone ? { timeZone } : {})
    };
  }
  return null;
}

function compareEventTimes(start, end) {
  if (start.date && end.date) return end.date > start.date;
  if (start.dateTime && end.dateTime) {
    return Date.parse(end.dateTime) > Date.parse(start.dateTime);
  }
  return false;
}

function normalizeEventFields(body, creating) {
  const event = {};
  if (creating || Object.prototype.hasOwnProperty.call(body, "summary")) {
    if (typeof body.summary !== "string" || !body.summary.trim() || body.summary.trim().length > 200) {
      return { error: "summary must be 1-200 characters" };
    }
    event.summary = body.summary.trim();
  }
  if (Object.prototype.hasOwnProperty.call(body, "description")) {
    if (typeof body.description !== "string" || body.description.length > 5000) {
      return { error: "description must be 0-5000 characters" };
    }
    event.description = body.description;
  }
  if (Object.prototype.hasOwnProperty.call(body, "location")) {
    if (typeof body.location !== "string" || body.location.length > 500) {
      return { error: "location must be 0-500 characters" };
    }
    event.location = body.location;
  }

  const hasStart = Object.prototype.hasOwnProperty.call(body, "start");
  const hasEnd = Object.prototype.hasOwnProperty.call(body, "end");
  if (creating || hasStart || hasEnd) {
    if (!hasStart || !hasEnd) {
      return { error: "start and end must be provided together" };
    }
    const start = normalizeDateValue(body.start);
    const end = normalizeDateValue(body.end);
    if (!start || !end || !compareEventTimes(start, end)) {
      return { error: "start/end must be valid and end must be after start" };
    }
    event.start = start;
    event.end = end;
  }

  if (creating && (!event.start || !event.end || !event.summary)) {
    return { error: "summary, start and end are required" };
  }
  if (!Object.keys(event).length) return { error: "No valid event fields supplied" };
  return { event };
}

function googleErrorStatus(error) {
  if (error?.code === "connection_not_found") return 404;
  if (error?.code === "connection_not_ready" || error?.code === "reauth_required") return 409;
  if (error?.status === 400) return 400;
  if (error?.status === 401 || error?.status === 403) return 502;
  if (error?.status === 404) return 404;
  return 503;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await requireAuth(req, res);
  if (!user) return;

  if (!(await enforceRateLimit(res, user, "google-calendar-minute", 30, 60))) return;
  if (!(await enforceRateLimit(res, user, "google-calendar-day", 300, 86400))) return;

  const connectionId = req.method === "GET" ? req.query?.connectionId : req.body?.connectionId;
  if (typeof connectionId !== "string" || !UUID_PATTERN.test(connectionId)) {
    return res.status(400).json({ error: "Valid connectionId is required" });
  }

  const calendarId = req.method === "GET"
    ? (typeof req.query?.calendarId === "string" ? req.query.calendarId : "primary")
    : (typeof req.body?.calendarId === "string" ? req.body.calendarId : "primary");
  if (!calendarId || calendarId.length > 512) {
    return res.status(400).json({ error: "Invalid calendarId" });
  }
  const eventsUrl = `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`;

  try {
    if (req.method === "GET") {
      const now = Date.now();
      const timeMin = typeof req.query?.timeMin === "string"
        ? req.query.timeMin
        : new Date(now).toISOString();
      const timeMax = typeof req.query?.timeMax === "string"
        ? req.query.timeMax
        : new Date(now + 30 * 86400_000).toISOString();
      if (!Number.isFinite(Date.parse(timeMin)) || !Number.isFinite(Date.parse(timeMax)) ||
          Date.parse(timeMax) <= Date.parse(timeMin)) {
        return res.status(400).json({ error: "Invalid time range" });
      }
      if (timeMax.length > 64 || timeMin.length > 64) {
        return res.status(400).json({ error: "Invalid time range" });
      }
      const params = new URLSearchParams({
        timeMin,
        timeMax,
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: "100"
      });
      if (typeof req.query?.q === "string" && req.query.q.trim()) {
        if (req.query.q.length > 200) return res.status(400).json({ error: "Search query is too long" });
        params.set("q", req.query.q.trim());
      }
      const result = await googleApiRequest(user.id, connectionId, `${eventsUrl}?${params}`);
      return res.status(200).json({
        ok: true,
        timeMin,
        timeMax,
        events: Array.isArray(result?.items) ? result.items : [],
        nextPageToken: result?.nextPageToken || null
      });
    }

    const body = req.body || {};
    if (!isObject(body)) return res.status(400).json({ error: "Invalid request body" });

    if (body.action === "create") {
      const normalized = normalizeEventFields(body, true);
      if (normalized.error) return res.status(400).json({ error: normalized.error });
      const event = await googleApiRequest(user.id, connectionId, eventsUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(normalized.event)
      });
      return res.status(201).json({ ok: true, event });
    }

    if (body.action === "update") {
      if (typeof body.eventId !== "string" || !/^[a-zA-Z0-9_\-]{5,1024}$/.test(body.eventId)) {
        return res.status(400).json({ error: "Valid eventId is required" });
      }
      const normalized = normalizeEventFields(body, false);
      if (normalized.error) return res.status(400).json({ error: normalized.error });
      const event = await googleApiRequest(
        user.id,
        connectionId,
        `${eventsUrl}/${encodeURIComponent(body.eventId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(normalized.event)
        }
      );
      return res.status(200).json({ ok: true, event });
    }

    if (body.action === "delete") {
      if (body.confirmDelete !== true) {
        return res.status(400).json({ error: "confirmDelete must be true to delete an event" });
      }
      if (typeof body.eventId !== "string" || !/^[a-zA-Z0-9_\-]{5,1024}$/.test(body.eventId)) {
        return res.status(400).json({ error: "Valid eventId is required" });
      }
      await googleApiRequest(
        user.id,
        connectionId,
        `${eventsUrl}/${encodeURIComponent(body.eventId)}`,
        { method: "DELETE" }
      );
      return res.status(200).json({ ok: true, deleted: true });
    }

    return res.status(400).json({ error: "action must be create, update, or delete" });
  } catch (error) {
    console.error("Google Calendar API request failed", {
      name: error?.name || "Error",
      status: Number.isInteger(error?.status) ? error.status : undefined,
      code: typeof error?.code === "string" ? error.code : undefined
    });
    const status = googleErrorStatus(error);
    return res.status(status).json({
      error: status === 404
        ? "Google connection or event not found"
        : status === 409
          ? "Google connection requires reauthorization"
          : status === 400
            ? "Invalid Google Calendar request"
            : "Google Calendar service unavailable"
    });
  }
};
