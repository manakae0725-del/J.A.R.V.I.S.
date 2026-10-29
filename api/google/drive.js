const { requireAuth } = require("../_auth");
const { enforceRateLimit } = require("../_rateLimit");
const { googleApiRequest } = require("../_google/client");

const GOOGLE_DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FILE_ID_PATTERN = /^[a-zA-Z0-9_-]{5,200}$/;
const FILE_FIELDS = "files(id,name,mimeType,modifiedTime,webViewLink,webContentLink,size,owners(displayName,emailAddress)),nextPageToken";

function googleErrorStatus(error) {
  if (error?.code === "connection_not_found") return 404;
  if (error?.code === "connection_not_ready" || error?.code === "reauth_required") return 409;
  if (error?.status === 400) return 400;
  if (error?.status === 404) return 404;
  if (error?.status === 401 || error?.status === 403) return 502;
  return 503;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await requireAuth(req, res);
  if (!user) return;
  if (!(await enforceRateLimit(res, user, "google-drive-minute", 30, 60))) return;
  if (!(await enforceRateLimit(res, user, "google-drive-day", 300, 86400))) return;

  const connectionId = req.query?.connectionId;
  if (typeof connectionId !== "string" || !UUID_PATTERN.test(connectionId)) {
    return res.status(400).json({ error: "Valid connectionId is required" });
  }
  const fileId = typeof req.query?.fileId === "string" ? req.query.fileId : "";
  const q = typeof req.query?.q === "string" ? req.query.q.trim() : "";
  const pageSize = Number.parseInt(req.query?.pageSize, 10);
  const limit = Number.isInteger(pageSize) ? Math.min(100, Math.max(1, pageSize)) : 25;

  if (fileId && !FILE_ID_PATTERN.test(fileId)) return res.status(400).json({ error: "Invalid fileId" });
  if (q.length > 300) return res.status(400).json({ error: "Search query is too long" });

  try {
    const params = new URLSearchParams({
      fields: FILE_FIELDS,
      pageSize: String(limit),
      orderBy: "modifiedTime desc"
    });
    if (fileId) {
      params.set("fields", "id,name,mimeType,modifiedTime,webViewLink,webContentLink,size,owners(displayName,emailAddress),description,createdTime");
      const file = await googleApiRequest(user.id, connectionId, `${GOOGLE_DRIVE_API}/${encodeURIComponent(fileId)}?${params}`);
      return res.status(200).json({ ok: true, file });
    }
    params.set("q", q ? `trashed = false and name contains '${q.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'` : "trashed = false");
    const result = await googleApiRequest(user.id, connectionId, `${GOOGLE_DRIVE_API}?${params}`);
    return res.status(200).json({
      ok: true,
      files: Array.isArray(result?.files) ? result.files : [],
      nextPageToken: result?.nextPageToken || null
    });
  } catch (error) {
    console.error("Google Drive API request failed", {
      name: error?.name || "Error",
      status: Number.isInteger(error?.status) ? error.status : undefined,
      code: typeof error?.code === "string" ? error.code : undefined
    });
    const status = googleErrorStatus(error);
    return res.status(status).json({
      error: status === 404 ? "Google connection or file not found"
        : status === 409 ? "Google connection requires reauthorization"
          : status === 400 ? "Invalid Google Drive request" : "Google Drive service unavailable"
    });
  }
};
