/**
 * Google Docs API client with automatic token refresh and retry logic.
 *
 * This module provides a reusable Google Docs client that handles:
 * - Token refresh on 401 errors (via Cell<Auth> pattern)
 * - Surfacing other failures (including 429 rate limits) to the caller
 * - Configurable token-refresh retry count
 * - Proper pagination for comments
 *
 * Usage:
 * ```typescript
 * import { GoogleDocsClient, extractFileId } from "./util/google-docs-client.ts";
 *
 * const client = new GoogleDocsClient(authCell, { debugMode: true });
 * const fileId = extractFileId("https://docs.google.com/document/d/ABC123/edit");
 * const doc = await client.getDocument(fileId);
 * const comments = await client.listComments(fileId);
 * ```
 */
import { getPatternEnvironment, type Writable } from "commonfabric";

// Re-export Auth type for convenience
export type { Auth } from "../google-auth.tsx";
import type { Auth } from "../google-auth.tsx";

// Import types from google-docs-markdown for consistency
import type {
  GoogleComment,
  GoogleDocsDocument,
} from "./google-docs-markdown.ts";
export type { GoogleComment, GoogleDocsDocument };

// ============================================================================
// TYPES
// ============================================================================

export interface GoogleDocsClientConfig {
  /** How many times to refresh an expired token and retry before giving up. */
  retries?: number;
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

// ============================================================================
// HELPERS
// ============================================================================

function debugLog(debugMode: boolean, ...args: unknown[]) {
  if (debugMode) console.log("[GoogleDocsClient]", ...args);
}

function debugWarn(debugMode: boolean, ...args: unknown[]) {
  if (debugMode) console.warn("[GoogleDocsClient]", ...args);
}

/**
 * Extract file ID from a Google Docs or Drive URL.
 *
 * Handles various URL formats:
 * - https://docs.google.com/document/d/FILE_ID/edit
 * - https://docs.google.com/document/d/FILE_ID/edit?...
 * - https://drive.google.com/file/d/FILE_ID/view
 * - https://drive.google.com/open?id=FILE_ID
 *
 * @param url Google Docs or Drive URL
 * @returns File ID or null if not found
 */
export function extractFileId(url: string): string | null {
  const patterns = [
    /\/document\/d\/([a-zA-Z0-9_-]+)/,
    /\/file\/d\/([a-zA-Z0-9_-]+)/,
    /id=([a-zA-Z0-9_-]+)/,
  ];

  for (const p of patterns) {
    const match = url.match(p);
    if (match) {
      return match[1];
    }
  }

  return null;
}

// ============================================================================
// GOOGLE DOCS CLIENT
// ============================================================================

/**
 * Google Docs API client with automatic token refresh.
 *
 * CRITICAL: The auth cell MUST be writable for token refresh to work!
 * Do NOT pass a derived auth cell - use property access (piece.auth) instead.
 * See: community-docs/superstitions/2025-12-03-derive-creates-readonly-cells-use-property-access.md
 */
export interface GoogleDocsClient {
  getDocument(docId: string): Promise<GoogleDocsDocument>;
  listComments(
    fileId: string,
    includeResolved?: boolean,
  ): Promise<GoogleComment[]>;
}

type GoogleDocsClientConstructor = {
  new (
    auth: Writable<Auth>,
    config?: GoogleDocsClientConfig,
  ): GoogleDocsClient;
  (
    auth: Writable<Auth>,
    config?: GoogleDocsClientConfig,
  ): GoogleDocsClient;
};

export const GoogleDocsClient = function GoogleDocsClient(
  auth: Writable<Auth>,
  {
    retries = 3,
    debugMode = false,
    onRefresh,
  }: GoogleDocsClientConfig = {},
): GoogleDocsClient {
  /**
   * Refresh the OAuth token using the refresh token.
   * Updates the auth cell with new token data.
   *
   * If an external onRefresh callback was provided, it will be used instead
   * of direct cell update. This enables cross-piece refresh where direct
   * cell writes would fail due to transaction isolation.
   */
  async function refreshAuth(): Promise<void> {
    // If an external refresh callback was provided, use it
    // (for cross-piece refresh via streams)
    if (onRefresh) {
      debugLog(
        debugMode,
        "Refreshing auth token via external callback...",
      );
      await onRefresh();
      debugLog(debugMode, "Auth token refreshed via external callback");
      return;
    }

    // Fall back to direct refresh (only works if auth cell is writable)
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

  /**
   * Make an authenticated request to Google APIs. A 401 refreshes the token and
   * retries, up to `retries` times; every other failure — including a 429 rate
   * limit — is thrown, since a compartment has no timers to back off with and
   * the reactive layer re-drives the work.
   */
  async function request(
    url: URL,
    options?: RequestInit,
    remainingRetries?: number,
  ): Promise<Response> {
    // Get fresh token on each request
    const token = auth.get().token;
    if (!token) {
      throw new Error("No authorization token");
    }

    const retriesLeft = remainingRetries ?? retries;
    const opts = options ?? {};
    opts.headers = new Headers(opts.headers);
    opts.headers.set("Authorization", `Bearer ${token}`);

    const res = await fetch(url, opts);
    const { ok, status, statusText } = res;

    if (ok) {
      debugLog(debugMode, `${url}: ${status} ${statusText}`);
      return res;
    }

    debugWarn(
      debugMode,
      `${url}: ${status} ${statusText}`,
      `Remaining retries: ${retriesLeft}`,
    );

    // Recover from an expired token by refreshing and retrying.
    if (status === 401 && retriesLeft > 0) {
      await refreshAuth();
      return request(url, options, retriesLeft - 1);
    }

    // Handle specific error codes with helpful messages.
    if (status === 401) {
      throw new Error(
        "Token expired. Please re-authenticate in your Google Auth piece.",
      );
    }
    if (status === 403) {
      const text = await res.text();
      throw new Error(
        `Access denied (403). This could mean:\n` +
          `- The document is not shared with your Google account\n` +
          `- Your account doesn't have access to this document\n` +
          `- The required API is not enabled in your Google Cloud project\n\n` +
          `Details: ${text}`,
      );
    }
    throw new Error(`Google API error: ${status} ${statusText}`);
  }

  /**
   * Get a Google Docs document by ID.
   *
   * @param docId The document ID
   * @returns The full document structure
   */
  async function getDocument(docId: string): Promise<GoogleDocsDocument> {
    const url = new URL(`https://docs.googleapis.com/v1/documents/${docId}`);

    debugLog(debugMode, `Fetching document: ${docId}`);
    const res = await request(url);
    const doc = await res.json();
    debugLog(debugMode, `Document fetched: ${doc.title}`);

    return doc;
  }

  /**
   * List all comments on a Google Drive file (including docs).
   * Uses pagination to fetch all comments.
   *
   * @param fileId The file ID (same as document ID for Google Docs)
   * @param includeResolved Whether to include resolved comments (default: false)
   * @returns Array of all comments
   */
  async function listComments(
    fileId: string,
    includeResolved: boolean = false,
  ): Promise<GoogleComment[]> {
    const allComments: GoogleComment[] = [];
    let pageToken: string | undefined;

    debugLog(debugMode, `Fetching comments for file: ${fileId}`);

    do {
      const url = new URL(
        `https://www.googleapis.com/drive/v3/files/${fileId}/comments`,
      );
      url.searchParams.set(
        "fields",
        "nextPageToken,comments(id,author,content,htmlContent,createdTime,modifiedTime,resolved,quotedFileContent,anchor,replies)",
      );
      url.searchParams.set("pageSize", "100");

      if (pageToken) {
        url.searchParams.set("pageToken", pageToken);
      }

      const res = await request(url);
      const json = await res.json();

      const comments = json.comments || [];
      debugLog(
        debugMode,
        `Fetched ${comments.length} comments (page token: ${
          pageToken || "none"
        })`,
      );

      // Filter resolved comments if not including them
      const filtered = includeResolved
        ? comments
        : comments.filter((c: GoogleComment) => !c.resolved);
      allComments.push(...filtered);

      pageToken = json.nextPageToken;
    } while (pageToken);

    debugLog(
      debugMode,
      `Total comments fetched: ${allComments.length} (includeResolved: ${includeResolved})`,
    );

    return allComments;
  }

  return {
    getDocument,
    listComments,
  };
} as GoogleDocsClientConstructor;
