import { OAuth2Client, type Tokens } from "@cmd-johnson/oauth2-client";
import { getLogger } from "@commontools/utils/logger";
import { runtime } from "@/index.ts";
import type { JSONSchema } from "@commontools/runner";
import type {
  OAuth2ProviderConfig,
  OAuth2Tokens,
  UserInfo,
} from "./oauth2-common.types.ts";

const logger = getLogger("oauth2-common");

// ---------------------------------------------------------------------------
// OAuth2 Client
// ---------------------------------------------------------------------------

export function createOAuth2Client(
  config: OAuth2ProviderConfig,
  redirectUri: string,
  scopes?: string[],
): OAuth2Client {
  const scopeString = scopes && scopes.length > 0
    ? scopes.join(" ")
    : config.defaultScopes;

  return new OAuth2Client({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    tokenUri: config.tokenUri,
    authorizationEndpointUri: config.authorizationEndpointUri,
    redirectUri,
    defaults: { scope: scopeString },
  });
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

export function getBaseUrl(url: string): string {
  try {
    const parsedUrl = new URL(url);
    const origin = parsedUrl.origin;
    return origin.startsWith("http://localhost")
      ? origin
      : origin.replace("http://", "https://");
  } catch (_) {
    return "http://localhost:8000";
  }
}

// ---------------------------------------------------------------------------
// Callback HTML
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function generateCallbackHtml(result: Record<string, unknown>): string {
  const statusMessage = result.success
    ? "You can close this window now."
    : escapeHtml(String(result.error || "An error occurred"));

  const safeJson = JSON.stringify(result).replace(/</g, "\\u003c");

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <title>OAuth Callback</title>
      <style>
        body { font-family: Arial, sans-serif; text-align: center; margin-top: 50px; }
        .success { color: green; }
        .error { color: red; }
      </style>
    </head>
    <body>
      <h1 class="${result.success ? "success" : "error"}">
        ${
    result.success ? "Authentication Successful!" : "Authentication Failed"
  }
      </h1>
      <p>${statusMessage}</p>
      <script>
        if (window.opener) {
          window.opener.postMessage({
            type: 'oauth-callback',
            result: ${safeJson}
          }, window.location.origin);
          setTimeout(() => window.close(), 2000);
        }
      </script>
    </body>
    </html>
  `;
}

// ---------------------------------------------------------------------------
// User info
// ---------------------------------------------------------------------------

export async function fetchUserInfo(
  accessToken: string,
  endpoint: string,
  mapper?: (raw: Record<string, unknown>) => UserInfo,
): Promise<UserInfo> {
  try {
    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch user info: ${response.status}`);
    }
    const raw = await response.json();
    return mapper ? mapper(raw) : raw as UserInfo;
  } catch (error) {
    logger.error("Error fetching user info:", error);
    return { error: "Failed to fetch user info" };
  }
}

// ---------------------------------------------------------------------------
// Auth cell CRUD
// ---------------------------------------------------------------------------

export async function getAuthCell(docLink: string, schema: JSONSchema) {
  try {
    const parsedDocLink = JSON.parse(docLink);
    let authCell = runtime.getCellFromLink(parsedDocLink);
    if (!authCell.schema) authCell = authCell.asSchema(schema);
    await authCell.sync();
    await runtime.storageManager.synced();
    return authCell;
  } catch (error) {
    throw new Error(`Failed to get auth cell: ${error}`);
  }
}

export async function persistTokens(
  tokenData: Record<string, unknown>,
  authCellDocLink: string,
  schema: JSONSchema,
) {
  try {
    const authCell = await getAuthCell(authCellDocLink, schema);
    if (!authCell) throw new Error("Auth cell not found");

    const { error } = await authCell.runtime.editWithRetry((tx: any) => {
      authCell.withTx(tx).set(tokenData);
    });
    if (error) throw error;

    return tokenData;
  } catch (error) {
    logger.error("Error persisting tokens:", error);
    throw new Error(`Error persisting tokens: ${error}`);
  }
}

export async function getTokensFromAuthCell(
  authCellDocLink: string,
  schema: JSONSchema,
) {
  try {
    const authCell = await getAuthCell(authCellDocLink, schema);
    if (!authCell) throw new Error("Auth cell not found");
    const tokenData = authCell.get();
    if (!tokenData) throw new Error("No token data found in auth cell");
    return tokenData as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Error getting tokens: ${error}`);
  }
}

export async function clearAuthData(
  authCellDocLink: string,
  schema: JSONSchema,
  emptyData: Record<string, unknown>,
) {
  try {
    const authCell = await getAuthCell(authCellDocLink, schema);
    if (!authCell) throw new Error("Auth cell not found");

    const { error } = await authCell.runtime.editWithRetry((tx: any) => {
      authCell.withTx(tx).set(emptyData);
    });
    if (error) throw error;
    return emptyData;
  } catch (error) {
    logger.error("Error clearing auth data:", error);
    throw new Error(`Error clearing auth data: ${error}`);
  }
}

// ---------------------------------------------------------------------------
// Token mapping (generic: uses accessToken field)
// ---------------------------------------------------------------------------

export function tokenToGenericAuthData(
  token: Tokens | OAuth2Tokens,
): Record<string, unknown> {
  return {
    accessToken: token.accessToken,
    tokenType: token.tokenType,
    scope: token.scope,
    expiresIn: token.expiresIn,
    refreshToken: token.refreshToken,
    expiresAt: token.expiresIn
      ? Date.now() + token.expiresIn * 1000
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

export function createCallbackResponse(
  result: Record<string, unknown>,
): Response {
  return new Response(generateCallbackHtml(result), {
    headers: { "Content-Type": "text/html" },
  });
}

export function createLoginSuccessResponse(c: any, url: string) {
  return c.json({ url }, 200);
}

export function createLoginErrorResponse(c: any, errorMessage: string) {
  return c.json({ error: errorMessage }, 400);
}

export function createRefreshSuccessResponse(
  c: any,
  message: string,
  tokenInfo: Record<string, unknown>,
) {
  return c.json({ success: true, message, tokenInfo }, 200);
}

export function createRefreshErrorResponse(
  c: any,
  errorMessage: string,
  status = 400,
) {
  return c.json({ error: errorMessage }, status);
}

export function createLogoutSuccessResponse(c: any, message: string) {
  return c.json({ success: true, message });
}

export function createLogoutErrorResponse(
  c: any,
  errorMessage: string,
  status = 400,
) {
  return c.json({ success: false, error: errorMessage }, status);
}

export function createBackgroundIntegrationSuccessResponse(
  c: any,
  message: string,
) {
  return c.json({ success: true, message }, 200);
}

export function createBackgroundIntegrationErrorResponse(
  c: any,
  errorMessage: string,
  status = 400,
) {
  return c.json({ success: false, error: errorMessage }, status);
}
