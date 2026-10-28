const { requireAuth } = require("../_auth");
const { enforceRateLimit } = require("../_rateLimit");
const { googleApiRequest } = require("../_google/client");

const GOOGLE_TASKS_API = "https://tasks.googleapis.com/tasks/v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK_ID_PATTERN = /^[a-zA-Z0-9_-]{1,1024}$/;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeTaskFields(body, creating) {
  const task = {};
  if (creating || Object.prototype.hasOwnProperty.call(body, "title")) {
    if (typeof body.title !== "string" || !body.title.trim() || body.title.trim().length > 1024) {
      return { error: "title must be 1-1024 characters" };
    }
    task.title = body.title.trim();
  }
  if (Object.prototype.hasOwnProperty.call(body, "notes")) {
    if (typeof body.notes !== "string" || body.notes.length > 8192) {
      return { error: "notes must be 0-8192 characters" };
    }
    task.notes = body.notes;
  }
  if (Object.prototype.hasOwnProperty.call(body, "due")) {
    if (body.due === null || body.due === "") {
      task.due = null;
    } else if (typeof body.due === "string" &&
        /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(body.due) &&
        Number.isFinite(Date.parse(body.due))) {
      const date = body.due.length === 10 ? new Date(body.due + "T00:00:00.000Z") : new Date(body.due);
      task.due = date.toISOString();
    } else {
      return { error: "due must be a valid date or RFC3339 timestamp" };
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, "status")) {
    if (body.status !== "needsAction" && body.status !== "completed") {
      return { error: "status must be needsAction or completed" };
    }
    task.status = body.status;
  }
  if (creating && !task.title) return { error: "title is required" };
  if (!Object.keys(task).length) return { error: "No valid task fields supplied" };
  return { task };
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
  if (!(await enforceRateLimit(res, user, "google-tasks-minute", 30, 60))) return;
  if (!(await enforceRateLimit(res, user, "google-tasks-day", 300, 86400))) return;

  const connectionId = req.method === "GET" ? req.query?.connectionId : req.body?.connectionId;
  if (typeof connectionId !== "string" || !UUID_PATTERN.test(connectionId)) {
    return res.status(400).json({ error: "Valid connectionId is required" });
  }

  const body = req.method === "POST" ? req.body : {};
  if (req.method === "POST" && !isObject(body)) {
    return res.status(400).json({ error: "Invalid request body" });
  }
  const taskListId = req.method === "GET"
    ? (typeof req.query?.taskListId === "string" ? req.query.taskListId : "@default")
    : (typeof body.taskListId === "string" ? body.taskListId : "@default");
  if (!taskListId || taskListId.length > 1024) {
    return res.status(400).json({ error: "Invalid taskListId" });
  }

  try {
    if (req.method === "GET") {
      if (req.query?.lists === "true") {
        const params = new URLSearchParams({ maxResults: "100" });
        if (typeof req.query?.pageToken === "string" && req.query.pageToken.length <= 2048) {
          params.set("pageToken", req.query.pageToken);
        }
        const result = await googleApiRequest(
          user.id, connectionId, `${GOOGLE_TASKS_API}/users/@me/lists?${params}`
        );
        return res.status(200).json({
          ok: true,
          taskLists: Array.isArray(result?.items) ? result.items : [],
          nextPageToken: result?.nextPageToken || null
        });
      }

      const params = new URLSearchParams({
        maxResults: "100",
        showCompleted: "true",
        showDeleted: "false",
        showHidden: "false"
      });
      if (req.query?.showCompleted === "false") params.set("showCompleted", "false");
      if (typeof req.query?.pageToken === "string" && req.query.pageToken.length <= 2048) {
        params.set("pageToken", req.query.pageToken);
      }
      const result = await googleApiRequest(
        user.id, connectionId,
        `${GOOGLE_TASKS_API}/lists/${encodeURIComponent(taskListId)}/tasks?${params}`
      );
      return res.status(200).json({
        ok: true,
        taskListId,
        tasks: Array.isArray(result?.items) ? result.items : [],
        nextPageToken: result?.nextPageToken || null
      });
    }

    if (body.action === "create") {
      const normalized = normalizeTaskFields(body, true);
      if (normalized.error) return res.status(400).json({ error: normalized.error });
      const task = await googleApiRequest(
        user.id, connectionId,
        `${GOOGLE_TASKS_API}/lists/${encodeURIComponent(taskListId)}/tasks`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(normalized.task) }
      );
      return res.status(201).json({ ok: true, task });
    }

    if (body.action === "update" || body.action === "complete") {
      if (typeof body.taskId !== "string" || !TASK_ID_PATTERN.test(body.taskId)) {
        return res.status(400).json({ error: "Valid taskId is required" });
      }
      const patchBody = body.action === "complete"
        ? { status: "completed" }
        : body;
      const normalized = normalizeTaskFields(patchBody, false);
      if (normalized.error) return res.status(400).json({ error: normalized.error });
      const task = await googleApiRequest(
        user.id, connectionId,
        `${GOOGLE_TASKS_API}/lists/${encodeURIComponent(taskListId)}/tasks/${encodeURIComponent(body.taskId)}`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(normalized.task) }
      );
      return res.status(200).json({ ok: true, task });
    }

    if (body.action === "delete") {
      if (body.confirmDelete !== true) {
        return res.status(400).json({ error: "confirmDelete must be true to delete a task" });
      }
      if (typeof body.taskId !== "string" || !TASK_ID_PATTERN.test(body.taskId)) {
        return res.status(400).json({ error: "Valid taskId is required" });
      }
      await googleApiRequest(
        user.id, connectionId,
        `${GOOGLE_TASKS_API}/lists/${encodeURIComponent(taskListId)}/tasks/${encodeURIComponent(body.taskId)}`,
        { method: "DELETE" }
      );
      return res.status(200).json({ ok: true, deleted: true });
    }

    return res.status(400).json({ error: "action must be create, update, complete, or delete" });
  } catch (error) {
    console.error("Google Tasks API request failed", {
      name: error?.name || "Error",
      status: Number.isInteger(error?.status) ? error.status : undefined,
      code: typeof error?.code === "string" ? error.code : undefined
    });
    const status = googleErrorStatus(error);
    return res.status(status).json({
      error: status === 404
        ? "Google connection or task not found"
        : status === 409
          ? "Google connection requires reauthorization"
          : status === 400
            ? "Invalid Google Tasks request"
            : "Google Tasks service unavailable"
    });
  }
};
