/// <cts-enable />
import {
  computed,
  Default,
  derive,
  getPatternEnvironment,
  handler,
  ifElse,
  NAME,
  pattern,
  patternTool,
  PatternToolResult as _PatternToolResult,
  str,
  Stream,
  UI,
  VNode,
  Writable,
} from "commontools";
import TurndownService from "turndown";
import { GmailClient } from "./util/gmail-client.ts";
import { GoogleAuthManagerMinimal } from "./util/google-auth-manager-minimal.tsx";

type CFC<T, C extends string> = T;
type Secret<T> = CFC<T, "secret">;
type Confidential<T> = CFC<T, "confidential">;

/**
 * Writable cell with sync method.
 * The sync() method is added by the runner via module augmentation,
 * but isn't visible in the base Cell type from the api package.
 */
type SyncableWritable<T> = Writable<T> & {
  sync(): Promise<Writable<T>> | Writable<T>;
};

/**
 * Auth data structure for Google OAuth tokens.
 *
 * ⚠️ CRITICAL: When consuming this auth, DO NOT use derive()!
 * derive() creates read-only projections - token refresh will silently fail.
 * Use property access (piece.auth) or ifElse() instead.
 *
 * See: community-docs/superstitions/2025-12-03-derive-creates-readonly-cells-use-property-access.md
 */
export type Auth = {
  token: Default<Secret<string>, "">;
  tokenType: Default<string, "">;
  scope: Default<string[], []>;
  expiresIn: Default<number, 0>;
  expiresAt: Default<number, 0>;
  refreshToken: Default<Secret<string>, "">;
  user: Default<{
    email: string;
    name: string;
    picture: string;
  }, { email: ""; name: ""; picture: "" }>;
};

// Initialize turndown service
const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
});

const _env = getPatternEnvironment();

turndown.addRule("removeStyleTags", {
  filter: ["style"],
  replacement: function () {
    return "";
  },
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** An #email */
export type Email = {
  // Unique identifier for the email
  id: string;
  // Identifier for the email thread
  threadId: string;
  // Labels assigned to the email
  labelIds: Default<string[], []>;
  // Brief preview of the email content
  snippet: string;
  // Email subject line
  subject: string;
  // Sender's #email-address
  from: string;
  // Date and time when the email was sent
  date: string;
  // Recipient's #email-address
  to: string;
  // Email content in plain text format (often empty)
  plainText: string;
  // Email content in HTML format
  htmlContent: string;
  // Email content converted to Markdown format. Often best for processing email contents.
  markdownContent: string;
};

type Settings = {
  // Gmail filter query to use for fetching emails
  gmailFilterQuery: Default<string, "in:INBOX">;
  // Maximum number of emails to fetch
  limit: Default<number, 10>;
  // Enable verbose console logging for debugging
  debugMode: Default<boolean, false>;
  // Automatically fetch emails when auth becomes valid (opt-in)
  autoFetchOnAuth: Default<boolean, false>;
  // Resolve inline image attachments (cid: references) to base64 data URLs
  // Enable this for emails with embedded images (e.g., USPS Informed Delivery)
  // Note: This fetches additional attachment data which may be slower
  resolveInlineImages: Default<boolean, false>;
};

/** Gmail email importer for fetching and viewing emails. #gmailEmails */
interface Output {
  [NAME]: string;
  [UI]: VNode;
  /** Array of imported emails */
  emails: Email[];
  /** Mentionables */
  mentionable: Email[];
  /** Number of emails imported */
  emailCount: number;
  /** Auth UI component for managing Google OAuth connection */
  authUI: VNode;
  /** Handler to trigger email fetch from external patterns */
  bgUpdater: Stream<unknown>;
  /** Whether auth is ready (has valid token) */
  isReady: boolean;
  // /** Search emails by query string (searches subject, from, snippet) */
  // searchEmails: PatternToolResult<{ query: string }>;
  // /** Get count of imported emails */
  // getEmailCount: PatternToolResult<void>;
  // /** Get recent emails as formatted string */
  // getRecentEmails: PatternToolResult<{ count: number }>;
}

// Debug logging helpers - pass debugMode explicitly to avoid module-level state issues
function debugLog(debugMode: boolean, ...args: unknown[]) {
  if (debugMode) console.log("[GmailImporter]", ...args);
}
function debugWarn(debugMode: boolean, ...args: unknown[]) {
  if (debugMode) console.warn("[GmailImporter]", ...args);
}

// Prefixed with _ as not currently used - preserved for potential future UI binding
const _updateLimit = handler<
  { detail: { value: string } },
  { limit: Writable<number> }
>(
  ({ detail }, state) => {
    state.limit.set(parseInt(detail?.value ?? "100") || 0);
  },
);

// GmailClient is now imported from ./util/gmail-client.ts
// This enables code reuse with gmail-agentic-search and ensures
// consistent token refresh behavior across all Gmail patterns.

const googleUpdater = handler<unknown, {
  emails: SyncableWritable<Array<Writable<Email>>>;
  auth: SyncableWritable<Auth>;
  settings: SyncableWritable<
    Default<Settings, {
      gmailFilterQuery: "in:INBOX";
      limit: 10;
      debugMode: false;
      autoFetchOnAuth: false;
      resolveInlineImages: false;
    }>
  >;
  historyId: SyncableWritable<string>;
  fetching?: Writable<boolean>;
}>(
  async (_event, state) => {
    // Set fetching state if available
    if (state.fetching) {
      state.fetching.set(true);
    }

    // Ensure all cells are synced before proceeding,
    // otherwise we may end up conflicting.
    await Promise.all([
      state.emails.sync(),
      state.auth.sync(),
      state.settings.sync(),
      state.historyId.sync(),
    ]);

    const settings = state.settings.get() || {};

    const debugMode = settings.debugMode || false;

    debugLog(debugMode, "googleUpdater!");

    if (!state.auth.get()?.token) {
      debugWarn(debugMode, "no token found in auth cell");
      if (state.fetching) state.fetching.set(false);
      return;
    }

    const gmailFilterQuery = settings.gmailFilterQuery;

    debugLog(debugMode, "gmailFilterQuery", gmailFilterQuery);

    let result;
    try {
      result = await process(
        state.auth,
        settings.limit,
        gmailFilterQuery,
        {
          emails: state.emails,
          historyId: state.historyId,
          resolveInlineImages: settings.resolveInlineImages,
        },
        debugMode,
      );
    } finally {
      // Clear fetching state
      if (state.fetching) state.fetching.set(false);
    }

    if (!result) return;

    // Handle deleted emails
    if (result.deletedEmailIds && result.deletedEmailIds.length > 0) {
      debugLog(
        debugMode,
        `Removing ${result.deletedEmailIds.length} deleted messages`,
      );
      const deleteSet = new Set(result.deletedEmailIds);
      const currentEmails = state.emails.get();
      const remainingEmails = currentEmails.filter((email) =>
        !deleteSet.has(email.key("id").get())
      );
      state.emails.set(remainingEmails);
    }

    // Add new emails
    if (result.newEmails && result.newEmails.length > 0) {
      debugLog(debugMode, `Adding ${result.newEmails.length} new emails`);
      state.emails.push(...result.newEmails);
    }

    // Update historyId
    if (result.newHistoryId) {
      const previousHistoryId = state.historyId.get();
      debugLog(debugMode, "=== UPDATING HISTORY ID ===");
      debugLog(
        debugMode,
        "Previous historyId:",
        previousHistoryId || "none",
      );
      debugLog(debugMode, "New historyId:", result.newHistoryId);
      state.historyId.set(result.newHistoryId);
      debugLog(debugMode, "HistoryId updated successfully");
      debugLog(debugMode, "==========================");
    }
  },
);

// Helper function to decode base64 encoded email parts with proper UTF-8 handling
function decodeBase64(data: string): string {
  // Replace URL-safe characters back to their original form
  const sanitized = data.replace(/-/g, "+").replace(/_/g, "/");
  // Decode the base64 string to binary
  const binaryString = atob(sanitized);
  // Convert binary string to Uint8Array for proper UTF-8 decoding
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  // Use TextDecoder to properly decode UTF-8
  return new TextDecoder("utf-8").decode(bytes);
}

// Helper function to extract email address from a header value
function extractEmailAddress(header: string | null | undefined): string {
  if (!header) return "";
  const emailMatch = header.match(/<([^>]*)>/);
  if (emailMatch && emailMatch[1]) {
    return emailMatch[1];
  }
  return header;
}

// Helper function to extract header value from message headers
function getHeader(headers: any[] | null | undefined, name: string): string {
  if (!headers || !Array.isArray(headers)) return "";
  const header = headers.find((h) =>
    h?.name?.toLowerCase() === name.toLowerCase()
  );
  return header?.value ?? "";
}

// Helper to escape special regex characters
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Resolve cid: references in HTML by fetching inline image attachments.
 * Returns HTML with cid: URLs replaced by base64 data URLs.
 *
 * CID (Content-ID) references are used in emails to embed images directly
 * in the message body as MIME attachments. Example:
 *   <img src="cid:1019388469-033.jpg" alt="Mailpiece Image">
 *
 * This is common in USPS Informed Delivery emails where mail piece scans
 * are embedded as inline attachments rather than external URLs.
 *
 * PERFORMANCE: Uses Promise.all() for parallel attachment fetching instead
 * of sequential fetching, significantly reducing latency for emails with
 * multiple inline images (e.g., USPS Informed Delivery with 5-10 mail scans).
 */
async function resolveCidReferences(
  messageId: string,
  parts: any[],
  htmlContent: string,
  client: GmailClient,
  debugMode: boolean,
): Promise<string> {
  // Build map of Content-ID -> attachmentId
  const cidMap = new Map<string, { attachmentId: string; mimeType: string }>();

  function collectCidParts(parts: any[]) {
    for (const part of parts) {
      if (part.body?.attachmentId && part.headers) {
        const contentId = getHeader(part.headers, "Content-ID");
        if (contentId) {
          // Content-ID is typically <id> - strip angle brackets
          const cid = contentId.replace(/^<|>$/g, "");
          cidMap.set(cid, {
            attachmentId: part.body.attachmentId,
            mimeType: part.mimeType || "image/jpeg",
          });
          debugLog(
            debugMode,
            `[CID] Found inline attachment: cid:${cid} -> ${part.body.attachmentId}`,
          );
        }
      }
      // Recurse into nested parts
      if (part.parts) {
        collectCidParts(part.parts);
      }
    }
  }

  collectCidParts(parts);

  if (cidMap.size === 0) {
    debugLog(debugMode, "[CID] No inline attachments found");
    return htmlContent;
  }

  debugLog(
    debugMode,
    `[CID] Found ${cidMap.size} inline attachments to resolve (fetching in parallel)`,
  );

  // Fetch all attachments in parallel using Promise.all for better performance
  const cidEntries = Array.from(cidMap.entries());
  const fetchResults = await Promise.all(
    cidEntries.map(async ([cid, { attachmentId, mimeType }]) => {
      try {
        debugLog(debugMode, `[CID] Fetching attachment for cid:${cid}`);
        const data = await client.getAttachment(messageId, attachmentId);
        // Convert base64url to standard base64
        const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
        const dataUrl = `data:${mimeType};base64,${base64}`;
        debugLog(
          debugMode,
          `[CID] Resolved cid:${cid} (${data.length} chars of base64 data)`,
        );
        return { cid, dataUrl, success: true as const };
      } catch (error) {
        debugWarn(
          debugMode,
          `[CID] Failed to fetch attachment for cid:${cid}:`,
          error,
        );
        return { cid, dataUrl: null, success: false as const };
      }
    }),
  );

  // Apply all successful replacements to HTML
  let resolvedHtml = htmlContent;
  for (const result of fetchResults) {
    if (result.success && result.dataUrl) {
      // Replace all occurrences of this cid: reference
      resolvedHtml = resolvedHtml.replace(
        new RegExp(`cid:${escapeRegExp(result.cid)}`, "gi"),
        result.dataUrl,
      );
    }
  }

  debugLog(
    debugMode,
    `[CID] Batch resolution complete: ${
      fetchResults.filter((r) => r.success).length
    }/${cidEntries.length} successful`,
  );

  return resolvedHtml;
}

async function messageToEmail(
  parts: any[],
  debugMode: boolean = false,
  client?: GmailClient,
  resolveInlineImages: boolean = false,
): Promise<Email[]> {
  const results = await Promise.all(parts.map(async (messageData, index) => {
    try {
      // DEBUG: Log raw message structure
      debugLog(
        debugMode,
        `\n[messageToEmail] Processing message ${index + 1}/${parts.length}`,
      );
      debugLog(debugMode, `[messageToEmail] Message ID: ${messageData.id}`);
      debugLog(
        debugMode,
        `[messageToEmail] Has payload: ${!!messageData.payload}`,
      );
      debugLog(
        debugMode,
        `[messageToEmail] Has payload.parts: ${!!messageData.payload?.parts}`,
      );
      debugLog(
        debugMode,
        `[messageToEmail] Payload.parts length: ${
          messageData.payload?.parts?.length || 0
        }`,
      );
      debugLog(
        debugMode,
        `[messageToEmail] Has payload.body: ${!!messageData.payload?.body}`,
      );
      debugLog(
        debugMode,
        `[messageToEmail] Has payload.body.data: ${!!messageData.payload?.body
          ?.data}`,
      );
      debugLog(
        debugMode,
        `[messageToEmail] Payload.mimeType: ${messageData.payload?.mimeType}`,
      );

      if (!messageData.payload?.headers) {
        debugLog(
          debugMode,
          "[messageToEmail] ERROR: Missing required message data:",
          messageData,
        );
        return null;
      }

      const messageHeaders = messageData.payload.headers;
      const subject = getHeader(messageHeaders, "Subject");
      const from = getHeader(messageHeaders, "From");
      const to = getHeader(messageHeaders, "To");
      const date = getHeader(messageHeaders, "Date");

      debugLog(debugMode, `[messageToEmail] Subject: ${subject}`);
      debugLog(debugMode, `[messageToEmail] From: ${from}`);

      let plainText = "";
      let htmlContent = "";

      if (
        messageData.payload.parts && Array.isArray(messageData.payload.parts)
      ) {
        debugLog(
          debugMode,
          `[messageToEmail] Processing ${messageData.payload.parts.length} parts`,
        );

        // Log structure of each part
        messageData.payload.parts.forEach((part: any, partIndex: number) => {
          debugLog(debugMode, `[messageToEmail] Part ${partIndex + 1}:`);
          debugLog(debugMode, `  - mimeType: ${part.mimeType}`);
          debugLog(debugMode, `  - Has body: ${!!part.body}`);
          debugLog(debugMode, `  - Has body.data: ${!!part.body?.data}`);
          debugLog(debugMode, `  - body.size: ${part.body?.size || 0}`);
          debugLog(debugMode, `  - Has nested parts: ${!!part.parts}`);
          debugLog(
            debugMode,
            `  - Nested parts length: ${part.parts?.length || 0}`,
          );
        });

        // Look for plainText part
        const textPart = messageData.payload.parts.find(
          (part: any) => part.mimeType === "text/plain",
        );
        debugLog(
          debugMode,
          `[messageToEmail] Found text/plain part: ${!!textPart}`,
        );
        if (textPart?.body?.data) {
          plainText = decodeBase64(textPart.body.data);
          debugLog(
            debugMode,
            `[messageToEmail] Decoded plainText length: ${plainText.length}`,
          );
        } else {
          debugLog(
            debugMode,
            `[messageToEmail] text/plain part has no body.data`,
          );
        }

        // Look for HTML part
        const htmlPart = messageData.payload.parts.find(
          (part: any) => part.mimeType === "text/html",
        );
        debugLog(
          debugMode,
          `[messageToEmail] Found text/html part: ${!!htmlPart}`,
        );
        if (htmlPart?.body?.data) {
          htmlContent = decodeBase64(htmlPart.body.data);
          debugLog(
            debugMode,
            `[messageToEmail] Decoded htmlContent length: ${htmlContent.length}`,
          );
        } else {
          debugLog(
            debugMode,
            `[messageToEmail] text/html part has no body.data`,
          );
        }

        // Handle multipart messages - check for nested parts
        if (htmlContent === "") {
          debugLog(
            debugMode,
            `[messageToEmail] No HTML found in top-level parts, checking nested parts...`,
          );
          for (const part of messageData.payload.parts) {
            if (part.parts && Array.isArray(part.parts)) {
              debugLog(
                debugMode,
                `[messageToEmail] Found nested parts container with ${part.parts.length} nested parts`,
              );
              const nestedHtmlPart = part.parts.find(
                (nestedPart: any) => nestedPart.mimeType === "text/html",
              );
              if (nestedHtmlPart?.body?.data) {
                htmlContent = decodeBase64(nestedHtmlPart.body.data);
                debugLog(
                  debugMode,
                  `[messageToEmail] Found HTML in nested part, length: ${htmlContent.length}`,
                );
                break;
              }
            }
          }
        }
      } else if (messageData.payload.body?.data) {
        debugLog(debugMode, `[messageToEmail] Single part message`);
        debugLog(
          debugMode,
          `[messageToEmail] body.size: ${messageData.payload.body.size}`,
        );
        const bodyData = decodeBase64(messageData.payload.body.data);
        debugLog(
          debugMode,
          `[messageToEmail] Decoded body length: ${bodyData.length}`,
        );
        if (messageData.payload.mimeType === "text/html") {
          htmlContent = bodyData;
          debugLog(debugMode, `[messageToEmail] Set as htmlContent`);
        } else {
          plainText = bodyData;
          debugLog(debugMode, `[messageToEmail] Set as plainText`);
        }
      } else {
        debugLog(
          debugMode,
          `[messageToEmail] ERROR: No payload.parts and no payload.body.data - message has NO CONTENT SOURCE!`,
        );
      }

      // Resolve inline image attachments (cid: references) if enabled
      if (resolveInlineImages && client && htmlContent) {
        debugLog(debugMode, `[messageToEmail] Resolving CID references...`);
        const allParts = messageData.payload.parts || [messageData.payload];
        htmlContent = await resolveCidReferences(
          messageData.id,
          allParts,
          htmlContent,
          client,
          debugMode,
        );
        debugLog(
          debugMode,
          `[messageToEmail] CID resolution complete, htmlContent length: ${htmlContent.length}`,
        );
      }

      // Generate markdown content from HTML or plainText
      let markdownContent = "";
      debugLog(debugMode, `[messageToEmail] Converting to markdown...`);
      debugLog(
        debugMode,
        `[messageToEmail] - Has htmlContent: ${!!htmlContent}, length: ${htmlContent.length}`,
      );
      debugLog(
        debugMode,
        `[messageToEmail] - Has plainText: ${!!plainText}, length: ${plainText.length}`,
      );

      if (htmlContent) {
        debugLog(debugMode, `[messageToEmail] Converting HTML to markdown...`);
        try {
          // Convert HTML to markdown using our custom converter
          markdownContent = turndown.turndown(htmlContent);
          debugLog(
            debugMode,
            `[messageToEmail] Markdown conversion successful, length: ${markdownContent.length}`,
          );
        } catch (error) {
          if (debugMode) {
            console.error(
              "[messageToEmail] Error converting HTML to markdown:",
              error,
            );
          }
          // Fallback to plainText if HTML conversion fails
          markdownContent = plainText;
          debugLog(
            debugMode,
            `[messageToEmail] Fell back to plainText, length: ${markdownContent.length}`,
          );
        }
      } else {
        // Use plainText as fallback if no HTML content
        debugLog(
          debugMode,
          `[messageToEmail] No HTML, using plainText as markdown`,
        );
        markdownContent = plainText;
        debugLog(
          debugMode,
          `[messageToEmail] Final markdown length: ${markdownContent.length}`,
        );
      }

      debugLog(debugMode, `[messageToEmail] === FINAL EMAIL CONTENT ===`);
      debugLog(
        debugMode,
        `[messageToEmail] plainText: ${plainText.length} chars`,
      );
      debugLog(
        debugMode,
        `[messageToEmail] htmlContent: ${htmlContent.length} chars`,
      );
      debugLog(
        debugMode,
        `[messageToEmail] markdownContent: ${markdownContent.length} chars`,
      );
      debugLog(
        debugMode,
        `[messageToEmail] snippet: ${messageData.snippet?.length || 0} chars`,
      );
      debugLog(debugMode, `[messageToEmail] ===========================\n`);

      return {
        id: messageData.id,
        threadId: messageData.threadId,
        labelIds: messageData.labelIds || ["INBOX"],
        snippet: messageData.snippet || "",
        subject,
        from: extractEmailAddress(from),
        date,
        to: extractEmailAddress(to),
        plainText,
        htmlContent,
        markdownContent,
      };
    } catch (error: any) {
      if (debugMode) {
        console.error(
          "Error processing message part:",
          "message" in error ? error.message : error,
        );
      }
      return null;
    }
  }));
  return results.filter((message): message is Email => message !== null);
}

export async function process(
  auth: Writable<Auth>,
  maxResults: number = 100,
  gmailFilterQuery: string = "in:INBOX",
  state: {
    emails: Writable<Array<Writable<Email>>>;
    historyId: Writable<string>;
    resolveInlineImages?: boolean;
  },
  debugMode: boolean = false,
): Promise<
  | { newHistoryId?: string; newEmails?: Email[]; deletedEmailIds?: string[] }
  | void
> {
  if (!auth.get()) {
    debugWarn(debugMode, "no token");
    return;
  }

  const client = new GmailClient(auth, { debugMode });
  const currentHistoryId = state.historyId.get();

  let newHistoryId: string | null = null;
  let messagesToFetch: string[] = [];
  const messagesToDelete: string[] = [];
  let useFullSync = false;

  // Get existing email IDs and create a map for efficient updates
  const existingEmails = state.emails.get();
  const emailMap = new Map<string, Writable<Email>>();
  for (const email of existingEmails) {
    emailMap.set(email.key("id").get(), email);
  }
  const existingEmailIds = new Set(emailMap.keys());

  // Try incremental sync if we have a historyId
  if (currentHistoryId) {
    debugLog(debugMode, "=== INCREMENTAL SYNC MODE ===");
    debugLog(debugMode, "Current historyId:", currentHistoryId);
    debugLog(debugMode, "Existing emails count:", existingEmails.length);

    try {
      debugLog(debugMode, "Calling Gmail History API...");
      const historyResponse = await client.fetchHistory(
        currentHistoryId,
        undefined,
        maxResults,
      );

      debugLog(debugMode, "History API Response:");
      debugLog(debugMode, "- New historyId:", historyResponse.historyId);
      debugLog(debugMode, "- Has history records:", !!historyResponse.history);
      debugLog(
        debugMode,
        "- History records count:",
        historyResponse.history?.length || 0,
      );

      if (historyResponse.history) {
        debugLog(
          debugMode,
          `Processing ${historyResponse.history.length} history records`,
        );

        // Process history records
        for (let i = 0; i < historyResponse.history.length; i++) {
          const record = historyResponse.history[i];
          debugLog(debugMode, `\nHistory Record ${i + 1}:`);
          debugLog(debugMode, "- History ID:", record.id);
          debugLog(
            debugMode,
            "- Messages added:",
            record.messagesAdded?.length || 0,
          );
          debugLog(
            debugMode,
            "- Messages deleted:",
            record.messagesDeleted?.length || 0,
          );
          debugLog(
            debugMode,
            "- Labels added:",
            record.labelsAdded?.length || 0,
          );
          debugLog(
            debugMode,
            "- Labels removed:",
            record.labelsRemoved?.length || 0,
          );

          // Handle added messages
          if (record.messagesAdded) {
            debugLog(
              debugMode,
              `  Processing ${record.messagesAdded.length} added messages`,
            );
            for (const item of record.messagesAdded) {
              if (!existingEmailIds.has(item.message.id)) {
                debugLog(
                  debugMode,
                  `    - New message to fetch: ${item.message.id}`,
                );
                messagesToFetch.push(item.message.id);
              } else {
                debugLog(
                  debugMode,
                  `    - Message already exists: ${item.message.id}`,
                );
              }
            }
          }

          // Handle deleted messages
          if (record.messagesDeleted) {
            debugLog(
              debugMode,
              `  Processing ${record.messagesDeleted.length} deleted messages`,
            );
            for (const item of record.messagesDeleted) {
              debugLog(
                debugMode,
                `    - Message to delete: ${item.message.id}`,
              );
              messagesToDelete.push(item.message.id);
            }
          }

          // Handle label changes
          if (record.labelsAdded) {
            debugLog(
              debugMode,
              `  Processing ${record.labelsAdded.length} label additions`,
            );
            for (const item of record.labelsAdded) {
              const email = emailMap.get(item.message.id);
              if (email) {
                debugLog(
                  debugMode,
                  `    - Adding labels to ${item.message.id}:`,
                  item.labelIds,
                );
                // Add new labels
                const labelCell = email.key("labelIds");
                const newLabels = new Set(labelCell.get());
                item.labelIds.forEach((label) => newLabels.add(label));
                labelCell.set(Array.from(newLabels));
              }
            }
          }

          if (record.labelsRemoved) {
            debugLog(
              debugMode,
              `  Processing ${record.labelsRemoved.length} label removals`,
            );
            for (const item of record.labelsRemoved) {
              const email = emailMap.get(item.message.id);
              if (email) {
                debugLog(
                  debugMode,
                  `    - Removing labels from ${item.message.id}:`,
                  item.labelIds,
                );
                // Remove labels
                const labelCell = email.key("labelIds");
                const labelSet = new Set(labelCell.get());
                item.labelIds.forEach((label) => labelSet.delete(label));
                labelCell.set(Array.from(labelSet));
              }
            }
          }
        }

        newHistoryId = historyResponse.historyId;
        debugLog(debugMode, "\n=== INCREMENTAL SYNC SUMMARY ===");
        debugLog(debugMode, `Messages to fetch: ${messagesToFetch.length}`);
        debugLog(debugMode, `Messages to delete: ${messagesToDelete.length}`);
        debugLog(debugMode, `Old historyId: ${currentHistoryId}`);
        debugLog(debugMode, `New historyId: ${newHistoryId}`);
        debugLog(debugMode, "================================\n");
      } else {
        debugLog(debugMode, "No history changes found");
        debugLog(
          debugMode,
          `Updating historyId from ${currentHistoryId} to ${historyResponse.historyId}`,
        );
        newHistoryId = historyResponse.historyId;
      }
    } catch (error: any) {
      if (
        error.message &&
        (error.message.includes("404") || error.message.includes("410"))
      ) {
        debugLog(debugMode, "History ID expired, falling back to full sync");
        useFullSync = true;
      } else {
        if (debugMode) console.error("Error fetching history:", error);
        throw error;
      }
    }
  } else {
    debugLog(debugMode, "=== FULL SYNC MODE ===");
    debugLog(debugMode, "No historyId found, performing full sync");
    useFullSync = true;
  }

  // Perform full sync if needed
  if (useFullSync) {
    debugLog(debugMode, "Getting user profile to obtain current historyId...");
    // Get current profile to get latest historyId
    const profile = await client.getProfile();
    newHistoryId = profile.historyId;
    debugLog(debugMode, "Profile received:");
    debugLog(debugMode, "- Email:", profile.emailAddress);
    debugLog(debugMode, "- Current historyId:", profile.historyId);
    debugLog(debugMode, "- Total messages:", profile.messagesTotal);
    debugLog(debugMode, "- Total threads:", profile.threadsTotal);

    debugLog(
      debugMode,
      `\nFetching messages with query: "${gmailFilterQuery}", limit: ${maxResults}`,
    );
    const messages = await client.fetchEmail(maxResults, gmailFilterQuery);
    debugLog(debugMode, `Received ${messages.length} messages from API`);

    messagesToFetch = messages
      .filter((message: { id: string }) => !existingEmailIds.has(message.id))
      .map((message: { id: string }) => message.id);

    debugLog(
      debugMode,
      `After filtering existing: ${messagesToFetch.length} new messages to fetch`,
    );
    debugLog(debugMode, "======================\n");
  }

  // Collect all new emails to return
  const allNewEmails: Email[] = [];

  // Fetch new messages in batches
  if (messagesToFetch.length > 0) {
    debugLog(debugMode, `Fetching ${messagesToFetch.length} new messages`);
    const batchSize = 100;

    for (let i = 0; i < messagesToFetch.length; i += batchSize) {
      const batchIds = messagesToFetch.slice(i, i + batchSize);
      debugLog(
        debugMode,
        `Processing batch ${i / batchSize + 1} of ${
          Math.ceil(messagesToFetch.length / batchSize)
        }`,
      );

      try {
        await sleep(1000);
        const fetched = await client.fetchMessagesByIds(batchIds);
        const resolveInlineImages = state.resolveInlineImages || false;
        debugLog(
          debugMode,
          `[process] resolveInlineImages setting: ${resolveInlineImages}`,
        );
        const emails = await messageToEmail(
          fetched,
          debugMode,
          client,
          resolveInlineImages,
        );

        if (emails.length > 0) {
          debugLog(debugMode, `Adding ${emails.length} new emails`);
          allNewEmails.push(...emails);
        }
      } catch (error: any) {
        if (debugMode) {
          console.error(
            "Error processing batch:",
            "message" in error ? error.message : error,
          );
        }
      }
    }
  }

  debugLog(debugMode, "Sync completed successfully");

  // Return the results instead of directly updating cells
  return {
    newHistoryId: newHistoryId || undefined,
    newEmails: allNewEmails.length > 0 ? allNewEmails : undefined,
    deletedEmailIds: messagesToDelete.length > 0 ? messagesToDelete : undefined,
  };
}

// Prefixed with _ as not currently used - preserved for potential future UI binding
const _updateGmailFilterQuery = handler<
  { detail: { value: string } },
  { gmailFilterQuery: Writable<string> }
>(
  ({ detail }, state) => {
    state.gmailFilterQuery.set(detail?.value ?? "in:INBOX");
  },
);

const toggleDebugMode = handler<
  { target: { checked: boolean } },
  { settings: Writable<Settings> }
>(
  ({ target }, { settings }) => {
    const current = settings.get();
    settings.set({ ...current, debugMode: target.checked });
  },
);

const toggleAutoFetch = handler<
  { target: { checked: boolean } },
  { settings: Writable<Settings> }
>(
  ({ target }, { settings }) => {
    const current = settings.get();
    settings.set({ ...current, autoFetchOnAuth: target.checked });
  },
);

const toggleResolveInlineImages = handler<
  { target: { checked: boolean } },
  { settings: Writable<Settings> }
>(
  ({ target }, { settings }) => {
    const current = settings.get();
    settings.set({ ...current, resolveInlineImages: target.checked });
  },
);

export default pattern<{
  settings: Default<Settings, {
    gmailFilterQuery: "in:INBOX";
    limit: 10;
    debugMode: false;
    autoFetchOnAuth: false;
    resolveInlineImages: false;
  }>;
  // Optional: Link auth directly from a Google Auth piece when wish() is unavailable
  // Use: ct piece link googleAuthPiece/auth gmailImporterPiece/overrideAuth
  overrideAuth?: Auth;
}, Output>(
  ({ settings, overrideAuth }) => {
    const emails = Writable.of<Confidential<Email[]>>([]).for("emails");
    const historyId = Writable.of("").for("historyId");
    const fetching = Writable.of(false).for("fetching");

    // Use auth manager with required scopes
    const authManager = GoogleAuthManagerMinimal({
      requiredScopes: ["gmail"],
    });

    const wishedAuth = authManager.auth;
    const authUI = authManager[UI];

    const auth = ifElse(overrideAuth.token, overrideAuth, wishedAuth);
    const isReady = computed(() =>
      overrideAuth.token ? true : authManager.isReady
    );
    const currentEmail = computed(() => auth.user?.email ?? "");

    const googleUpdaterStream = googleUpdater({
      emails,
      auth,
      settings,
      historyId,
      fetching,
    });

    computed(() => {
      if (settings.debugMode) {
        console.log("retrieved emails", emails.get().length);
      }
    });

    // Auto-fetch when auth becomes valid (opt-in feature)
    // Track whether we've already triggered auto-fetch to prevent loops
    const hasAutoFetched = Writable.of(false).for("auto fetched");

    computed(() => {
      const ready = isReady;
      const autoFetch = settings.autoFetchOnAuth;
      const alreadyFetched = hasAutoFetched.get();
      const currentlyFetching = fetching.get();
      const hasEmails = emails.get().length > 0;
      const hasHistoryId = !!historyId.get();

      // Only auto-fetch once when:
      // - Auth is ready
      // - autoFetchOnAuth is enabled
      // - We haven't already auto-fetched this session
      // - Not currently fetching
      // - No emails loaded yet (first load)
      if (
        ready && autoFetch && !alreadyFetched && !currentlyFetching &&
        !hasEmails && !hasHistoryId
      ) {
        if (settings.debugMode) {
          console.log("[GmailImporter] Auto-fetching emails on auth ready");
        }
        hasAutoFetched.set(true);
        // Trigger the fetch handler
        googleUpdaterStream.send({});
      }
    });

    return {
      [NAME]: str`GMail Importer ${currentEmail}`,
      [UI]: (
        <ct-screen>
          <div slot="header">
            <ct-heading level={3}>Gmail Importer</ct-heading>
          </div>

          <ct-vscroll flex showScrollbar>
            <ct-vstack padding="6" gap="4">
              {/* Auth management UI */}
              {authUI}

              <h3 style={{ fontSize: "18px", fontWeight: "bold" }}>
                Imported email count: {computed(() => emails.get().length)}
              </h3>

              <div style={{ fontSize: "14px", color: "#666" }}>
                historyId: {historyId || "none"}
              </div>

              <ct-vstack gap="4">
                <div>
                  <label
                    style={{
                      display: "block",
                      marginBottom: "4px",
                      fontSize: "14px",
                    }}
                  >
                    Import Limit
                  </label>
                  <ct-input
                    type="number"
                    $value={settings.limit}
                    placeholder="count of emails to import"
                  />
                </div>

                <div>
                  <label
                    style={{
                      display: "block",
                      marginBottom: "4px",
                      fontSize: "14px",
                    }}
                  >
                    Gmail Filter Query
                  </label>
                  <ct-input
                    type="text"
                    $value={settings.gmailFilterQuery}
                    placeholder="in:INBOX"
                  />
                </div>

                <div>
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      fontSize: "14px",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={settings.autoFetchOnAuth}
                      onChange={toggleAutoFetch({ settings })}
                    />
                    Auto-fetch on auth (fetch emails automatically when
                    connected)
                  </label>
                </div>

                <div>
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      fontSize: "14px",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={settings.resolveInlineImages}
                      onChange={toggleResolveInlineImages({ settings })}
                    />
                    Resolve inline images (for USPS, etc. - slower)
                  </label>
                </div>

                <div>
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      fontSize: "14px",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={settings.debugMode}
                      onChange={toggleDebugMode({ settings })}
                    />
                    Debug Mode (verbose console logging)
                  </label>
                </div>
                {ifElse(
                  isReady,
                  <ct-button
                    type="button"
                    onClick={googleUpdaterStream}
                    disabled={fetching}
                  >
                    {ifElse(
                      fetching,
                      <span
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                        }}
                      >
                        <ct-loader size="sm" show-elapsed></ct-loader>
                        Fetching...
                      </span>,
                      "Fetch Emails",
                    )}
                  </ct-button>,
                  null,
                )}
              </ct-vstack>

              <div>
                <table>
                  <thead>
                    <tr>
                      <th style={{ padding: "10px" }}>DATE</th>
                      <th style={{ padding: "10px" }}>SUBJECT</th>
                      <th style={{ padding: "10px" }}>LABEL</th>
                      <th style={{ padding: "10px" }}>CONTENT</th>
                    </tr>
                  </thead>
                  <tbody>
                    {emails.map((email) => (
                      <tr>
                        <td
                          style={{ border: "1px solid black", padding: "10px" }}
                        >
                          &nbsp;{email.date}&nbsp;
                        </td>
                        <td
                          style={{ border: "1px solid black", padding: "10px" }}
                        >
                          &nbsp;{email.subject}&nbsp;
                        </td>
                        <td
                          style={{ border: "1px solid black", padding: "10px" }}
                        >
                          &nbsp;{derive(
                            email,
                            (email) => email?.labelIds?.join(", "),
                          )}&nbsp;
                        </td>
                        <td
                          style={{ border: "1px solid black", padding: "10px" }}
                        >
                          <details>
                            <summary>Show Markdown</summary>
                            <pre
                              style={{
                                whiteSpace: "pre-wrap",
                                maxHeight: "300px",
                                overflowY: "auto",
                              }}
                            >
                          {email.markdownContent}
                            </pre>
                          </details>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </ct-vstack>
          </ct-vscroll>
        </ct-screen>
      ),
      authUI,
      emails,
      mentionable: computed(() =>
        emails.map((e) => {
          return {
            ...e,
            [NAME]: e.subject,
            [UI]: (
              <div
                style={{
                  padding: "12px",
                  border: "1px solid #e0e0e0",
                  borderRadius: "8px",
                  backgroundColor: "#fafafa",
                }}
              >
                <div
                  style={{
                    fontSize: "16px",
                    fontWeight: "bold",
                    marginBottom: "4px",
                    color: "#333",
                  }}
                >
                  {e.subject}
                </div>
                <div
                  style={{
                    fontSize: "14px",
                    color: "#666",
                    marginBottom: "8px",
                  }}
                >
                  From: {e.from}
                </div>
                <div
                  style={{
                    fontSize: "14px",
                    color: "#555",
                    lineHeight: "1.4",
                  }}
                >
                  {e.snippet}
                </div>
              </div>
            ),
          } as Email;
        })
      ),
      emailCount: derive(emails, (list: Email[]) => list?.length || 0),
      bgUpdater: googleUpdaterStream,
      isReady,
      // Pattern tools for omnibot
      searchEmails: patternTool(
        ({ query, emails }: { query: string; emails: Email[] }) => {
          return derive({ query, emails }, ({ query, emails }) => {
            if (!query || !emails) return [];
            const lowerQuery = query.toLowerCase();
            return emails.filter((email) =>
              email.subject?.toLowerCase().includes(lowerQuery) ||
              email.from?.toLowerCase().includes(lowerQuery) ||
              email.snippet?.toLowerCase().includes(lowerQuery)
            );
          });
        },
        { emails },
      ),
      getEmailCount: patternTool(
        ({ emails }: { emails: Email[] }) => {
          return derive(emails, (list: Email[]) => list?.length || 0);
        },
        { emails },
      ),
      getRecentEmails: patternTool(
        ({ count, emails }: { count: number; emails: Email[] }) => {
          return derive({ count, emails }, ({ count, emails }) => {
            if (!emails || emails.length === 0) return "No emails";
            const recent = emails.slice(0, count || 5);
            return recent.map((email) =>
              `From: ${email.from}\nSubject: ${email.subject}\nDate: ${
                new Date(email.date).toLocaleDateString()
              }`
            ).join("\n\n");
          });
        },
        { emails },
      ),
    };
  },
);
