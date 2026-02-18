/// <cts-enable />
/**
 * GmailExtractor Building Block
 *
 * A reusable pattern that encapsulates the common email-to-structured-items
 * pipeline used across Gmail-based patterns like bill trackers, library trackers, etc.
 *
 * Pipeline:
 * 1. GmailImporter embedding - instantiate with settings
 * 2. Email filtering - filter by sender domain (via Gmail query)
 * 3. LLM extraction (optional) - generateObject with schema over emails via .map()
 * 4. Progress tracking - pendingCount, completedCount
 * 5. UI components - auth, connection status, progress
 *
 * ## Content Truncation
 *
 * Email content fields (markdownContent, htmlContent, plainText) are automatically
 * truncated to prevent token limit errors. The limits are:
 * - markdownContent/plainText: 100k chars (~25k tokens)
 * - htmlContent: 50k chars (~12.5k tokens)
 *
 * Base64 image data (data:image/...) embedded in email content is stripped and
 * replaced with [embedded-image] placeholders. For image analysis, use raw mode
 * with the image URLs passed directly to generateObject.
 *
 * ## API Modes
 *
 * **Simple mode (with built-in analysis)**:
 * Provide `extraction` with promptTemplate and schema to enable automatic LLM analysis.
 * ```tsx
 * const extractor = GmailExtractor({
 *   gmailQuery: "from:DoNotReply@billpay.pge.com",
 *   extraction: {
 *     promptTemplate: "Analyze this email... {{email.markdownContent}}",
 *     schema: MY_SCHEMA,
 *   },
 *   title: "My Items",
 *   overrideAuth,
 * });
 * // Use extractor.rawAnalyses, extractor.emails, extractor.ui.* for UI pieces
 * ```
 *
 * **Raw mode (custom analysis)**:
 * Omit `extraction` to get raw emails only. Do your own analysis with `.map()`.
 * ```tsx
 * const extractor = GmailExtractor({
 *   gmailQuery: "from:usps.com",
 *   resolveInlineImages: true,
 *   overrideAuth,
 * });
 *
 * // Custom multimodal analysis
 * const customAnalyses = extractor.emails.map((email) => {
 *   const analysis = generateObject({
 *     prompt: [{ type: "image", image: email.image }, ...],
 *     schema: MY_SCHEMA,
 *   });
 *   return { email, analysis };
 * });
 *
 * // Use trackAnalyses helper for consistent progress tracking
 * const { pendingCount, completedCount } = trackAnalyses(customAnalyses);
 * ```
 */
import {
  computed,
  Default,
  generateObject,
  handler,
  JSONSchema,
  pattern,
  Stream,
} from "commontools";
import GmailImporter, { type Auth, type Email } from "./gmail-importer.tsx";
import ProcessingStatus from "./processing-status.tsx";
import {
  createReadOnlyAuthCell,
  GmailSendClient,
} from "./util/gmail-send-client.ts";

// Re-export Email and Auth types and ProcessingStatus for consumers
export type { Auth, Email } from "./gmail-importer.tsx";
export { default as ProcessingStatus } from "./processing-status.tsx";

// =============================================================================
// TYPES
// =============================================================================

/**
 * Input configuration for the GmailExtractor building block.
 */
export interface GmailExtractorInput {
  /** Gmail search query (e.g., "from:DoNotReply@billpay.pge.com") */
  gmailQuery: string;

  /**
   * Optional: Provide to enable built-in LLM analysis.
   * Omit entirely for raw emails only (for custom analysis patterns).
   */
  extraction?: {
    /**
     * Prompt template for the LLM extraction.
     * Supports placeholders:
     * - {{email.subject}} - Email subject line
     * - {{email.date}} - Email date
     * - {{email.from}} - Sender email
     * - {{email.markdownContent}} - Full email content as markdown
     * - {{email.snippet}} - Brief preview
     */
    promptTemplate: string;
    /**
     * JSON Schema for the extraction result.
     * The LLM will generate objects conforming to this schema.
     */
    schema: JSONSchema;
  };

  /** Display title for the extractor (shown in UI) */
  title?: Default<string, "Email Items">;

  /** Whether to resolve inline images (cid: references) to base64 */
  resolveInlineImages?: Default<boolean, false>;

  /** Maximum number of emails to fetch */
  limit?: Default<number, 100>;

  // Note: model parameter removed - hardcoded to fix HTTP 400 errors
  // when passing variables through building block input.
  // Use hardcoded "anthropic:claude-sonnet-4-5" instead.

  /** Optional linked auth (overrides wish() default) */
  overrideAuth?: Auth;
}

/**
 * Analysis item shape for tracking progress.
 * Used both internally and by custom analysis patterns via trackAnalyses().
 */
export interface AnalysisItem<T = unknown> {
  analysis: { pending?: boolean; result?: T; error?: unknown };
  [key: string]: unknown;
}

/**
 * Output of GmailExtractor.
 */
export interface GmailExtractorOutput {
  /** Raw emails from Gmail */
  emails: Email[];
  /** Count of emails fetched */
  emailCount: number;
  /** Analysis results (empty when extraction not provided) */
  rawAnalyses: Array<{
    email: Email;
    emailId: string;
    emailDate: string;
    analysis: { pending?: boolean; result?: unknown; error?: unknown };
    result?: unknown;
    pending: boolean;
    error: unknown;
  }>;
  /** Count of pending analyses */
  pendingCount: number;
  /** Count of completed analyses */
  completedCount: number;
  /** Whether Gmail is connected */
  isConnected: boolean;

  // Operations (Streams, not functions)
  /** Refresh emails from Gmail */
  refresh: Stream<unknown>;
  /** Add labels to a message */
  addLabels: Stream<{ messageId: string; labels: string[] }>;
  /** Remove labels from a message */
  removeLabels: Stream<{ messageId: string; labels: string[] }>;

  /** UI bundle (JSX elements) */
  ui: {
    authStatusUI: JSX.Element;
    connectionStatusUI: JSX.Element;
    analysisProgressUI: JSX.Element;
    previewUI: JSX.Element;
  };

  /** Access to underlying GmailImporter (for advanced use) */
  gmailImporter: ReturnType<typeof GmailImporter>;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Maximum characters for email content fields to prevent token limit errors.
 *
 * Claude's context window is ~200k tokens. A conservative estimate is ~4 chars per token.
 * We want to leave room for:
 * - System prompt and schema (~2k tokens)
 * - User's prompt template (~1k tokens)
 * - Response generation (~8k tokens)
 *
 * Target: ~180k tokens for content = ~720k chars max.
 * But to be safe with multi-part prompts and overhead, we limit to ~400k chars (~100k tokens).
 *
 * For markdown content specifically, we're more conservative because:
 * - It's the most commonly used field
 * - Large HTML emails convert to verbose markdown
 * - We want individual emails to fit comfortably
 */
const MAX_CONTENT_CHARS = 100_000; // ~25k tokens, safe limit for email body
const MAX_HTML_CONTENT_CHARS = 50_000; // HTML is often more verbose, use smaller limit

/**
 * Truncation suffix to indicate content was cut off.
 */
const TRUNCATION_SUFFIX = "\n\n[Content truncated due to length...]";

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Truncate a string to a maximum length, adding a suffix if truncated.
 * Tries to truncate at a natural boundary (newline or space) if possible.
 */
function truncateContent(
  content: string | undefined,
  maxLength: number,
): string {
  if (!content) return "";
  if (content.length <= maxLength) return content;

  // Find a good break point (newline or space) near the limit
  const targetLength = maxLength - TRUNCATION_SUFFIX.length;
  let breakPoint = targetLength;

  // Look for a newline within the last 500 chars of the target
  const searchStart = Math.max(0, targetLength - 500);
  const lastNewline = content.lastIndexOf("\n", targetLength);
  if (lastNewline > searchStart) {
    breakPoint = lastNewline;
  } else {
    // Fall back to looking for a space
    const lastSpace = content.lastIndexOf(" ", targetLength);
    if (lastSpace > searchStart) {
      breakPoint = lastSpace;
    }
  }

  return content.slice(0, breakPoint) + TRUNCATION_SUFFIX;
}

/**
 * Strip base64 image data from content while preserving structure.
 * Replaces data:image/... URLs with a placeholder.
 * This dramatically reduces token count for emails with embedded images.
 */
function stripBase64Images(content: string | undefined): string {
  if (!content) return "";

  // Match data:image URLs (base64 encoded images)
  // These can be massive - a single image can be 100k+ chars
  return content.replace(
    /data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g,
    "[embedded-image]",
  );
}

/**
 * Interpolate a template string with email field values.
 * Supports {{email.field}} placeholders.
 *
 * Content fields are automatically truncated to prevent token limit errors.
 * Base64 image data is stripped from content fields.
 */
function interpolateTemplate(template: string, email: Email): string {
  // Prepare content fields with truncation and base64 stripping
  const markdownContent = truncateContent(
    stripBase64Images(email.markdownContent),
    MAX_CONTENT_CHARS,
  );
  const plainText = truncateContent(
    stripBase64Images(email.plainText),
    MAX_CONTENT_CHARS,
  );
  const htmlContent = truncateContent(
    stripBase64Images(email.htmlContent),
    MAX_HTML_CONTENT_CHARS,
  );

  return template
    .replace(/\{\{email\.subject\}\}/g, email.subject || "")
    .replace(/\{\{email\.date\}\}/g, email.date || "")
    .replace(/\{\{email\.from\}\}/g, email.from || "")
    .replace(/\{\{email\.to\}\}/g, email.to || "")
    .replace(/\{\{email\.snippet\}\}/g, email.snippet || "")
    .replace(/\{\{email\.markdownContent\}\}/g, markdownContent)
    .replace(/\{\{email\.plainText\}\}/g, plainText)
    .replace(/\{\{email\.htmlContent\}\}/g, htmlContent);
}

/**
 * Count pending analyses in a list.
 * Pure function - callers should wrap in computed() for reactivity.
 */
export function countPending<T>(analyses: AnalysisItem<T>[]): number {
  const len = analyses?.length || 0;
  let count = 0;
  for (let i = 0; i < len; i++) {
    if (analyses[i]?.analysis?.pending) count++;
  }
  return count;
}

/**
 * Count completed analyses in a list.
 * Pure function - callers should wrap in computed() for reactivity.
 */
export function countCompleted<T>(analyses: AnalysisItem<T>[]): number {
  const len = analyses?.length || 0;
  let count = 0;
  for (let i = 0; i < len; i++) {
    const a = analyses[i];
    if (a?.analysis?.pending === false && a?.analysis?.result !== undefined) {
      count++;
    }
  }
  return count;
}

// =============================================================================
// HANDLERS
// =============================================================================

/**
 * Handler to add labels to a message.
 * Requires gmail.modify scope in the auth token.
 */
const addLabelsHandler = handler<
  { messageId: string; labels: string[] },
  { auth?: Auth }
>(async ({ messageId, labels }, { auth }) => {
  if (!auth?.token) {
    console.error("[GmailExtractor] addLabels: No auth token available");
    return;
  }

  // Type assertion needed because handler state provides readonly Auth properties,
  // but createReadOnlyAuthCell expects mutable Auth. Safe because we only read from it.
  const client = new GmailSendClient(createReadOnlyAuthCell(auth as Auth), {
    debugMode: false,
  });

  try {
    await client.modifyLabels(messageId, {
      addLabelIds: labels,
    });
  } catch (error) {
    console.error("[GmailExtractor] addLabels failed:", error);
    throw error;
  }
});

/**
 * Handler to remove labels from a message.
 * Requires gmail.modify scope in the auth token.
 */
const removeLabelsHandler = handler<
  { messageId: string; labels: string[] },
  { auth?: Auth }
>(async ({ messageId, labels }, { auth }) => {
  if (!auth?.token) {
    console.error("[GmailExtractor] removeLabels: No auth token available");
    return;
  }

  // Type assertion needed because handler state provides readonly Auth properties,
  // but createReadOnlyAuthCell expects mutable Auth. Safe because we only read from it.
  const client = new GmailSendClient(createReadOnlyAuthCell(auth as Auth), {
    debugMode: false,
  });

  try {
    await client.modifyLabels(messageId, {
      removeLabelIds: labels,
    });
  } catch (error) {
    console.error("[GmailExtractor] removeLabels failed:", error);
    throw error;
  }
});

// =============================================================================
// BUILDING BLOCK
// =============================================================================

/**
 * GmailExtractor Building Block
 *
 * Encapsulates the common email→LLM→items pipeline for Gmail-based patterns.
 */
const GmailExtractor = pattern<GmailExtractorInput, GmailExtractorOutput>(
  ({
    gmailQuery,
    extraction,
    title,
    resolveInlineImages,
    limit,
    overrideAuth,
  }) => {
    // Instantiate Gmail Importer with the provided settings
    const gmailImporter = GmailImporter({
      settings: {
        gmailFilterQuery: computed(() => gmailQuery || "in:INBOX"),
        autoFetchOnAuth: true,
        resolveInlineImages: computed(() => resolveInlineImages ?? false),
        limit: computed(() => limit ?? 100),
        debugMode: false,
      },
      overrideAuth,
    });

    // Get emails from the importer
    const emails = gmailImporter.emails;
    const emailCount = computed(() => emails?.length || 0);

    // Check connection status using the importer's resolved auth state
    // GmailImporter exposes isReady which checks: ifElse(overrideAuth.token, overrideAuth, wishedAuth).token
    // This properly handles both overrideAuth and wish()-based auth
    const isConnected = gmailImporter.isReady;

    // Auto-detect whether to run analysis based on presence of extraction config
    const shouldRunAnalysis = computed(() =>
      !!(extraction.promptTemplate?.trim() && extraction.schema)
    );

    // Capture extraction config values for use inside .map() callback
    const extractionSchema = extraction.schema;
    const extractionPromptTemplate = extraction.promptTemplate;

    // Reactive LLM analysis - analyze each email (only if extraction is provided)
    // Note: consumers can access result via item.analysis.result or item.result
    // Result type is inferred from extraction.schema by the runtime
    const rawAnalyses = emails.map((email: Email) => {
      const analysis = generateObject({
        prompt: computed(() => {
          if (!shouldRunAnalysis) return undefined;
          if (!email.markdownContent) return undefined;
          const template = extractionPromptTemplate || "";
          if (!template) return undefined;
          return interpolateTemplate(template, email);
        }),
        schema: extractionSchema as JSONSchema,
        model: "anthropic:claude-sonnet-4-5",
      });

      return {
        email,
        emailId: email.id,
        emailDate: email.date,
        analysis,
        result: analysis.result,
        pending: analysis.pending,
        error: analysis.error,
      };
    });

    // Compute pending/completed counts using index access (rawAnalyses from .map()
    // is a reactive mapped array that doesn't support .filter() directly)
    const pendingCount = computed(() => {
      if (!shouldRunAnalysis) return 0;
      const len = rawAnalyses?.length || 0;
      let count = 0;
      for (let i = 0; i < len; i++) {
        if (rawAnalyses[i]?.analysis?.pending) count++;
      }
      return count;
    });
    const completedCount = computed(() => {
      if (!shouldRunAnalysis) return 0;
      const len = rawAnalyses?.length || 0;
      let count = 0;
      for (let i = 0; i < len; i++) {
        const a = rawAnalyses[i];
        if (
          a?.analysis?.pending === false && a?.analysis?.result !== undefined
        ) {
          count++;
        }
      }
      return count;
    });

    // Note: Handler operations removed - they were unused and the authForHandlers wrapper
    // was an anti-pattern (Writable.of + computed side effect).
    // GmailImporter already handles auth via wish() when overrideAuth isn't provided.
    // If write operations are needed in the future, pass overrideAuth directly to handlers.

    // UI Components

    // Auth status UI (from Gmail importer)
    const authStatusUI = gmailImporter.authUI;

    // Connection status UI
    // Pre-compute reactive values outside JSX to avoid computed() in style attributes
    const connectedBgColor = computed(
      () => (isConnected ? "#d1fae5" : "#fef3c7"),
    );
    const connectedBorder = computed(() =>
      isConnected ? "1px solid #10b981" : "1px solid #f59e0b"
    );
    const connectedDisplay = computed(() => (isConnected ? "block" : "none"));

    const connectionStatusUI = (
      <div
        style={{
          padding: "12px 16px",
          backgroundColor: connectedBgColor,
          borderRadius: "8px",
          border: connectedBorder,
          display: connectedDisplay,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <span
            style={{
              width: "10px",
              height: "10px",
              borderRadius: "50%",
              backgroundColor: "#10b981",
            }}
          />
          <span>Connected to Gmail</span>
          <span style={{ marginLeft: "auto", color: "#059669" }}>
            {emailCount} emails found
          </span>
          <button
            type="button"
            onClick={gmailImporter.bgUpdater}
            style={{
              marginLeft: "8px",
              padding: "6px 12px",
              backgroundColor: "#10b981",
              color: "white",
              border: "none",
              borderRadius: "6px",
              cursor: "pointer",
              fontSize: "13px",
              fontWeight: "500",
            }}
          >
            Fetch Emails
          </button>
        </div>
      </div>
    );

    // Analysis progress UI (only shown when extraction is enabled)
    // Pre-compute reactive values outside JSX
    const analysisDisplay = computed(() =>
      isConnected && shouldRunAnalysis ? "block" : "none"
    );
    const pendingDisplay = computed(() => (pendingCount > 0 ? "flex" : "none"));

    const analysisProgressUI = (
      <div
        style={{
          padding: "12px 16px",
          backgroundColor: "#eff6ff",
          borderRadius: "8px",
          border: "1px solid #3b82f6",
          display: analysisDisplay,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "12px",
          }}
        >
          <span style={{ fontWeight: "600" }}>Analysis:</span>
          <span>{emailCount} emails</span>
          <div
            style={{
              display: pendingDisplay,
              alignItems: "center",
              gap: "4px",
              color: "#2563eb",
            }}
          >
            <ct-loader size="sm" />
            <span>{pendingCount} analyzing...</span>
          </div>
          <span style={{ color: "#059669" }}>
            {completedCount} completed
          </span>
        </div>
      </div>
    );

    // Preview UI for card displays
    const previewUI = (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "12px",
          padding: "8px 12px",
        }}
      >
        <div
          style={{
            width: "36px",
            height: "36px",
            borderRadius: "8px",
            backgroundColor: "#eff6ff",
            border: "2px solid #3b82f6",
            color: "#1d4ed8",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: "bold",
            fontSize: "16px",
          }}
        >
          {completedCount}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: "600", fontSize: "14px" }}>
            {title || "Email Items"}
          </div>
          <div style={{ fontSize: "12px", color: "#6b7280" }}>
            {emailCount} emails
          </div>
          <ProcessingStatus
            totalCount={emailCount}
            pendingCount={pendingCount}
            completedCount={completedCount}
          />
        </div>
      </div>
    );

    return {
      emails,
      emailCount,
      rawAnalyses,
      pendingCount,
      completedCount,
      isConnected,
      ui: {
        authStatusUI,
        connectionStatusUI,
        analysisProgressUI,
        previewUI,
      },
      gmailImporter,
      refresh: gmailImporter.bgUpdater,
      addLabels: addLabelsHandler({ auth: overrideAuth }),
      removeLabels: removeLabelsHandler({ auth: overrideAuth }),
    };
  },
);

// Export the building block as default
export default GmailExtractor;

// Also export the helper function for advanced use cases
export { interpolateTemplate };
