/**
 * Gmail API client with automatic token refresh and retry logic.
 *
 * This module provides a reusable Gmail client that handles:
 * - Token refresh on 401 errors
 * - Rate limit handling (429) with exponential backoff
 * - Configurable retry logic
 * - Batch API requests for efficiency
 *
 * Usage:
 * ```typescript
 * import { gmailClient } from "./util/gmail-client.ts";
 *
 * const client = gmailClient(authCell, { debugMode: true });
 * const emails = await client.searchEmails("from:amazon.com", 20);
 * ```
 */
import {
  getPatternEnvironment,
  nonPrivateRandom,
  Writable,
} from "commonfabric";

// Re-export the Auth type for convenience
export type { Auth } from "../gmail-importer.tsx";
import type { Auth } from "../gmail-importer.tsx";

// ============================================================================
// TYPES
// ============================================================================

export interface GmailClientConfig {
  /** How many times the client will retry after an HTTP failure */
  retries?: number;
  /** In milliseconds, the delay between making any subsequent requests due to failure */
  delay?: number;
  /** In milliseconds, the amount to permanently increment to the `delay` on every 429 response */
  delayIncrement?: number;
  /** Enable verbose console logging */
  debugMode?: boolean;
  /**
   * External refresh callback for cross-piece token refresh.
   * Use this when the auth cell belongs to a different piece - direct cell updates
   * will fail due to transaction isolation. The callback should trigger refresh
   * in the auth piece's transaction context (e.g., via a refresh stream).
   */
  onRefresh?: () => Promise<void>;
}

/** Simplified email structure returned by searchEmails */
export interface SimpleEmail {
  id: string;
  threadId?: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  body: string;
  labelIds?: string[];
}

/** Full email structure with all Gmail fields */
export interface FullEmail {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  subject: string;
  from: string;
  date: string;
  to: string;
  plainText: string;
  htmlContent: string;
}

// ============================================================================
// HELPERS
// ============================================================================

function debugLog(debugMode: boolean, ...args: unknown[]) {
  if (debugMode) console.log("[GmailClient]", ...args);
}

function debugWarn(debugMode: boolean, ...args: unknown[]) {
  if (debugMode) console.warn("[GmailClient]", ...args);
}

function decodeBase64Utf8(data: string): string {
  const sanitized = data.replace(/-/g, "+").replace(/_/g, "/");
  const binaryString = atob(sanitized);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new TextDecoder("utf-8").decode(bytes);
}

function extractTextFromPayload(payload: any): string {
  if (payload.body?.data) {
    try {
      return decodeBase64Utf8(payload.body.data);
    } catch {
      return "";
    }
  }
  if (payload.parts) {
    for (const p of payload.parts) {
      if (p.mimeType === "text/plain" && p.body?.data) {
        try {
          return decodeBase64Utf8(p.body.data);
        } catch {
          continue;
        }
      }
    }
    for (const p of payload.parts) {
      if (p.mimeType === "text/html" && p.body?.data) {
        try {
          const html = decodeBase64Utf8(p.body.data);
          return html
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        } catch {
          continue;
        }
      }
    }
    for (const p of payload.parts) {
      const nested = extractTextFromPayload(p);
      if (nested) return nested;
    }
  }
  return "";
}

// ============================================================================
// GMAIL CLIENT
// ============================================================================

/**
 * Gmail API client with automatic token refresh.
 *
 * ⚠️ CRITICAL: The auth cell MUST be writable for token refresh to work!
 * Do NOT pass a derived auth cell - use property access (piece.auth) instead.
 * See: community-docs/superstitions/2025-12-03-derive-creates-readonly-cells-use-property-access.md
 */
export interface GmailClient {
  getProfile(): Promise<{
    emailAddress: string;
    messagesTotal: number;
    threadsTotal: number;
    historyId: string;
  }>;
  searchEmails(query: string, maxResults?: number): Promise<SimpleEmail[]>;
  listMessages(
    gmailFilterQuery?: string,
    maxResults?: number,
  ): Promise<{ id: string; threadId?: string }[]>;
  fetchEmail(
    maxResults?: number,
    gmailFilterQuery?: string,
  ): Promise<{ id: string; threadId?: string }[]>;
  fetchBatch(messages: { id: string }[]): Promise<any[]>;
  fetchMessagesByIds(messageIds: string[]): Promise<any[]>;
  getAttachment(messageId: string, attachmentId: string): Promise<string>;
  getAttachmentsBatch(
    attachments: Array<{ messageId: string; attachmentId: string }>,
  ): Promise<
    Array<{
      messageId: string;
      attachmentId: string;
      data: string | null;
      success: boolean;
    }>
  >;
  fetchHistory(
    startHistoryId: string,
    labelId?: string,
    maxResults?: number,
  ): Promise<{
    history?: Array<{
      id: string;
      messages?: Array<{ id: string; threadId: string }>;
      messagesAdded?: Array<{
        message: { id: string; threadId: string; labelIds: string[] };
      }>;
      messagesDeleted?: Array<{ message: { id: string; threadId: string } }>;
      labelsAdded?: Array<{ message: { id: string }; labelIds: string[] }>;
      labelsRemoved?: Array<{ message: { id: string }; labelIds: string[] }>;
    }>;
    historyId: string;
    nextPageToken?: string;
  }>;
}

export function gmailClient(
  auth: Writable<Auth>,
  {
    retries = 3,
    delay: initialDelay = 1000,
    delayIncrement = 100,
    debugMode = false,
    onRefresh,
  }: GmailClientConfig = {},
): GmailClient {
  let delay = initialDelay;

  async function refreshAuth(): Promise<void> {
    if (onRefresh) {
      debugLog(debugMode, "Refreshing auth token via external callback...");
      await onRefresh();
      debugLog(debugMode, "Auth token refreshed via external callback");
      return;
    }

    const refreshToken = auth.get().refreshToken;
    if (!refreshToken) {
      throw new Error("No refresh token available");
    }

    debugLog(debugMode, "Refreshing auth token directly...");
    const env = getPatternEnvironment();

    const res = await fetch(
      new URL("/api/integrations/google-oauth/refresh", env.apiUrl),
      {
        method: "POST",
        body: JSON.stringify({ refreshToken }),
      },
    );

    if (!res.ok) {
      throw new Error("Could not acquire a refresh token.");
    }

    const json = await res.json();
    const authData = json.tokenInfo as Auth;
    auth.update(authData);
    debugLog(debugMode, "Auth token refreshed successfully");
  }

  function parseMessage(message: any): SimpleEmail | null {
    if (!message?.payload) return null;

    const headers = message.payload.headers || [];
    const getHeader = (name: string) =>
      headers.find(
        (h: { name: string; value: string }) =>
          h.name.toLowerCase() === name.toLowerCase(),
      )?.value || "";

    const body = extractTextFromPayload(message.payload);

    return {
      id: message.id,
      threadId: message.threadId,
      subject: getHeader("Subject"),
      from: getHeader("From"),
      date: getHeader("Date"),
      snippet: message.snippet || "",
      body: body.substring(0, 5000),
      labelIds: message.labelIds,
    };
  }

  async function googleRequest(
    url: URL,
    _options?: RequestInit,
    _retries?: number,
  ): Promise<Response> {
    const token = auth.get().token;
    if (!token) {
      throw new Error("No authorization token.");
    }

    const remainingRetries = _retries ?? retries;
    const options = _options ?? {};
    options.headers = new Headers(options.headers);
    options.headers.set("Authorization", `Bearer ${token}`);

    if (options.body && typeof options.body === "string") {
      options.body = options.body.replace(
        /Authorization: Bearer [^\n]*/g,
        `Authorization: Bearer ${token}`,
      );
    }

    const res = await fetch(url, options);
    let { ok, status, statusText } = res;

    if (options.method === "POST") {
      try {
        const json = await res.clone().json();
        if (json?.error?.code) {
          ok = false;
          status = json.error.code;
          statusText = json.error?.message;
        }
      } catch (_) {
        // Not JSON, probably a real success
      }
    }

    if (ok) {
      debugLog(debugMode, `${url}: ${status} ${statusText}`);
      return res;
    }

    debugWarn(
      debugMode,
      `${url}: ${status} ${statusText}`,
      `Remaining retries: ${remainingRetries}`,
    );

    if (remainingRetries === 0) {
      throw new Error(`Gmail API error: ${status} ${statusText}`);
    }

    if (status === 401) {
      await refreshAuth();
    } else if (status === 429) {
      delay += delayIncrement;
      debugLog(debugMode, `Rate limited, incrementing delay to ${delay}`);
    }

    return googleRequest(url, _options, remainingRetries - 1);
  }

  async function getProfile(): Promise<{
    emailAddress: string;
    messagesTotal: number;
    threadsTotal: number;
    historyId: string;
  }> {
    const url = new URL(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    );
    const res = await googleRequest(url);
    return await res.json();
  }

  async function listMessages(
    gmailFilterQuery: string = "in:INBOX",
    maxResults: number = 100,
  ): Promise<{ id: string; threadId?: string }[]> {
    const url = new URL(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${
        encodeURIComponent(gmailFilterQuery)
      }&maxResults=${maxResults}`,
    );

    const res = await googleRequest(url);
    const json = await res.json();

    if (!json || !("messages" in json) || !Array.isArray(json.messages)) {
      debugLog(debugMode, "No messages found in response");
      return [];
    }

    return json.messages;
  }

  function fetchEmail(
    maxResults: number = 100,
    gmailFilterQuery: string = "in:INBOX",
  ): Promise<{ id: string; threadId?: string }[]> {
    return listMessages(gmailFilterQuery, maxResults);
  }

  async function fetchBatch(messages: { id: string }[]): Promise<any[]> {
    if (messages.length === 0) return [];

    const boundary = `batch_${nonPrivateRandom().toString(36).substring(2)}`;
    debugLog(debugMode, `Processing batch of ${messages.length} messages`);

    const batchBody = messages
      .map(
        (message, index) => `
--${boundary}
Content-Type: application/http
Content-ID: <batch-${index}+${message.id}>

GET /gmail/v1/users/me/messages/${message.id}?format=full
Authorization: Bearer $PLACEHOLDER
Accept: application/json

`,
      )
      .join("") + `--${boundary}--`;

    const batchResponse = await googleRequest(
      new URL("https://gmail.googleapis.com/batch/gmail/v1"),
      {
        method: "POST",
        headers: {
          "Content-Type": `multipart/mixed; boundary=${boundary}`,
        },
        body: batchBody,
      },
    );

    const responseText = await batchResponse.text();
    debugLog(
      debugMode,
      `Received batch response of length: ${responseText.length}`,
    );

    const HTTP_RES_REGEX = /HTTP\/\d\.\d (\d\d\d) ([^\n]*)/;
    const parts = responseText
      .split(`--batch_`)
      .slice(1, -1)
      .map((part) => {
        const httpResIndex = part.search(HTTP_RES_REGEX);
        const httpResMatch = part.match(HTTP_RES_REGEX);
        let httpStatus = httpResMatch && httpResMatch.length >= 2
          ? Number(httpResMatch[1])
          : 0;
        const httpMessage = httpResMatch && httpResMatch.length >= 3
          ? httpResMatch[2]
          : "";

        try {
          const jsonStart = part.indexOf(`\n{`);
          if (jsonStart === -1) return null;

          if (httpResIndex > 0) {
            if (jsonStart <= httpResIndex) {
              httpStatus = 0;
            }
            if (httpStatus > 0 && httpStatus >= 400) {
              debugWarn(
                debugMode,
                `Non-successful HTTP status code (${httpStatus}) in batch: ${httpMessage}`,
              );
              return null;
            }
          }

          const jsonContent = part.slice(jsonStart).trim();
          return JSON.parse(jsonContent);
        } catch (error) {
          if (debugMode) console.error("Error parsing batch part:", error);
          return null;
        }
      })
      .filter((part) => part !== null);

    debugLog(debugMode, `Parsed ${parts.length} messages from batch`);
    return parts;
  }

  async function fetchMessagesByIds(messageIds: string[]): Promise<any[]> {
    return await fetchBatch(messageIds.map((id) => ({ id })));
  }

  async function getAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<string> {
    const url = new URL(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`,
    );
    const res = await googleRequest(url);
    const json = await res.json();
    return json.data;
  }

  async function getAttachmentsBatch(
    attachments: Array<{ messageId: string; attachmentId: string }>,
  ): Promise<
    Array<{
      messageId: string;
      attachmentId: string;
      data: string | null;
      success: boolean;
    }>
  > {
    if (attachments.length === 0) return [];

    if (attachments.length <= 2) {
      return await Promise.all(
        attachments.map(async ({ messageId, attachmentId }) => {
          try {
            const data = await getAttachment(messageId, attachmentId);
            return { messageId, attachmentId, data, success: true };
          } catch {
            return { messageId, attachmentId, data: null, success: false };
          }
        }),
      );
    }

    const boundary = `batch_${nonPrivateRandom().toString(36).substring(2)}`;
    debugLog(
      debugMode,
      `Processing attachment batch of ${attachments.length} items`,
    );

    const batchBody = attachments
      .map(
        ({ messageId, attachmentId }, index) => `
--${boundary}
Content-Type: application/http
Content-ID: <batch-${index}+${messageId}+${attachmentId}>

GET /gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}
Authorization: Bearer $PLACEHOLDER
Accept: application/json

`,
      )
      .join("") + `--${boundary}--`;

    try {
      const batchResponse = await googleRequest(
        new URL("https://gmail.googleapis.com/batch/gmail/v1"),
        {
          method: "POST",
          headers: {
            "Content-Type": `multipart/mixed; boundary=${boundary}`,
          },
          body: batchBody,
        },
      );

      const responseText = await batchResponse.text();
      debugLog(
        debugMode,
        `Received attachment batch response of length: ${responseText.length}`,
      );

      const parts = responseText.split(`--${boundary}`).slice(1, -1);

      return attachments.map(({ messageId, attachmentId }, index) => {
        try {
          const part = parts[index];
          if (!part) {
            return { messageId, attachmentId, data: null, success: false };
          }

          const jsonStart = part.indexOf(`\n{`);
          if (jsonStart === -1) {
            return { messageId, attachmentId, data: null, success: false };
          }

          const jsonContent = part.slice(jsonStart).trim();
          const parsed = JSON.parse(jsonContent);

          if (parsed.error) {
            debugLog(
              debugMode,
              `Attachment batch error for ${attachmentId}: ${parsed.error.message}`,
            );
            return { messageId, attachmentId, data: null, success: false };
          }

          return {
            messageId,
            attachmentId,
            data: parsed.data || null,
            success: !!parsed.data,
          };
        } catch {
          return { messageId, attachmentId, data: null, success: false };
        }
      });
    } catch (error) {
      debugLog(debugMode, "Attachment batch request failed:", error);
      return attachments.map(({ messageId, attachmentId }) => ({
        messageId,
        attachmentId,
        data: null,
        success: false,
      }));
    }
  }

  async function fetchHistory(
    startHistoryId: string,
    labelId?: string,
    maxResults: number = 100,
  ): Promise<{
    history?: Array<{
      id: string;
      messages?: Array<{ id: string; threadId: string }>;
      messagesAdded?: Array<{
        message: { id: string; threadId: string; labelIds: string[] };
      }>;
      messagesDeleted?: Array<{ message: { id: string; threadId: string } }>;
      labelsAdded?: Array<{ message: { id: string }; labelIds: string[] }>;
      labelsRemoved?: Array<{ message: { id: string }; labelIds: string[] }>;
    }>;
    historyId: string;
    nextPageToken?: string;
  }> {
    const url = new URL(
      "https://gmail.googleapis.com/gmail/v1/users/me/history",
    );
    url.searchParams.set("startHistoryId", startHistoryId);
    url.searchParams.set("maxResults", maxResults.toString());
    if (labelId) {
      url.searchParams.set("labelId", labelId);
    }

    debugLog(debugMode, `Fetching history from: ${url.toString()}`);
    const res = await googleRequest(url);
    const json = await res.json();
    debugLog(debugMode, "History API returned:", {
      historyId: json.historyId,
      historyCount: json.history?.length || 0,
      hasNextPageToken: !!json.nextPageToken,
    });
    return json;
  }

  async function searchEmails(
    query: string,
    maxResults: number = 20,
  ): Promise<SimpleEmail[]> {
    const messages = await listMessages(query, maxResults);
    if (messages.length === 0) {
      return [];
    }

    debugLog(
      debugMode,
      `Found ${messages.length} messages for query: ${query}`,
    );
    const fullMessages = await fetchBatch(messages);
    return fullMessages.map((msg) => parseMessage(msg)).filter(
      Boolean,
    ) as SimpleEmail[];
  }

  return {
    getProfile,
    searchEmails,
    listMessages,
    fetchEmail,
    fetchBatch,
    fetchMessagesByIds,
    getAttachment,
    getAttachmentsBatch,
    fetchHistory,
  };
}

/**
 * Validate a Gmail token by making a lightweight API call.
 * Returns { valid: true } or { valid: false, error: string }.
 *
 * NOTE: This function does NOT attempt to refresh expired tokens.
 * For validation with auto-refresh, use validateAndRefreshToken() instead.
 */
export async function validateGmailToken(
  token: string,
): Promise<{ valid: boolean; error?: string }> {
  if (!token) {
    return { valid: false, error: "No token provided" };
  }

  try {
    const res = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    if (res.ok) {
      return { valid: true };
    }

    if (res.status === 401) {
      return { valid: false, error: "Token expired. Please re-authenticate." };
    }

    return { valid: false, error: `Gmail API error: ${res.status}` };
  } catch (err) {
    return { valid: false, error: `Network error: ${err}` };
  }
}

/**
 * Validate a Gmail token, automatically refreshing if expired.
 *
 * This function will:
 * 1. Check if the current token is valid
 * 2. If expired (401), attempt to refresh using the refresh token
 * 3. Update the auth cell with new token data
 * 4. Validate again with the new token
 *
 * @param auth - The auth Cell (must be writable for refresh to work)
 * @param debugMode - Enable debug logging
 * @returns { valid: true, refreshed?: boolean } or { valid: false, error: string }
 */
export async function validateAndRefreshToken(
  auth: Writable<Auth>,
  debugMode: boolean = false,
): Promise<{ valid: boolean; refreshed?: boolean; error?: string }> {
  const authData = auth.get();
  const token = authData?.token;

  if (!token) {
    return { valid: false, error: "No token provided" };
  }

  // First, try validating the current token
  const initialValidation = await validateGmailToken(token);

  if (initialValidation.valid) {
    return { valid: true };
  }

  // If token expired (401), try to refresh
  if (initialValidation.error?.includes("Token expired")) {
    const refreshToken = authData?.refreshToken;

    if (!refreshToken) {
      if (debugMode) {
        console.log(
          "[GmailClient] Token expired but no refresh token available",
        );
      }
      return {
        valid: false,
        error:
          "Token expired and no refresh token available. Please re-authenticate.",
      };
    }

    if (debugMode) {
      console.log("[GmailClient] Token expired, attempting refresh...");
    }

    try {
      const env = getPatternEnvironment();
      const res = await fetch(
        new URL("/api/integrations/google-oauth/refresh", env.apiUrl),
        {
          method: "POST",
          body: JSON.stringify({ refreshToken }),
        },
      );

      if (!res.ok) {
        if (debugMode) console.log("[GmailClient] Refresh failed:", res.status);
        return {
          valid: false,
          error: "Token refresh failed. Please re-authenticate.",
        };
      }

      const json = await res.json();
      const newAuthData = json.tokenInfo as Auth;

      // Update the auth cell with new token
      auth.update(newAuthData);
      if (debugMode) console.log("[GmailClient] Token refreshed successfully");

      // Validate the new token
      const newToken = newAuthData?.token;
      if (!newToken) {
        return {
          valid: false,
          error: "Refresh succeeded but no token returned",
        };
      }

      const refreshedValidation = await validateGmailToken(newToken);
      if (refreshedValidation.valid) {
        return { valid: true, refreshed: true };
      }

      return {
        valid: false,
        error: "Token refresh succeeded but new token is invalid",
      };
    } catch (err) {
      if (debugMode) console.log("[GmailClient] Refresh error:", err);
      return { valid: false, error: `Token refresh error: ${err}` };
    }
  }

  // Non-401 error, return as-is
  return initialValidation;
}

/**
 * Validate a Gmail token, using a cross-piece refresh stream if token expired.
 *
 * This version handles the framework's transaction isolation constraint:
 * When called from a handler in piece A, you cannot write to cells owned by piece B.
 * The solution is to call a handler on piece B via its exported Stream, which runs
 * in piece B's transaction context and can write to its own cells.
 *
 * @param auth - The auth Cell (read access)
 * @param refreshStream - A Stream from the auth piece that triggers token refresh
 * @param debugMode - Enable debug logging
 * @returns { valid: true, refreshed?: boolean } or { valid: false, error: string }
 */
export async function validateAndRefreshTokenCrossPiece(
  auth: Writable<Auth>,
  refreshStream:
    | {
      send: (
        event: Record<string, never>,
        onCommit?: (tx: any) => void,
      ) => void;
    }
    | null
    | undefined,
  debugMode: boolean = false,
): Promise<{ valid: boolean; refreshed?: boolean; error?: string }> {
  if (debugMode) {
    console.log("[GmailClient] validateAndRefreshTokenCrossPiece called");
    console.log("[GmailClient] Has refresh stream:", !!refreshStream?.send);
  }

  const authData = auth.get();
  const token = authData?.token;

  if (debugMode) {
    console.log("[GmailClient] Has token:", !!token);
    console.log("[GmailClient] Has refreshToken:", !!authData?.refreshToken);
  }

  if (!token) {
    return { valid: false, error: "No token provided" };
  }

  // First, try validating the current token
  const initialValidation = await validateGmailToken(token);
  if (debugMode) {
    console.log("[GmailClient] Initial validation result:", initialValidation);
  }

  if (initialValidation.valid) {
    return { valid: true };
  }

  // If token expired (401), try to refresh via the stream
  if (initialValidation.error?.includes("Token expired")) {
    if (!refreshStream?.send) {
      if (debugMode) {
        console.log(
          "[GmailClient] Token expired but no refresh stream available",
        );
      }
      // Fall back to direct refresh attempt (will fail with cross-piece write isolation)
      return validateAndRefreshToken(auth, debugMode);
    }

    const refreshToken = authData?.refreshToken;
    if (!refreshToken) {
      if (debugMode) {
        console.log(
          "[GmailClient] Token expired but no refresh token in auth data",
        );
      }
      return {
        valid: false,
        error:
          "Token expired and no refresh token available. Please re-authenticate.",
      };
    }

    if (debugMode) {
      console.log("[GmailClient] Token expired, calling refresh stream...");
    }

    try {
      // Call the refresh stream and wait for the handler's transaction to commit
      await new Promise<void>((resolve, reject) => {
        refreshStream.send({}, (tx: any) => {
          // onCommit is called after the handler's transaction commits (success or failure)
          const status = tx?.status?.();
          if (status?.status === "done") {
            if (debugMode) {
              console.log(
                "[GmailClient] Refresh stream handler committed successfully",
              );
            }
            resolve();
          } else if (status?.status === "error") {
            if (debugMode) {
              console.log(
                "[GmailClient] Refresh stream handler failed:",
                status.error,
              );
            }
            reject(new Error(`Refresh handler failed: ${status.error}`));
          } else {
            // Unknown status, but callback was called so transaction finished
            if (debugMode) {
              console.log(
                "[GmailClient] Refresh stream handler finished with status:",
                status?.status,
              );
            }
            resolve();
          }
        });
      });

      // Re-read auth cell to get the refreshed token
      if (debugMode) {
        console.log("[GmailClient] onCommit fired, re-reading auth cell...");
      }
      const refreshedAuth = auth.get();
      const newToken = refreshedAuth?.token;

      if (debugMode) {
        console.log(
          "[GmailClient] Token changed:",
          newToken !== authData?.token,
        );
      }

      if (!newToken) {
        return {
          valid: false,
          error: "Refresh completed but no token in auth cell",
        };
      }

      if (debugMode) {
        console.log(
          "[GmailClient] Token refreshed via stream, validating new token...",
        );
      }

      // Validate the new token
      if (debugMode) {
        console.log("[GmailClient] Validating new token...");
      }
      const refreshedValidation = await validateGmailToken(newToken);
      if (debugMode) {
        console.log(
          "[GmailClient] New token validation result:",
          refreshedValidation,
        );
      }
      if (refreshedValidation.valid) {
        return { valid: true, refreshed: true };
      }

      return {
        valid: false,
        error: "Token refresh succeeded but new token is invalid",
      };
    } catch (err) {
      if (debugMode) console.log("[GmailClient] Refresh stream error:", err);
      return { valid: false, error: `Token refresh error: ${err}` };
    }
  }

  // Non-401 error, return as-is
  return initialValidation;
}
