import { GoogleAuth, OAuth2Client } from "google-auth-library";
import type { GoogleWorkspaceConfig } from "./config-schema.js";

/**
 * Get the appropriate scopes based on scope profile.
 * Phase 1 = read-only scopes.
 * Phase 2 will add write scopes.
 */
function getScopes(scopeProfile: "read" | "write"): string[] {
  const readScopes = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/drive.readonly",
  ];

  if (scopeProfile === "write") {
    return [
      ...readScopes,
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/drive", // full drive access (write implied)
    ];
  }

  return readScopes;
}

/**
 * Create an OAuth2Client compatible with google-auth-library.
 * Handles both OAuth2 user credentials and service account flow.
 */
export async function createGoogleAuthClient(config: GoogleWorkspaceConfig): Promise<OAuth2Client> {
  const { auth, scopeProfile } = config;

  if (auth.type === "service_account") {
    // Service account: use GoogleAuth for service-to-service auth
    const googleAuth = auth.keyFile
      ? new GoogleAuth({ keyFile: auth.keyFile, scopes: getScopes(scopeProfile) })
      : new GoogleAuth({ credentials: auth.credentials as any, scopes: getScopes(scopeProfile) });

    const client = await googleAuth.getClient();
    return client as OAuth2Client;
  }

  // OAuth2 user credentials
  const client = new OAuth2Client({
    clientId: auth.clientId,
    clientSecret: auth.clientSecret,
  });

  // Set the stored credentials (Cephus provides these after OAuth callback)
  client.setCredentials({
    access_token: auth.accessToken,
    refresh_token: auth.refreshToken,
    expiry_date: auth.expiryDate,
  });

  return client;
}

/**
 * Get a valid access token, refreshing if needed.
 * Automatically handles token refresh via google-auth-library.
 */
export async function getAccessToken(config: GoogleWorkspaceConfig): Promise<string> {
  const client = await createGoogleAuthClient(config);
  const { token } = await client.getAccessToken();

  if (!token) {
    throw new Error("Failed to obtain Google Workspace access token");
  }

  return token;
}

/**
 * Revoke the stored refresh token (user logout).
 * Only applicable for OAuth2 credentials; service accounts don't have user tokens to revoke.
 */
export async function revokeToken(config: GoogleWorkspaceConfig): Promise<void> {
  if (config.auth.type !== "oauth2") {
    return; // service accounts don't have user tokens to revoke
  }

  try {
    const client = await createGoogleAuthClient(config);
    const { token } = await client.getAccessToken();
    if (token) {
      await client.revokeToken(token);
    }
  } catch (err) {
    // Log but don't throw — revocation failures are non-fatal
    console.warn(`Failed to revoke Google Workspace token: ${err instanceof Error ? err.message : String(err)}`);
  }
}
