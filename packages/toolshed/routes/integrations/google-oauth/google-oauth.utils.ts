import { OAuth2Client, Tokens } from "@cmd-johnson/oauth2-client";
import { getLogger } from "@commontools/utils/logger";
import env from "@/env.ts";
import { runtime } from "@/index.ts";
import { Context } from "@hono/hono";
import { AuthSchema, Mutable, Schema } from "@commontools/runner";

const logger = getLogger("google-oauth.utils");

export interface OAuth2Tokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenType: string;
  scope?: string[];
  expiresAt?: number;
}

export interface UserInfo {
  id?: string;
  email?: string;
  verified_email?: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  locale?: string;
  error?: string;
}

export interface CallbackResult extends Record<string, unknown> {
  success: boolean;
  error?: string;
  message?: string;
  details?: Record<string, unknown>;
}

type AuthData = Mutable<Schema<typeof AuthSchema>>;

// Create OAuth client with credentials from environment variables
export const createOAuthClient = (redirectUri: string, scopes?: string[]) => {
  // Don't use default scopes if custom scopes are provided
  const scopeString = scopes && scopes.length > 0
    ? scopes.join(" ")
    : "email profile https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly";

  const client = new OAuth2Client({
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    tokenUri: "https://oauth2.googleapis.com/token",
    authorizationEndpointUri: "https://accounts.google.com/o/oauth2/v2/auth",
    redirectUri,
    defaults: {
      scope: scopeString,
    },
  });

  return client;
};

// Helper function to get the base URL
export const getBaseUrl = (url: string): string => {
  try {
    const parsedUrl = new URL(url);
    const origin = parsedUrl.origin;
    return origin.startsWith("http://localhost")
      ? origin
      : origin.replace("http://", "https://");
  } catch (_) {
    // Fallback for development/testing
    return "http://localhost:8000";
  }
};

// Escape special HTML characters to prevent XSS when interpolating into HTML.
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Helper function to generate HTML for the callback page
export function generateCallbackHtml(result: Record<string, unknown>): string {
  // Escape user-controlled values before interpolation into HTML body.
  const statusMessage = result.success
    ? "You can close this window now."
    : escapeHtml(String(result.error || "An error occurred"));

  // Escape '<' in JSON to prevent </script> breakout in script context.
  const safeJson = JSON.stringify(result).replace(/</g, "\\u003c");

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <title>OAuth Callback</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          text-align: center;
          margin-top: 50px;
        }
        .success {
          color: green;
        }
        .error {
          color: red;
        }
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
        // Send message to opener and close window
        if (window.opener) {
          window.opener.postMessage({
            type: 'oauth-callback',
            result: ${safeJson}
          }, window.location.origin);

          // Close the window after a short delay
          setTimeout(() => window.close(), 2000);
        }
      </script>
    </body>
    </html>
  `;
}

// Helper function to fetch user info using the access token
export async function fetchUserInfo(accessToken: string): Promise<UserInfo> {
  try {
    const response = await fetch(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch user info: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error("Error fetching user info:", error);
    return { error: "Failed to fetch user info" };
  }
}

// Helper function to get auth cell
export async function getAuthCell(docLink: string) {
  try {
    // Parse string to docLink if needed
    const parsedDocLink = JSON.parse(docLink);

    let authCell = runtime.getCellFromLink(parsedDocLink);

    // We already should have the schema on the parsedDocLink (from our state),
    // but if it's missing, we can add it  here.
    if (!authCell.schema) authCell = authCell.asSchema(AuthSchema);

    // make sure the cell is live!
    await authCell.sync();
    await runtime.storageManager.synced();

    return authCell;
  } catch (error) {
    throw new Error(`Failed to get auth cell: ${error}`);
  }
}

// Persist encrypted tokens to the auth cell
export async function persistTokens(
  oauthToken: OAuth2Tokens,
  userInfo: UserInfo,
  authCellDocLink: string,
) {
  try {
    const authCell = await getAuthCell(authCellDocLink);

    if (!authCell) {
      throw new Error("Auth cell not found");
    }

    // Prepare token data to store
    const tokenData = tokenToAuthData(oauthToken);
    tokenData.user = {
      email: userInfo.email || "",
      name: userInfo.name || "",
      picture: userInfo.picture || "",
    };

    // Set the new tokens to the auth cell
    const { error } = await authCell.runtime.editWithRetry((tx) => {
      authCell.withTx(tx).set(tokenData);
    });
    if (error) throw error;

    return tokenData;
  } catch (error) {
    logger.error("oauth-error", "Error persisting tokens", error);
    throw new Error(`Error persisting tokens: ${error}`);
  }
}

// Get tokens from the auth cell
export async function getTokensFromAuthCell(
  authCellDocLink: string,
) {
  try {
    const authCell = await getAuthCell(authCellDocLink);

    if (!authCell) {
      throw new Error("Auth cell not found");
    }

    // Get the token data
    const tokenData = authCell.get() as AuthData | null;

    if (!tokenData) {
      throw new Error("No token data found in auth cell");
    }

    return tokenData;
  } catch (error) {
    throw new Error(`Error getting tokens: ${error}`);
  }
}

// Standard error response
export function createErrorResponse(c: Context, message: string) {
  return c.json({
    success: false,
    error: message,
  });
}

// Create a callback response
export function createCallbackResponse(
  result: Record<string, unknown>,
): Response {
  return new Response(generateCallbackHtml(result), {
    headers: {
      "Content-Type": "text/html",
    },
  });
}

// ---------------------------------------------------------------------------
// Server-side code verifier storage
// Stores PKCE code verifiers keyed by a random nonce so they are never exposed
// to the client. Entries are cleaned up on retrieval. This is an in-memory
// store and will be lost on process restart, which is acceptable because OAuth
// flows are short-lived (enforced by STATE_MAX_AGE_MS below).
// ---------------------------------------------------------------------------
export const codeVerifiers = new Map<
  string,
  { codeVerifier: string; createdAt: number }
>();

/** Maximum age of an OAuth state parameter (10 minutes). */
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// HMAC signing helpers for OAuth state parameters
// ---------------------------------------------------------------------------

/**
 * Per-process HMAC key used to sign OAuth state payloads. Generated once at
 * startup via Web Crypto. A per-process secret is sufficient because OAuth
 * flows complete within minutes — well within a single process lifetime.
 */
let _hmacKey: CryptoKey | null = null;

async function getHmacKey(): Promise<CryptoKey> {
  if (!_hmacKey) {
    _hmacKey = await crypto.subtle.generateKey(
      { name: "HMAC", hash: "SHA-256" },
      false, // not extractable
      ["sign", "verify"],
    );
  }
  return _hmacKey;
}

function bufToHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Timing-safe comparison of two hex strings. */
function timingSafeEqual(a: string, b: string): boolean {
  const bufA = new TextEncoder().encode(a);
  const bufB = new TextEncoder().encode(b);
  if (bufA.length !== bufB.length) return false;
  let result = 0;
  for (let i = 0; i < bufA.length; i++) {
    result |= bufA[i] ^ bufB[i];
  }
  return result === 0;
}

export interface OAuthStatePayload {
  authCellId: string;
  integrationPieceId: string;
  /** Random nonce used to look up the code verifier from server-side storage. */
  codeVerifierNonce: string;
  scopes?: string[];
  /** Unix epoch ms when the state was created. */
  timestamp: number;
}

/**
 * Creates a signed OAuth state parameter.
 *
 * The code verifier is stored server-side keyed by a random nonce. The state
 * payload is HMAC-SHA256 signed so it cannot be forged or tampered with.
 *
 * Returns a base64-encoded JSON string of `{ payload, signature }`.
 */
export async function createSignedState(params: {
  authCellId: string;
  integrationPieceId: string;
  codeVerifier: string;
  scopes?: string[];
}): Promise<string> {
  // Generate a random nonce for server-side code verifier storage
  const nonce = crypto.randomUUID();

  // Store code verifier server-side, keyed by nonce
  codeVerifiers.set(nonce, {
    codeVerifier: params.codeVerifier,
    createdAt: Date.now(),
  });

  // Prune expired entries on every create to prevent unbounded growth
  pruneExpiredCodeVerifiers();

  const payload: OAuthStatePayload = {
    authCellId: params.authCellId,
    integrationPieceId: params.integrationPieceId,
    codeVerifierNonce: nonce,
    scopes: params.scopes,
    timestamp: Date.now(),
  };

  const payloadJson = JSON.stringify(payload);
  const key = await getHmacKey();
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payloadJson),
  );
  const signature = bufToHex(sig);

  return btoa(JSON.stringify({ payload, signature }));
}

/**
 * Verifies and decodes a signed OAuth state parameter.
 *
 * Returns the payload and the server-side code verifier on success.
 * Throws an error describing the failure on verification failure.
 */
export async function verifySignedState(state: string): Promise<{
  payload: OAuthStatePayload;
  codeVerifier: string;
}> {
  let parsed: { payload: OAuthStatePayload; signature: string };
  try {
    parsed = JSON.parse(atob(state));
  } catch {
    throw new Error("Invalid state parameter format");
  }

  if (!parsed.payload || !parsed.signature) {
    throw new Error("Malformed state parameter: missing payload or signature");
  }

  // Verify HMAC signature
  const key = await getHmacKey();
  const payloadJson = JSON.stringify(parsed.payload);
  const expectedSig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payloadJson),
  );
  const expectedHex = bufToHex(expectedSig);

  if (!timingSafeEqual(parsed.signature, expectedHex)) {
    throw new Error("Invalid state parameter: signature verification failed");
  }

  // Check expiration
  const age = Date.now() - parsed.payload.timestamp;
  if (age > STATE_MAX_AGE_MS) {
    throw new Error(
      "OAuth state parameter has expired (older than 10 minutes)",
    );
  }

  // Retrieve and consume the code verifier from server-side storage
  const nonce = parsed.payload.codeVerifierNonce;
  const stored = codeVerifiers.get(nonce);
  if (!stored) {
    throw new Error(
      "Invalid state parameter: code verifier not found (may have expired or already been used)",
    );
  }
  // Delete after retrieval so it cannot be reused
  codeVerifiers.delete(nonce);

  return {
    payload: parsed.payload,
    codeVerifier: stored.codeVerifier,
  };
}

/** Remove expired entries from the code verifier store. */
function pruneExpiredCodeVerifiers(): void {
  const now = Date.now();
  for (const [nonce, entry] of codeVerifiers) {
    if (now - entry.createdAt > STATE_MAX_AGE_MS) {
      codeVerifiers.delete(nonce);
    }
  }
}

// Type-safe response helpers for route handlers
export function createLoginSuccessResponse(c: any, url: string) {
  return c.json({ url }, 200) as any;
}

export function createLoginErrorResponse(c: any, errorMessage: string) {
  return c.json({ error: errorMessage }, 400) as any;
}

export function createRefreshSuccessResponse(
  c: any,
  message: string,
  tokenInfo: AuthData,
) {
  return c.json(
    {
      success: true,
      message,
      tokenInfo,
    },
    200,
  ) as any;
}

export function createRefreshErrorResponse(
  c: any,
  errorMessage: string,
  status = 400,
) {
  return c.json({ error: errorMessage }, status) as any;
}

// Clears authentication data from the auth cell
export async function clearAuthData(authCellDocLink: string) {
  try {
    const authCell = await getAuthCell(authCellDocLink);

    if (!authCell) {
      throw new Error("Auth cell not found");
    }

    // Create empty default auth data
    const emptyAuthData: AuthData = {
      token: "",
      tokenType: "",
      scope: [],
      expiresIn: 0,
      expiresAt: 0,
      refreshToken: "",
      user: {
        email: "",
        name: "",
        picture: "",
      },
    };

    // Set the empty data to the auth cell
    const { error } = await authCell.runtime.editWithRetry((tx) => {
      authCell.withTx(tx).set(emptyAuthData);
    });
    if (error) throw error;

    return emptyAuthData;
  } catch (error) {
    logger.error("oauth-error", "Error clearing auth data", error);
    throw new Error(`Error clearing auth data: ${error}`);
  }
}

export function createLogoutSuccessResponse(c: any, message: string) {
  return c.json({
    success: true,
    message,
  });
}

export function createLogoutErrorResponse(
  c: any,
  errorMessage: string,
  status = 400,
) {
  return c.json(
    {
      success: false,
      error: errorMessage,
    },
    status,
  );
}

export function createBackgroundIntegrationSuccessResponse(
  c: any,
  message: string,
) {
  return c.json({ success: true, message }, 200) as any;
}

export function createBackgroundIntegrationErrorResponse(
  c: any,
  errorMessage: string,
  status = 400,
) {
  return c.json({ success: false, error: errorMessage }, status) as any;
}

// Sadly, this declassifies the data
export function tokenToAuthData(token: Tokens | OAuth2Tokens): AuthData {
  return {
    token: token.accessToken,
    tokenType: token.tokenType,
    scope: token.scope,
    expiresIn: token.expiresIn,
    refreshToken: token.refreshToken,
    // `Tokens` does not have `expiresAt`, and is optional for `OAuth2Tokens`.
    expiresAt: token.expiresIn
      ? Date.now() + token.expiresIn * 1000
      : undefined,
  };
}
