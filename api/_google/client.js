const { refreshAccessToken } = require("./oauth");
const {
  decryptToken,
  getConnectionForUser,
  updateConnectionTokens,
  markConnectionStatus,
  updateConnectionLastUsed
} = require("./tokenStore");

async function getValidAccessToken(userId, connectionId) {
  const connection = await getConnectionForUser(userId, connectionId);
  if (!connection) {
    const error = new Error("Google connection not found");
    error.code = "connection_not_found";
    throw error;
  }
  if (connection.status !== "connected") {
    const error = new Error("Google connection requires attention");
    error.code = "connection_not_ready";
    throw error;
  }

  const expiresAt = connection.token_expires_at
    ? Date.parse(connection.token_expires_at)
    : 0;
  if (connection.access_token_ciphertext && expiresAt > Date.now() + 60_000) {
    return decryptToken(connection.access_token_ciphertext);
  }

  if (!connection.refresh_token_ciphertext) {
    await markConnectionStatus(userId, connectionId, "reauth_required", "refresh_token_missing");
    const error = new Error("Google connection requires reauthorization");
    error.code = "reauth_required";
    throw error;
  }

  try {
    const refreshToken = decryptToken(connection.refresh_token_ciphertext);
    if (!refreshToken) throw new Error("Google refresh token is missing");
    const tokenResponse = await refreshAccessToken(refreshToken);
    const saved = await updateConnectionTokens(userId, connectionId, tokenResponse);
    if (!saved) throw new Error("Google token refresh could not be saved");
    return tokenResponse.access_token;
  } catch (error) {
    if (error?.code === "invalid_grant") {
      await markConnectionStatus(userId, connectionId, "reauth_required", "invalid_grant");
      const reauthError = new Error("Google connection requires reauthorization");
      reauthError.code = "reauth_required";
      throw reauthError;
    }
    throw error;
  }
}

async function googleApiRequest(userId, connectionId, url, options = {}) {
  const accessToken = await getValidAccessToken(userId, connectionId);
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const error = new Error("Google API request failed");
    error.status = response.status;
    throw error;
  }

  await updateConnectionLastUsed(userId, connectionId).catch(() => {});
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

module.exports = { getValidAccessToken, googleApiRequest };
