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
 *   linkedAuth,
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
 *   linkedAuth,
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
  Stream,
  Writable,
} from "commontools";
import GmailImporter, { type Auth, type Email } from "./gmail-importer.tsx";
import ProcessingStatus from "./processing-status.tsx";
import { GmailSendClient } from "./util/gmail-send-client.ts";

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

  /** LLM model to use for extraction */
  model?: Default<string, "anthropic:claude-sonnet-4-5">;

  /** Optional linked auth (overrides wish() default) */
  linkedAuth?: Auth;
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
export interface GmailExtractorOutput<T = unknown> {
  /** Raw emails from Gmail */
  emails: Email[];
  /** Count of emails fetched */
  emailCount: number;
  /** Analysis results (empty when extraction not provided) */
  rawAnalyses: Array<{
    email: Email;
    emailId: string;
    emailDate: string;
    analysis: { pending?: boolean; result?: T; error?: unknown };
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
  /** Archive a message (remove INBOX label) */
  archive: Stream<{ messageId: string }>;

  /** UI bundle (JSX elements) */
  ui: {
    authStatusUI: unknown;
    connectionStatusUI: unknown;
    analysisProgressUI: unknown;
    previewUI: unknown;
  };

  /** Access to underlying GmailImporter (for advanced use) */
  gmailImporter: ReturnType<typeof GmailImporter>;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Interpolate a template string with email field values.
 * Supports {{email.field}} placeholders.
 */
function interpolateTemplate(template: string, email: Email): string {
  return template
    .replace(/\{\{email\.subject\}\}/g, email.subject || "")
    .replace(/\{\{email\.date\}\}/g, email.date || "")
    .replace(/\{\{email\.from\}\}/g, email.from || "")
    .replace(/\{\{email\.to\}\}/g, email.to || "")
    .replace(/\{\{email\.snippet\}\}/g, email.snippet || "")
    .replace(/\{\{email\.markdownContent\}\}/g, email.markdownContent || "")
    .replace(/\{\{email\.plainText\}\}/g, email.plainText || "")
    .replace(/\{\{email\.htmlContent\}\}/g, email.htmlContent || "");
}

/**
 * Helper to track progress of analyses for custom analysis patterns.
 * Provides consistent pendingCount/completedCount across all patterns.
 *
 * Usage:
 * ```tsx
 * const customAnalyses = extractor.emails.map((email) => {
 *   const analysis = generateObject({ ... });
 *   return { email, analysis };
 * });
 * const { pendingCount, completedCount } = trackAnalyses(customAnalyses);
 * ```
 */
export function trackAnalyses<T>(analyses: AnalysisItem<T>[]) {
  const pendingCount = computed(
    () => analyses?.filter((a) => a?.analysis?.pending)?.length || 0,
  );
  const completedCount = computed(
    () =>
      analyses?.filter(
        (a) =>
          a?.analysis?.pending === false && a?.analysis?.result !== undefined,
      ).length || 0,
  );
  return { pendingCount, completedCount };
}

// =============================================================================
// HANDLERS FOR WRITE OPERATIONS
// =============================================================================

/**
 * Handler to add labels to a message.
 */
const addLabelsHandler = handler<
  { messageId: string; labels: string[] },
  { auth: Writable<Auth> }
>(async ({ messageId, labels }, { auth }) => {
  const client = new GmailSendClient(auth, { debugMode: false });
  await client.modifyLabels(messageId, { addLabelIds: labels });
});

/**
 * Handler to remove labels from a message.
 */
const removeLabelsHandler = handler<
  { messageId: string; labels: string[] },
  { auth: Writable<Auth> }
>(async ({ messageId, labels }, { auth }) => {
  const client = new GmailSendClient(auth, { debugMode: false });
  await client.modifyLabels(messageId, { removeLabelIds: labels });
});

/**
 * Handler to archive a message (remove INBOX label).
 */
const archiveHandler = handler<{ messageId: string }, { auth: Writable<Auth> }>(
  async ({ messageId }, { auth }) => {
    const client = new GmailSendClient(auth, { debugMode: false });
    await client.modifyLabels(messageId, { removeLabelIds: ["INBOX"] });
  },
);

// =============================================================================
// BUILDING BLOCK
// =============================================================================

/**
 * GmailExtractor Building Block
 *
 * Encapsulates the common email→LLM→items pipeline for Gmail-based patterns.
 *
 * @typeParam T - The shape of extracted items (must match extraction.schema)
 */
function GmailExtractor<T = unknown>(input: GmailExtractorInput) {
  const {
    gmailQuery,
    extraction,
    title,
    resolveInlineImages,
    limit,
    // Note: model input is currently ignored - using hardcoded value to fix HTTP 400 errors
    // when passing variables through building block input
    linkedAuth,
  } = input;

  // Instantiate Gmail Importer with the provided settings
  const gmailImporter = GmailImporter({
    settings: {
      gmailFilterQuery: gmailQuery || "in:INBOX",
      autoFetchOnAuth: true,
      resolveInlineImages: resolveInlineImages ?? false,
      limit: limit ?? 100,
      debugMode: false,
    },
    linkedAuth,
  });

  // Get emails from the importer
  const emails = gmailImporter.emails;
  const emailCount = computed(() => emails?.length || 0);

  // Check connection status
  const isConnected = computed(() => {
    if (linkedAuth?.token) return true;
    return gmailImporter?.emailCount !== undefined;
  });

  // Auto-detect whether to run analysis based on presence of extraction config
  const shouldRunAnalysis = computed(() => {
    return !!(extraction?.promptTemplate?.trim() && extraction?.schema);
  });

  // Reactive LLM analysis - analyze each email (only if extraction is provided)
  // Note: consumers access result via item.analysis.result (not item.result)
  // Result type is inferred from extraction.schema by the runtime
  const rawAnalyses = shouldRunAnalysis
    ? emails.map((email: Email) => {
      const analysis = generateObject({
        prompt: computed(() => {
          if (!email?.markdownContent) {
            return undefined;
          }

          const template = extraction?.promptTemplate || "";
          if (!template) {
            return undefined;
          }

          return interpolateTemplate(template, email);
        }),
        schema: extraction?.schema as JSONSchema,
        model: "anthropic:claude-sonnet-4-5",
      });

      return {
        email,
        emailId: email.id,
        emailDate: email.date,
        analysis,
        pending: analysis.pending,
        error: analysis.error,
      };
    })
    : ([] as Array<{
      email: Email;
      emailId: string;
      emailDate: string;
      analysis: { pending?: boolean; result?: T; error?: unknown };
      pending: boolean;
      error: unknown;
    }>);

  // Compute pending/completed counts directly (rawAnalyses is a reactive mapped array)
  const pendingCount = computed(
    () => rawAnalyses?.filter((a) => a?.analysis?.pending)?.length || 0,
  );
  const completedCount = computed(
    () =>
      rawAnalyses?.filter(
        (a) =>
          a?.analysis?.pending === false && a?.analysis?.result !== undefined,
      ).length || 0,
  );

  // Create a Writable reference to auth for handlers
  // Note: linkedAuth may be readonly, so we wrap it in Writable.of and update reactively
  const authForHandlers = Writable.of<Auth | null>(null);
  computed(() => {
    if (linkedAuth?.token) {
      authForHandlers.set(linkedAuth as any);
    }
  });

  // UI Components

  // Auth status UI (from Gmail importer)
  const authStatusUI = gmailImporter.authUI;

  // Connection status UI
  const connectionStatusUI = (
    <div
      style={{
        padding: "12px 16px",
        backgroundColor: computed(() => (isConnected ? "#d1fae5" : "#fef3c7")),
        borderRadius: "8px",
        border: computed(() =>
          isConnected ? "1px solid #10b981" : "1px solid #f59e0b"
        ),
        display: computed(() => (isConnected ? "block" : "none")),
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
          {computed(() => emailCount)} emails found
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
  const analysisProgressUI = (
    <div
      style={{
        padding: "12px 16px",
        backgroundColor: "#eff6ff",
        borderRadius: "8px",
        border: "1px solid #3b82f6",
        display: computed(() =>
          isConnected && shouldRunAnalysis ? "block" : "none"
        ),
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
        <span>{computed(() => emailCount)} emails</span>
        <div
          style={{
            display: computed(() => (pendingCount > 0 ? "flex" : "none")),
            alignItems: "center",
            gap: "4px",
            color: "#2563eb",
          }}
        >
          <ct-loader size="sm" />
          <span>{computed(() => pendingCount)} analyzing...</span>
        </div>
        <span style={{ color: "#059669" }}>
          {computed(() => completedCount)} completed
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
        {computed(() => completedCount)}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: "600", fontSize: "14px" }}>
          {title || "Email Items"}
        </div>
        <div style={{ fontSize: "12px", color: "#6b7280" }}>
          {computed(() => emailCount)} emails
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
    addLabels: addLabelsHandler({ auth: authForHandlers as any }),
    removeLabels: removeLabelsHandler({ auth: authForHandlers as any }),
    archive: archiveHandler({ auth: authForHandlers as any }),
  };
}

// Export the building block as default
export default GmailExtractor;

// Also export the helper function for advanced use cases
export { interpolateTemplate };
