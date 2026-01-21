/**
 * Google Docs API client with automatic token refresh and retry logic.
 *
 * This module provides a reusable Google Docs client that handles:
 * - Token refresh on 401 errors (via Cell<Auth> pattern)
 * - Rate limit handling (429) with exponential backoff
 * - Configurable retry logic
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
import { Cell, getRecipeEnvironment } from "commontools";

const env = getRecipeEnvironment();

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
  /** How many times the client will retry after an HTTP failure */
  retries?: number;
  /** In milliseconds, the delay between making any subsequent requests due to failure */
  delay?: number;
  /** In milliseconds, the amount to permanently increment to the `delay` on every 429 response */
  delayIncrement?: number;
  /** Enable verbose console logging */
  debugMode?: boolean;
  /**
   * External refresh callback for cross-charm token refresh.
   * Use this when the auth cell belongs to a different charm - direct cell updates
   * will fail due to transaction isolation. The callback should trigger refresh
   * in the auth charm's transaction context (e.g., via a refresh stream).
   */
  onRefresh?: () => Promise<void>;
}

// ============================================================================
// HELPERS
// ============================================================================

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
 * Do NOT pass a derived auth cell - use property access (charm.auth) instead.
 * See: community-docs/superstitions/2025-12-03-derive-creates-readonly-cells-use-property-access.md
 */
export class GoogleDocsClient {
  private auth: Cell<Auth>;
  private retries: number;
  private delay: number;
  private delayIncrement: number;
  private debugMode: boolean;
  private onRefresh?: () => Promise<void>;

  constructor(
    auth: Cell<Auth>,
    {
      retries = 3,
      delay = 1000,
      delayIncrement = 1000,
      debugMode = false,
      onRefresh,
    }: GoogleDocsClientConfig = {},
  ) {
    this.auth = auth;
    this.retries = retries;
    this.delay = delay;
    this.delayIncrement = delayIncrement;
    this.debugMode = debugMode;
    this.onRefresh = onRefresh;
  }

  /**
   * Refresh the OAuth token using the refresh token.
   * Updates the auth cell with new token data.
   *
   * If an external onRefresh callback was provided, it will be used instead
   * of direct cell update. This enables cross-charm refresh where direct
   * cell writes would fail due to transaction isolation.
   */
  private async refreshAuth(): Promise<void> {
    // If an external refresh callback was provided, use it
    // (for cross-charm refresh via streams)
    if (this.onRefresh) {
      debugLog(
        this.debugMode,
        "Refreshing auth token via external callback...",
      );
      await this.onRefresh();
      debugLog(this.debugMode, "Auth token refreshed via external callback");
      return;
    }

    // Fall back to direct refresh (only works if auth cell is writable)
    const refreshToken = this.auth.get().refreshToken;
    if (!refreshToken) {
      throw new Error("No refresh token available");
    }

    debugLog(this.debugMode, "Refreshing auth token directly...");

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
    this.auth.update(authData);
    debugLog(this.debugMode, "Auth token refreshed successfully");
  }

  /**
   * Make an authenticated request to Google APIs.
   * Handles 401 (token refresh) and 429 (rate limit) automatically.
   */
  private async request(
    url: URL,
    options?: RequestInit,
    retries?: number,
  ): Promise<Response> {
    // Get fresh token on each request
    const token = this.auth.get().token;
    if (!token) {
      throw new Error("No authorization token");
    }

    const retriesLeft = retries ?? this.retries;
    const opts = options ?? {};
    opts.headers = new Headers(opts.headers);
    opts.headers.set("Authorization", `Bearer ${token}`);

    // Add delay if we've been rate limited
    if (this.delay > 1000) {
      await sleep(this.delay - 1000);
    }

    const res = await fetch(url, opts);
    const { ok, status, statusText } = res;

    if (ok) {
      debugLog(this.debugMode, `${url}: ${status} ${statusText}`);
      // Reset delay on success
      this.delay = 1000;
      return res;
    }

    debugWarn(
      this.debugMode,
      `${url}: ${status} ${statusText}`,
      `Remaining retries: ${retriesLeft}`,
    );

    if (retriesLeft === 0) {
      // Handle specific error codes with helpful messages
      if (status === 401) {
        throw new Error(
          "Token expired. Please re-authenticate in your Google Auth charm.",
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

    await sleep(this.delay);

    if (status === 401) {
      await this.refreshAuth();
    } else if (status === 429) {
      this.delay += this.delayIncrement;
      debugLog(
        this.debugMode,
        `Rate limited, incrementing delay to ${this.delay}ms`,
      );
      await sleep(this.delay);
    }

    return this.request(url, options, retriesLeft - 1);
  }

  /**
   * Get a Google Docs document by ID.
   *
   * @param docId The document ID
   * @returns The full document structure
   */
  async getDocument(docId: string): Promise<GoogleDocsDocument> {
    const url = new URL(`https://docs.googleapis.com/v1/documents/${docId}`);

    debugLog(this.debugMode, `Fetching document: ${docId}`);
    const res = await this.request(url);
    const doc = await res.json();
    debugLog(this.debugMode, `Document fetched: ${doc.title}`);

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
  async listComments(
    fileId: string,
    includeResolved: boolean = false,
  ): Promise<GoogleComment[]> {
    const allComments: GoogleComment[] = [];
    let pageToken: string | undefined;

    debugLog(this.debugMode, `Fetching comments for file: ${fileId}`);

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

      const res = await this.request(url);
      const json = await res.json();

      const comments = json.comments || [];
      debugLog(
        this.debugMode,
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
      this.debugMode,
      `Total comments fetched: ${allComments.length} (includeResolved: ${includeResolved})`,
    );

    return allComments;
  }
}
