const crypto = require("crypto");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const CONNECTIONS_TABLE = "google_connections";
const STATES_TABLE = "google_oauth_states";

function getSupabaseConfig() {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    throw new Error("Google connection storage is unavailable");
  }
  return {
    baseUrl: `${SUPABASE_URL.replace(/\/+$/, "")}/rest/v1`,
    key: SUPABASE_SECRET_KEY
  };
}

function encryptionKey() {
  const encoded = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY || "";
  let key;
  try {
    key = Buffer.from(encoded, "base64");
  } catch (_) {
    throw new Error("Google token encryption key is invalid");
  }
  if (key.length !== 32) {
    throw new Error("Google token encryption key must be a base64-encoded 32-byte key");
  }
  return key;
}

function encryptToken(value) {
  if (typeof value !== "string" || !value) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((part) => part.toString("base64url")).join(".");
}

function decryptToken(value) {
  if (typeof value !== "string" || !value) return null;
  const parts = value.split(".");
  if (parts.length !== 3) throw new Error("Stored Google token ciphertext is invalid");
  const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, "base64url"));
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
    throw new Error("Stored Google token ciphertext is invalid");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

async function supabaseRequest(path, options = {}) {
  const { baseUrl, key } = getSupabaseConfig();
  const response = await fetch(`${baseUrl}/${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    const error = new Error("Google connection storage request failed");
    error.status = response.status;
    throw error;
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function createOAuthState({ stateHash, userId, scopes, expiresAt }) {
  await supabaseRequest(STATES_TABLE, {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      state_hash: stateHash,
      user_id: userId,
      requested_scopes: scopes,
      expires_at: expiresAt
    })
  });
}

async function consumeOAuthState(stateHash) {
  const params = new URLSearchParams({
    state_hash: `eq.${stateHash}`,
    consumed_at: "is.null",
    expires_at: `gt.${new Date().toISOString()}`,
    select: "user_id,requested_scopes,expires_at"
  });
  const rows = await supabaseRequest(`${STATES_TABLE}?${params}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ consumed_at: new Date().toISOString() })
  });
  return Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
}

async function findConnection(userId, googleSubject) {
  const params = new URLSearchParams({
    user_id: `eq.${userId}`,
    google_subject: `eq.${googleSubject}`,
    select: "id,refresh_token_ciphertext",
    limit: "1"
  });
  const rows = await supabaseRequest(`${CONNECTIONS_TABLE}?${params}`);
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function saveConnection({ userId, identity, tokenResponse, scopes }) {
  const existing = await findConnection(userId, identity.subject);
  const refreshToken = tokenResponse.refresh_token
    ? encryptToken(tokenResponse.refresh_token)
    : existing?.refresh_token_ciphertext || null;
  const now = new Date().toISOString();
  const record = {
    user_id: userId,
    google_subject: identity.subject,
    google_email: identity.email,
    scopes,
    access_token_ciphertext: encryptToken(tokenResponse.access_token),
    refresh_token_ciphertext: refreshToken,
    token_expires_at: Number.isFinite(Number(tokenResponse.expires_in))
      ? new Date(Date.now() + Number(tokenResponse.expires_in) * 1000).toISOString()
      : null,
    token_key_version: 1,
    status: "connected",
    connected_at: now,
    last_error_code: null,
    updated_at: now
  };
  await supabaseRequest(`${CONNECTIONS_TABLE}?on_conflict=user_id,google_subject`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(record)
  });
}

async function getConnectionForUser(userId, connectionId) {
  const params = new URLSearchParams({
    id: `eq.${connectionId}`,
    user_id: `eq.${userId}`,
    select: "id,access_token_ciphertext,refresh_token_ciphertext,status"
  });
  const rows = await supabaseRequest(`${CONNECTIONS_TABLE}?${params}`);
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function deleteConnectionForUser(userId, connectionId) {
  const params = new URLSearchParams({
    id: `eq.${connectionId}`,
    user_id: `eq.${userId}`
  });
  await supabaseRequest(`${CONNECTIONS_TABLE}?${params}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" }
  });
}

async function listConnectionsForUser(userId) {
  const params = new URLSearchParams({
    user_id: `eq.${userId}`,
    select: "id,google_email,scopes,status,connected_at,last_used_at,last_error_code",
    order: "connected_at.desc"
  });
  const rows = await supabaseRequest(`${CONNECTIONS_TABLE}?${params}`);
  return Array.isArray(rows) ? rows : [];
}

module.exports = {
  encryptToken,
  decryptToken,
  createOAuthState,
  consumeOAuthState,
  saveConnection,
  getConnectionForUser,
  deleteConnectionForUser,
  listConnectionsForUser
};
