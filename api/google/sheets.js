const { requireAuth } = require("../_auth");
const { enforceRateLimit } = require("../_rateLimit");
const { googleApiRequest } = require("../_google/client");

const GOOGLE_SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validSpreadsheetId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{10,200}$/.test(value);
}

function validRange(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 500 &&
    !/[\u0000-\u001f]/.test(value);
}

function normalizeValues(values) {
  if (!Array.isArray(values) || values.length > 1000) return null;
  let cellCount = 0;
  for (const row of values) {
    if (!Array.isArray(row) || row.length > 500) return null;
    cellCount += row.length;
    for (const cell of row) {
      if (cell !== null && !["string", "number", "boolean"].includes(typeof cell)) return null;
      if (typeof cell === "string" && cell.length > 10000) return null;
    }
  }
  return cellCount <= 10000 ? values : null;
}

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
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await requireAuth(req, res);
  if (!user) return;
  if (!(await enforceRateLimit(res, user, "google-sheets-minute", 30, 60))) return;
  if (!(await enforceRateLimit(res, user, "google-sheets-day", 300, 86400))) return;

  const input = req.method === "GET" ? req.query : req.body;
  if (!isObject(input)) return res.status(400).json({ error: "Invalid request" });
  const connectionId = input.connectionId;
  const spreadsheetId = input.spreadsheetId;
  const range = input.range;
  if (typeof connectionId !== "string" || !UUID_PATTERN.test(connectionId)) {
    return res.status(400).json({ error: "Valid connectionId is required" });
  }

  try {
    // Creates a new spreadsheet only; this path never edits an existing file.
    if (req.method === "POST" && input.action === "create") {
      const title = typeof input.title === "string" ? input.title.trim() : "";
      const sheets = input.sheets;
      if (!title || title.length > 120 || /[\\u0000-\\u001f]/.test(title)) {
        return res.status(400).json({ error: "A valid spreadsheet title is required" });
      }
      if (!Array.isArray(sheets) || sheets.length < 1 || sheets.length > 20) {
        return res.status(400).json({ error: "1 to 20 sheet definitions are required" });
      }
      const seenTitles = new Set();
      const normalizedSheets = [];
      for (const sheet of sheets) {
        if (!isObject(sheet) || typeof sheet.title !== "string") {
          return res.status(400).json({ error: "Each sheet requires a title and headers" });
        }
        const sheetTitle = sheet.title.trim();
        if (!sheetTitle || sheetTitle.length > 100 || /[\\[\\]:*?\\/\\\\]/.test(sheetTitle) ||
            /[\\u0000-\\u001f]/.test(sheetTitle) || seenTitles.has(sheetTitle.toLowerCase())) {
          return res.status(400).json({ error: "Sheet titles must be valid and unique" });
        }
        if (!Array.isArray(sheet.headers) || sheet.headers.length < 1 || sheet.headers.length > 100) {
          return res.status(400).json({ error: "Each sheet requires 1 to 100 headers" });
        }
        const headers = sheet.headers.map(value => typeof value === "string" ? value.trim() : "");
        if (headers.some(value => !value || value.length > 100) ||
            new Set(headers.map(value => value.toLowerCase())).size !== headers.length) {
          return res.status(400).json({ error: "Headers must be non-empty and unique (max 100 characters)" });
        }
        seenTitles.add(sheetTitle.toLowerCase());
        normalizedSheets.push({
          properties: { title: sheetTitle, gridProperties: { rowCount: 1000, columnCount: headers.length } },
          data: [{ startRow: 0, startColumn: 0, rowData: [{ values: headers.map(value => ({ userEnteredValue: { stringValue: value } })) }] }]
        });
      }
      const created = await googleApiRequest(user.id, connectionId, GOOGLE_SHEETS_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ properties: { title }, sheets: normalizedSheets })
      });
      return res.status(201).json({
        ok: true, action: "create", spreadsheetId: created?.spreadsheetId || null,
        title: created?.properties?.title || title, spreadsheetUrl: created?.spreadsheetUrl || null,
        sheets: Array.isArray(created?.sheets) ? created.sheets.map(item => ({
          sheetId: item.properties?.sheetId, title: item.properties?.title,
          rowCount: item.properties?.gridProperties?.rowCount,
          columnCount: item.properties?.gridProperties?.columnCount
        })) : []
      });
    }
    if (!validSpreadsheetId(spreadsheetId)) {
      return res.status(400).json({ error: "Valid spreadsheetId is required" });
    }
    if (!validRange(range)) return res.status(400).json({ error: "Valid A1 range is required" });

    const valuesUrl = `${GOOGLE_SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`;
    if (req.method === "GET") {
      const params = new URLSearchParams({ valueRenderOption: "FORMATTED_VALUE", dateTimeRenderOption: "FORMATTED_STRING" });
      const result = await googleApiRequest(user.id, connectionId, `${valuesUrl}?${params}`);
      return res.status(200).json({
        ok: true,
        spreadsheetId,
        range: result?.range || range,
        majorDimension: result?.majorDimension || "ROWS",
        values: Array.isArray(result?.values) ? result.values : []
      });
    }

    if (input.action !== "update" && input.action !== "append") {
      return res.status(400).json({ error: "action must be update or append" });
    }
    const values = normalizeValues(input.values);
    if (!values || values.length === 0) {
      return res.status(400).json({ error: "values must be a non-empty 2D array (max 10000 cells)" });
    }
    const valueInputOption = input.valueInputOption === "USER_ENTERED" ? "USER_ENTERED" : "RAW";
    const method = input.action === "append" ? "append" : "update";
    const params = new URLSearchParams({ valueInputOption });
    if (input.action === "append") params.set("insertDataOption", "INSERT_ROWS");
    const url = input.action === "append" ? `${valuesUrl}:append?${params}` : `${valuesUrl}?${params}`;
    const result = await googleApiRequest(user.id, connectionId, url, {
      method: input.action === "append" ? "POST" : "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ majorDimension: "ROWS", values })
    });
    return res.status(200).json({ ok: true, action: method, updatedRange: result?.updatedRange || result?.tableRange || range, updates: result?.updates || null });
  } catch (error) {
    console.error("Google Sheets API request failed", {
      name: error?.name || "Error",
      status: Number.isInteger(error?.status) ? error.status : undefined,
      code: typeof error?.code === "string" ? error.code : undefined
    });
    const status = googleErrorStatus(error);
    return res.status(status).json({
      error: status === 404 ? "Google connection or spreadsheet not found"
        : status === 409 ? "Google connection requires reauthorization"
          : status === 400 ? "Invalid Google Sheets request" : "Google Sheets service unavailable"
    });
  }
};
