/// <cts-enable />
/**
 * GmailExtractor Building Block
 *
 * A reusable building block that encapsulates the common email-to-structured-items
 * pipeline used across Gmail-based patterns like bill trackers, library trackers, etc.
 *
 * Pipeline:
 * 1. GmailImporter embedding - instantiate with settings
 * 2. Email filtering - filter by sender domain (via Gmail query)
 * 3. LLM extraction - generateObject with schema over emails via .map()
 * 4. Progress tracking - pendingCount, completedCount
 * 5. Deduplication - composite key function using dedupFields
 * 6. UI components - auth, connection status, progress
 *
 * Usage:
 * ```tsx
 * const extractor = GmailExtractor<MyItemType>({
 *   gmailQuery: "from:DoNotReply@billpay.pge.com",
 *   extractionSchema: MY_SCHEMA,
 *   extractionPromptTemplate: "Analyze this email... {{email.markdownContent}}",
 *   dedupFields: ["accountId", "dueDate"],
 *   title: "My Items",
 *   linkedAuth,
 * });
 *
 * // Use extractor.items (deduped), extractor.emails (raw), extractor.ui.* for UI pieces
 * ```
 */
import { computed, Default, generateObject, JSONSchema } from "commontools";
import GmailImporter, { type Auth, type Email } from "./gmail-importer.tsx";
import ProcessingStatus from "./processing-status.tsx";

// Re-export Email type for consumers
export type { Email } from "./gmail-importer.tsx";

// =============================================================================
// TYPES
// =============================================================================

/**
 * Input configuration for the GmailExtractor building block.
 */
export interface GmailExtractorInput<T> {
  /** Gmail search query (e.g., "from:DoNotReply@billpay.pge.com") */
  gmailQuery: string;

  /**
   * JSON Schema for the extraction result.
   * The LLM will generate objects conforming to this schema.
   */
  extractionSchema: JSONSchema;

  /**
   * Prompt template for the LLM extraction.
   * Supports placeholders:
   * - {{email.subject}} - Email subject line
   * - {{email.date}} - Email date
   * - {{email.from}} - Sender email
   * - {{email.markdownContent}} - Full email content as markdown
   * - {{email.snippet}} - Brief preview
   */
  extractionPromptTemplate: Default<string, "">;

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

// Note: The actual output types are inferred by TypeScript from the function return.
// Pattern outputs are wrapped in reactive OpaqueCell types by the runtime.
// Consumers access rawAnalyses and do their own domain-specific filtering/deduplication.

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

// =============================================================================
// BUILDING BLOCK
// =============================================================================

/**
 * GmailExtractor Building Block
 *
 * Encapsulates the common email→LLM→items pipeline for Gmail-based patterns.
 *
 * @typeParam T - The shape of extracted items (must match extractionSchema)
 */
function GmailExtractor<T>(input: GmailExtractorInput<T>) {
  const {
    gmailQuery,
    extractionSchema,
    extractionPromptTemplate,
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

  // Reactive LLM analysis - analyze each email
  // Note: consumers access result via item.analysis.result (not item.result)
  // Result type is inferred from extractionSchema by the runtime
  const rawAnalyses = emails.map((email: Email) => {
    const analysis = generateObject({
      prompt: computed(() => {
        if (!email?.markdownContent) {
          return undefined;
        }

        const template = extractionPromptTemplate || "";
        if (!template) {
          return undefined;
        }

        return interpolateTemplate(template, email);
      }),
      schema: extractionSchema,
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
  });

  // Count pending analyses
  const pendingCount = computed(
    () => rawAnalyses?.filter((a) => a?.pending)?.length || 0,
  );

  // Count completed analyses
  const completedCount = computed(
    () =>
      rawAnalyses?.filter((a) =>
        a?.analysis?.pending === false && a?.analysis?.result !== undefined
      ).length || 0,
  );

  // UI Components

  // Auth status UI (from Gmail importer)
  const authStatusUI = gmailImporter.authUI;

  // Connection status UI
  const connectionStatusUI = (
    <div
      style={{
        padding: "12px 16px",
        backgroundColor: computed(() => isConnected ? "#d1fae5" : "#fef3c7"),
        borderRadius: "8px",
        border: computed(() =>
          isConnected ? "1px solid #10b981" : "1px solid #f59e0b"
        ),
        display: computed(() => isConnected ? "block" : "none"),
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

  // Analysis progress UI
  const analysisProgressUI = (
    <div
      style={{
        padding: "12px 16px",
        backgroundColor: "#eff6ff",
        borderRadius: "8px",
        border: "1px solid #3b82f6",
        display: computed(() => isConnected ? "block" : "none"),
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
            display: computed(() => pendingCount > 0 ? "flex" : "none"),
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
  };
}

// Export the building block as default
export default GmailExtractor;

// Also export the helper function for advanced use cases
export { interpolateTemplate };
