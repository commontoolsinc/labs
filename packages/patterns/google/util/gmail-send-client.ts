/**
 * Gmail Write API client for sending emails and modifying labels.
 *
 * This module provides a client for Gmail API write operations:
 * - RFC 2822 MIME message construction for sending
 * - Base64url encoding for Gmail API
 * - Thread reply support with In-Reply-To headers
 * - Label modification (add/remove) for single or batch messages
 * - Token refresh on 401 errors
 *
 * Usage:
 * ```typescript
 * import { GmailSendClient } from "./util/gmail-send-client.ts";
 *
 * const client = new GmailSendClient(authCell, { debugMode: true });
 *
 * // Send email (requires gmail.send scope)
 * const result = await client.sendEmail({
 *   to: "recipient@example.com",
 *   subject: "Hello",
 *   body: "World!",
 * });
 *
 * // Modify labels (requires gmail.modify scope)
 * await client.modifyLabels("messageId123", {
 *   addLabelIds: ["STARRED"],
 *   removeLabelIds: ["UNREAD"],
 * });
 *
 * // Batch modify labels (up to 1000 messages)
 * await client.batchModifyLabels(["msg1", "msg2"], {
 *   addLabelIds: ["Label_123"],
 * });
 * ```
 */
import { getRecipeEnvironment, Writable } from "commontools";

const env = getRecipeEnvironment();

// Re-export the Auth type for convenience
export type { Auth } from "../google-auth.tsx";
import type { Auth } from "../google-auth.tsx";

// ============================================================================
// TYPES
// ============================================================================

export interface GmailSendClientConfig {
  /** Enable verbose console logging */
  debugMode?: boolean;
}

export interface SendEmailParams {
  /** Recipient email address (required) */
  to: string;
  /** Email subject line (required) */
  subject: string;
  /** Plain text body (required) */
  body: string;
  /** CC recipients (optional, comma-separated) */
  cc?: string;
  /** BCC recipients (optional, comma-separated) */
  bcc?: string;
  /** Message ID to reply to (for threading) */
  replyToMessageId?: string;
  /** Thread ID to reply to (for threading) */
  replyToThreadId?: string;
}

export interface SendEmailResult {
  /** Gmail message ID */
  id: string;
  /** Gmail thread ID */
  threadId: string;
  /** Labels applied to the message */
  labelIds: string[];
}

export interface ModifyLabelsParams {
  /** Label IDs to add (max 100 per request) */
  addLabelIds?: string[];
  /** Label IDs to remove (max 100 per request) */
  removeLabelIds?: string[];
}

export interface ModifyLabelsResult {
  /** Gmail message ID */
  id: string;
  /** Gmail thread ID */
  threadId: string;
  /** Labels now on the message */
  labelIds: string[];
}

export interface GmailLabel {
  /** Label ID (use this for API calls) */
  id: string;
  /** Label name (human readable) */
  name: string;
  /** Label type: system, user */
  type: "system" | "user";
  /** Message list visibility */
  messageListVisibility?: "show" | "hide";
  /** Label list visibility */
  labelListVisibility?: "labelShow" | "labelShowIfUnread" | "labelHide";
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Maximum retry attempts for 401 token refresh errors.
 * Allows 3 total attempts (initial + 2 retries) before failing.
 * This prevents infinite recursion while giving transient auth issues a chance to resolve.
 */
const MAX_RETRY_ATTEMPTS = 2;

/**
 * Base delay in ms for exponential backoff between retries.
 * Actual delay = BASE_RETRY_DELAY_MS * 2^retryCount (100ms, 200ms, 400ms...)
 */
const BASE_RETRY_DELAY_MS = 100;

function debugLog(debugMode: boolean, ...args: unknown[]) {
  if (debugMode) console.log("[GmailSendClient]", ...args);
}

/**
 * Sleep for exponential backoff delay based on retry count.
 */
async function retryDelay(retryCount: number): Promise<void> {
  const delay = BASE_RETRY_DELAY_MS * Math.pow(2, retryCount);
  await new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Encode a string as base64url (Gmail API format).
 * Handles UTF-8 characters properly.
 */
function base64UrlEncode(str: string): string {
  // Use encodeURIComponent to handle UTF-8, then convert to base64
  const utf8Bytes = unescape(encodeURIComponent(str));
  const base64 = btoa(utf8Bytes);
  // Convert to base64url: replace + with -, / with _, and remove padding
  return base64
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Encode a header value using RFC 2047 if it contains non-ASCII characters.
 * This ensures subjects with Unicode characters are properly encoded.
 */
function encodeHeaderValue(value: string): string {
  // Check if value contains non-ASCII characters
  // deno-lint-ignore no-control-regex
  if (!/^[\x00-\x7F]*$/.test(value)) {
    // Use UTF-8 B (base64) encoding for non-ASCII
    const utf8Bytes = unescape(encodeURIComponent(value));
    const base64 = btoa(utf8Bytes);
    return `=?UTF-8?B?${base64}?=`;
  }
  return value;
}

// ============================================================================
// GMAIL SEND CLIENT
// ============================================================================

/**
 * Gmail Write API client.
 *
 * Provides write operations for Gmail:
 * - Send emails (requires gmail.send scope)
 * - Modify labels (requires gmail.modify scope)
 * - List available labels (requires gmail.modify or gmail.readonly scope)
 *
 * IMPORTANT: The auth cell MUST be writable for token refresh to work!
 */
export class GmailSendClient {
  private auth: Writable<Auth>;
  private debugMode: boolean;

  constructor(
    auth: Writable<Auth>,
    { debugMode = false }: GmailSendClientConfig = {},
  ) {
    this.auth = auth;
    this.debugMode = debugMode;
  }

  /**
   * Send an email via Gmail API.
   *
   * Constructs an RFC 2822 MIME message and sends it using the
   * Gmail messages.send endpoint.
   *
   * @param params - Email parameters (to, subject, body, etc.)
   * @returns The sent message metadata (id, threadId, labelIds)
   * @throws Error if sending fails or auth is invalid
   */
  async sendEmail(
    params: SendEmailParams,
    retryCount = 0,
  ): Promise<SendEmailResult> {
    const token = this.auth.get()?.token;
    if (!token) {
      throw new Error("No authorization token. Please authenticate first.");
    }

    debugLog(this.debugMode, "Preparing email:", {
      to: params.to,
      subject: params.subject,
      bodyLength: params.body.length,
      hasReplyTo: !!params.replyToMessageId,
    });

    // Build RFC 2822 MIME message
    const messageParts: string[] = [];

    // Required headers
    messageParts.push(`To: ${params.to}`);
    if (params.cc) {
      messageParts.push(`Cc: ${params.cc}`);
    }
    if (params.bcc) {
      messageParts.push(`Bcc: ${params.bcc}`);
    }
    messageParts.push(`Subject: ${encodeHeaderValue(params.subject)}`);
    messageParts.push('Content-Type: text/plain; charset="UTF-8"');
    messageParts.push("MIME-Version: 1.0");

    // Thread reply headers (for proper threading in Gmail)
    if (params.replyToMessageId) {
      messageParts.push(`In-Reply-To: ${params.replyToMessageId}`);
      messageParts.push(`References: ${params.replyToMessageId}`);
    }

    // Empty line separates headers from body (RFC 2822)
    messageParts.push("");
    messageParts.push(params.body);

    const rawMessage = messageParts.join("\r\n");

    // Encode as base64url for Gmail API
    const encodedMessage = base64UrlEncode(rawMessage);

    // Build request body
    const requestBody: Record<string, string> = { raw: encodedMessage };
    if (params.replyToThreadId) {
      requestBody.threadId = params.replyToThreadId;
    }

    debugLog(this.debugMode, "Sending email...");

    // Send the email
    const res = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      },
    );

    // Handle 401 (token expired) - try to refresh and retry with exponential backoff
    if (res.status === 401) {
      debugLog(
        this.debugMode,
        `Token expired (attempt ${retryCount + 1}/${
          MAX_RETRY_ATTEMPTS + 1
        }), attempting refresh...`,
      );
      if (retryCount >= MAX_RETRY_ATTEMPTS) {
        throw new Error(
          `Authentication failed after ${
            MAX_RETRY_ATTEMPTS + 1
          } attempts. Your session may have expired or permissions were revoked. Please re-authenticate.`,
        );
      }
      await this.refreshAuth();
      await retryDelay(retryCount);
      return this.sendEmail(params, retryCount + 1);
    }

    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      const errorMessage = error.error?.message || res.statusText;
      debugLog(this.debugMode, "Send failed:", res.status, errorMessage);
      throw new Error(`Gmail API error: ${res.status} ${errorMessage}`);
    }

    const result = await res.json();
    debugLog(this.debugMode, "Email sent successfully:", result.id);

    return {
      id: result.id,
      threadId: result.threadId,
      labelIds: result.labelIds || [],
    };
  }

  /**
   * Modify labels on a single message.
   *
   * @param messageId - Gmail message ID
   * @param params - Labels to add and/or remove
   * @returns The modified message metadata
   * @throws Error if modification fails or auth is invalid
   */
  async modifyLabels(
    messageId: string,
    params: ModifyLabelsParams,
    retryCount = 0,
  ): Promise<ModifyLabelsResult> {
    const token = this.auth.get()?.token;
    if (!token) {
      throw new Error("No authorization token. Please authenticate first.");
    }

    debugLog(this.debugMode, "Modifying labels on message:", messageId, params);

    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${
        encodeURIComponent(messageId)
      }/modify`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          addLabelIds: params.addLabelIds || [],
          removeLabelIds: params.removeLabelIds || [],
        }),
      },
    );

    // Handle 401 (token expired) - try to refresh and retry with exponential backoff
    if (res.status === 401) {
      debugLog(
        this.debugMode,
        `Token expired (attempt ${retryCount + 1}/${
          MAX_RETRY_ATTEMPTS + 1
        }), attempting refresh...`,
      );
      if (retryCount >= MAX_RETRY_ATTEMPTS) {
        throw new Error(
          `Authentication failed after ${
            MAX_RETRY_ATTEMPTS + 1
          } attempts. Your session may have expired or permissions were revoked. Please re-authenticate.`,
        );
      }
      await this.refreshAuth();
      await retryDelay(retryCount);
      return this.modifyLabels(messageId, params, retryCount + 1);
    }

    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      const errorMessage = error.error?.message || res.statusText;
      debugLog(this.debugMode, "Modify failed:", res.status, errorMessage);
      throw new Error(`Gmail API error: ${res.status} ${errorMessage}`);
    }

    const result = await res.json();
    debugLog(this.debugMode, "Labels modified successfully:", result.id);

    return {
      id: result.id,
      threadId: result.threadId,
      labelIds: result.labelIds || [],
    };
  }

  /**
   * Modify labels on multiple messages at once.
   *
   * @param messageIds - Array of Gmail message IDs (max 1000)
   * @param params - Labels to add and/or remove
   * @throws Error if modification fails or auth is invalid
   */
  async batchModifyLabels(
    messageIds: string[],
    params: ModifyLabelsParams,
    retryCount = 0,
  ): Promise<void> {
    const token = this.auth.get()?.token;
    if (!token) {
      throw new Error("No authorization token. Please authenticate first.");
    }

    if (messageIds.length === 0) {
      debugLog(this.debugMode, "No messages to modify");
      return;
    }

    if (messageIds.length > 1000) {
      throw new Error("Cannot batch modify more than 1000 messages at once");
    }

    debugLog(
      this.debugMode,
      `Batch modifying labels on ${messageIds.length} messages:`,
      params,
    );

    const res = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ids: messageIds,
          addLabelIds: params.addLabelIds || [],
          removeLabelIds: params.removeLabelIds || [],
        }),
      },
    );

    // Handle 401 (token expired) - try to refresh and retry with exponential backoff
    if (res.status === 401) {
      debugLog(
        this.debugMode,
        `Token expired (attempt ${retryCount + 1}/${
          MAX_RETRY_ATTEMPTS + 1
        }), attempting refresh...`,
      );
      if (retryCount >= MAX_RETRY_ATTEMPTS) {
        throw new Error(
          `Authentication failed after ${
            MAX_RETRY_ATTEMPTS + 1
          } attempts. Your session may have expired or permissions were revoked. Please re-authenticate.`,
        );
      }
      await this.refreshAuth();
      await retryDelay(retryCount);
      return this.batchModifyLabels(messageIds, params, retryCount + 1);
    }

    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      const errorMessage = error.error?.message || res.statusText;
      debugLog(
        this.debugMode,
        "Batch modify failed:",
        res.status,
        errorMessage,
      );
      throw new Error(`Gmail API error: ${res.status} ${errorMessage}`);
    }

    debugLog(
      this.debugMode,
      `Batch label modification successful for ${messageIds.length} messages`,
    );
  }

  /**
   * List all available labels in the user's mailbox.
   *
   * @returns Array of available labels
   * @throws Error if listing fails or auth is invalid
   */
  async listLabels(retryCount = 0): Promise<GmailLabel[]> {
    const token = this.auth.get()?.token;
    if (!token) {
      throw new Error("No authorization token. Please authenticate first.");
    }

    debugLog(this.debugMode, "Listing labels...");

    const res = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/labels",
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    // Handle 401 (token expired) - try to refresh and retry with exponential backoff
    if (res.status === 401) {
      debugLog(
        this.debugMode,
        `Token expired (attempt ${retryCount + 1}/${
          MAX_RETRY_ATTEMPTS + 1
        }), attempting refresh...`,
      );
      if (retryCount >= MAX_RETRY_ATTEMPTS) {
        throw new Error(
          `Authentication failed after ${
            MAX_RETRY_ATTEMPTS + 1
          } attempts. Your session may have expired or permissions were revoked. Please re-authenticate.`,
        );
      }
      await this.refreshAuth();
      await retryDelay(retryCount);
      return this.listLabels(retryCount + 1);
    }

    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      const errorMessage = error.error?.message || res.statusText;
      debugLog(this.debugMode, "List labels failed:", res.status, errorMessage);
      throw new Error(`Gmail API error: ${res.status} ${errorMessage}`);
    }

    const result = await res.json();
    const labels: GmailLabel[] = (result.labels || []).map(
      (l: Record<string, unknown>) => ({
        id: l.id as string,
        name: l.name as string,
        type: l.type as "system" | "user",
        messageListVisibility: l.messageListVisibility as
          | "show"
          | "hide"
          | undefined,
        labelListVisibility: l.labelListVisibility as
          | "labelShow"
          | "labelShowIfUnread"
          | "labelHide"
          | undefined,
      }),
    );

    debugLog(this.debugMode, `Found ${labels.length} labels`);
    return labels;
  }

  /**
   * Refresh the OAuth token using the refresh token.
   * Updates the auth cell with new token data.
   */
  private async refreshAuth(): Promise<void> {
    const refreshToken = this.auth.get()?.refreshToken;
    if (!refreshToken) {
      throw new Error("No refresh token available. Please re-authenticate.");
    }

    debugLog(this.debugMode, "Refreshing auth token...");

    const res = await fetch(
      new URL("/api/integrations/google-oauth/refresh", env.apiUrl),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      },
    );

    if (!res.ok) {
      throw new Error("Token refresh failed. Please re-authenticate.");
    }

    const json = await res.json();
    if (!json.tokenInfo) {
      throw new Error("Invalid refresh response");
    }

    // Update auth cell with new token data
    // Keep existing user info since refresh doesn't return it
    const currentAuth = this.auth.get();
    this.auth.update({
      ...json.tokenInfo,
      user: currentAuth?.user,
    });

    debugLog(this.debugMode, "Auth token refreshed successfully");
  }
}
