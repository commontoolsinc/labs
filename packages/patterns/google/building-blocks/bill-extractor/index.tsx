/// <cts-enable />
/**
 * BillExtractor Building Block
 *
 * A higher-level building block that wraps GmailExtractor to provide
 * the complete bill tracking data pipeline. Patterns use this for data
 * processing and provide their own UI rendering.
 *
 * ## Key Features
 *
 * - Standardized extraction schema (BILL_EXTRACTION_SCHEMA)
 * - Automatic payment confirmation tracking
 * - "Likely paid" heuristic for old bills
 * - Manual mark/unmark paid handlers
 * - Simple UI components (stats, alerts, demo toggle)
 *
 * ## Usage
 *
 * ```tsx
 * import BillExtractor, {
 *   formatCurrency,
 *   formatDate,
 *   formatIdentifier,
 *   getIdentifierColor,
 *   createMarkAsPaidHandler,
 *   createUnmarkAsPaidHandler,
 * } from "../building-blocks/bill-extractor/index.tsx";
 *
 * export default pattern(({ overrideAuth, manuallyPaid, demoMode }) => {
 *   const tracker = BillExtractor({
 *     gmailQuery: "from:alerts@bank.com",
 *     extractionPrompt: `Analyze this email...`,
 *     identifierType: "card",
 *     title: "My Bank Bill Tracker",
 *     shortName: "MyBank",
 *     brandColor: "#ff0000",
 *     websiteUrl: "https://bank.com",
 *     overrideAuth,
 *     manuallyPaid,
 *     demoMode,
 *   });
 *
 *   // Get handlers for use in UI
 *   const markAsPaid = createMarkAsPaidHandler();
 *   const unmarkAsPaid = createUnmarkAsPaidHandler();
 *
 *   return {
 *     [NAME]: "My Bill Tracker",
 *     bills: tracker.bills,
 *     [UI]: (
 *       <ct-screen>
 *         {tracker.ui.summaryStatsUI}
 *         {tracker.unpaidBills.map((bill) => (
 *           <div>
 *             {formatCurrency(bill.amount)}
 *             <button onClick={markAsPaid({ paidKeys: manuallyPaid, bill })}>
 *               Mark Paid
 *             </button>
 *           </div>
 *         ))}
 *       </ct-screen>
 *     ),
 *   };
 * });
 * ```
 */
import { computed, Default, handler, Stream, Writable } from "commontools";
import GmailExtractor from "../gmail-extractor.tsx";
import type { Auth } from "../gmail-extractor.tsx";
import ProcessingStatus from "../processing-status.tsx";
import {
  BILL_EXTRACTION_SCHEMA,
  type BillAnalysis,
  type BillStatus,
  type TrackedBill,
} from "./types.ts";
import {
  calculateDaysUntilDue,
  createBillKey,
  demoPrice,
  formatCurrency,
  LIKELY_PAID_THRESHOLD_DAYS,
  parseDateToMs,
} from "./helpers.ts";

// Re-export types and schema for consumers
export { BILL_EXTRACTION_SCHEMA } from "./types.ts";
export type { BillAnalysis, BillStatus, TrackedBill } from "./types.ts";
export type { Auth } from "../gmail-extractor.tsx";

// Re-export helpers for use in pattern UI
export {
  formatCurrency,
  formatDate,
  formatIdentifier,
  getIdentifierColor,
  IDENTIFIER_COLORS,
} from "./helpers.ts";

// =============================================================================
// INPUT/OUTPUT TYPES
// =============================================================================

/**
 * Input configuration for BillExtractor.
 */
export interface BillExtractorInput {
  /** Gmail search query (e.g., "from:alerts@bankofamerica.com") */
  gmailQuery: string;

  /**
   * Extraction prompt with {{email.*}} placeholders.
   * Must instruct LLM what to extract for the "identifier" field.
   */
  extractionPrompt: string;

  /**
   * Display format for identifier:
   * - "card": "...1234"
   * - "account": "Acct: 1234"
   */
  identifierType: "card" | "account";

  /** Full title for header (e.g., "Bank of America Bill Tracker") */
  title: string;

  /** Short name for compact displays (e.g., "BofA") */
  shortName: string;

  /** Brand color for website button (hex) */
  brandColor?: Default<string, "#3b82f6">;

  /** Provider website URL */
  websiteUrl?: string;

  /** Gmail auth (optional - uses wish() if not provided) */
  overrideAuth?: Auth;

  /** State for persistence - which bills user manually marked as paid */
  manuallyPaid?: Writable<Default<string[], []>>;

  /** Whether to show fake amounts for privacy (demo mode) */
  demoMode?: Writable<Default<boolean, true>>;

  /** Maximum number of emails to fetch */
  limit?: Default<number, 100>;

  /**
   * Whether this provider sends payment confirmation emails.
   * When false, shows a banner explaining manual tracking is required.
   * Defaults to true.
   */
  supportsAutoDetect?: Default<boolean, true>;
}

/**
 * Output from BillExtractor.
 */
export interface BillExtractorOutput {
  // Pre-computed data (WARNING: these are building-block scope - don't use in .map() closures with pattern vars)
  bills: TrackedBill[];
  unpaidBills: TrackedBill[];
  paidBills: TrackedBill[];
  likelyPaidBills: TrackedBill[];
  totalUnpaid: number;
  overdueCount: number;

  // Raw data for pattern-scope processing (use with processBills() in pattern computed)
  rawAnalyses: Array<{
    emailId: string;
    emailDate: string;
    analysis?: { result?: BillAnalysis };
  }>;
  paymentConfirmations: Record<string, string[]>;

  // Config (pass-through for patterns to use in UI)
  identifierType: "card" | "account";
  title: string;
  shortName: string;
  brandColor: string;
  websiteUrl?: string;
  supportsAutoDetect: boolean;

  // Status
  pendingCount: number;
  completedCount: number;
  emailCount: number;
  isConnected: boolean;

  // Operations
  refresh: Stream<unknown>;

  // UI (simple components only - no list iteration)
  ui: {
    authStatusUI: JSX.Element;
    connectionStatusUI: JSX.Element;
    analysisProgressUI: JSX.Element;
    previewUI: JSX.Element;
    summaryStatsUI: JSX.Element;
    overdueAlertUI: JSX.Element;
    websiteLinkUI: JSX.Element | null;
    /** Banner shown when supportsAutoDetect is false */
    manualTrackingBannerUI: JSX.Element | null;
  };

  // Access to underlying GmailExtractor (for advanced use)
  gmailExtractor: ReturnType<typeof GmailExtractor>;
}

// =============================================================================
// HANDLERS (exported for pattern use)
// =============================================================================

/**
 * Create a handler for marking a bill as paid.
 * Use this in patterns to wire up "Mark Paid" buttons.
 */
export const createMarkAsPaidHandler = () =>
  handler<void, { paidKeys: Writable<string[]>; bill: TrackedBill }>(
    (_event, { paidKeys, bill }) => {
      const current = paidKeys.get() || [];
      const key = bill.key;
      if (key && !current.includes(key)) {
        paidKeys.set([...current, key]);
      }
    },
  );

/**
 * Create a handler for unmarking a bill as paid.
 * Use this in patterns to wire up "Undo" buttons.
 */
export const createUnmarkAsPaidHandler = () =>
  handler<void, { paidKeys: Writable<string[]>; bill: TrackedBill }>(
    (_event, { paidKeys, bill }) => {
      const current = paidKeys.get() || [];
      const key = bill.key;
      paidKeys.set(current.filter((k: string) => k !== key));
    },
  );

// =============================================================================
// BILL PROCESSING (exported for pattern-scope computed)
// =============================================================================

/**
 * Process raw analyses into a bills array.
 * Call this inside a pattern-scope computed() to avoid closure issues.
 */
export function processBills(
  rawAnalyses: ReadonlyArray<{
    emailId: string;
    emailDate: string;
    analysis?: { result?: BillAnalysis };
  }>,
  paymentConfirmations: Readonly<Record<string, readonly string[]>>,
  manuallyPaidKeys: readonly string[],
  isDemoMode: boolean,
): TrackedBill[] {
  const billMap: Record<string, TrackedBill> = {};
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const sortedAnalyses = [...(rawAnalyses || [])]
    .filter((a) => a?.analysis?.result)
    .sort((a, b) => {
      const dateA = new Date(a.emailDate || 0).getTime();
      const dateB = new Date(b.emailDate || 0).getTime();
      if (dateB !== dateA) return dateB - dateA;
      return (a.emailId || "").localeCompare(b.emailId || "");
    });

  for (const analysisItem of sortedAnalyses) {
    const result = analysisItem.analysis?.result;
    if (!result) continue;

    const isBillEmail = result.emailType === "bill_due" ||
      result.emailType === "payment_reminder";
    const isStatementWithBillInfo = result.emailType === "statement_ready" &&
      result.dueDate &&
      (result.amount || result.statementBalance);

    if (!isBillEmail && !isStatementWithBillInfo) continue;
    if (!result.identifier || !result.dueDate) continue;

    const billAmount = result.amount || result.statementBalance || 0;
    const key = createBillKey(result.identifier, result.dueDate);
    if (billMap[key]) continue;

    const daysUntilDue = calculateDaysUntilDue(result.dueDate, today);
    const isManuallyPaid = manuallyPaidKeys.includes(key);

    const idPayments = paymentConfirmations[result.identifier] || [];
    const dueDateMs = parseDateToMs(result.dueDate);
    const matchingPayment = idPayments.find((paymentDate) => {
      const paymentMs = parseDateToMs(paymentDate);
      if (isNaN(dueDateMs) || isNaN(paymentMs)) return false;
      const daysDiff = (paymentMs - dueDateMs) / (1000 * 60 * 60 * 24);
      return daysDiff >= -30 && daysDiff <= 60;
    });

    const autoPaid = !!matchingPayment;
    const isLikelyPaid = !isManuallyPaid &&
      !autoPaid &&
      daysUntilDue < LIKELY_PAID_THRESHOLD_DAYS;
    const isPaid = isManuallyPaid || autoPaid || isLikelyPaid;

    let status: BillStatus;
    if (isLikelyPaid) status = "likely_paid";
    else if (isPaid) status = "paid";
    else if (daysUntilDue < 0) status = "overdue";
    else status = "unpaid";

    billMap[key] = {
      key,
      identifier: result.identifier,
      amount: demoPrice(billAmount, isDemoMode),
      dueDate: result.dueDate,
      status,
      isPaid,
      paidDate: matchingPayment || undefined,
      emailDate: analysisItem.emailDate,
      emailId: analysisItem.emailId,
      isManuallyPaid,
      isLikelyPaid,
      daysUntilDue,
    };
  }

  return Object.values(billMap).sort(
    (a, b) => a.daysUntilDue - b.daysUntilDue,
  );
}

// =============================================================================
// BUILDING BLOCK
// =============================================================================

/**
 * BillExtractor Building Block
 *
 * Wraps GmailExtractor and provides the complete bill tracking data pipeline.
 * Patterns use this for data processing and provide their own UI rendering
 * for list iteration (which must be at pattern scope for reactive context).
 */
function BillExtractor(input: BillExtractorInput): BillExtractorOutput {
  const {
    gmailQuery,
    extractionPrompt,
    identifierType,
    title,
    shortName,
    brandColor,
    websiteUrl,
    overrideAuth,
    manuallyPaid,
    demoMode,
    limit,
    supportsAutoDetect,
  } = input;

  const resolvedBrandColor = brandColor ?? "#3b82f6";
  const resolvedSupportsAutoDetect = supportsAutoDetect ?? true;

  // Use GmailExtractor building block for email fetching and LLM extraction
  const extractor = GmailExtractor<BillAnalysis>({
    gmailQuery,
    extraction: {
      schema: BILL_EXTRACTION_SCHEMA,
      promptTemplate: extractionPrompt,
    },
    title: `${shortName} Emails`,
    resolveInlineImages: false,
    limit: limit ?? 100,
    overrideAuth,
  });

  // Extract payment confirmations for auto-marking bills as paid
  const paymentConfirmations = computed(() => {
    const confirmations: Record<string, Set<string>> = {};

    for (const item of extractor.rawAnalyses || []) {
      const result = item.analysis?.result;
      if (!result) continue;

      if (
        result.emailType === "payment_received" &&
        result.identifier &&
        result.paymentDate
      ) {
        const key = result.identifier;
        if (!confirmations[key]) confirmations[key] = new Set();
        confirmations[key].add(result.paymentDate);
      }
    }

    const sortedResult: Record<string, string[]> = {};
    for (const idKey of Object.keys(confirmations).sort()) {
      sortedResult[idKey] = [...confirmations[idKey]].sort((a, b) =>
        a.localeCompare(b)
      );
    }
    return sortedResult;
  });

  // Process analyses and build bill list with domain-specific logic
  const bills = computed(() => {
    const billMap: Record<string, TrackedBill> = {};
    // Use .get() to access Writable values inside computed
    const paidKeys = manuallyPaid?.get() || [];
    const payments = paymentConfirmations || {};
    const isDemoMode = demoMode?.get() ?? true;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const sortedAnalyses = [...(extractor.rawAnalyses || [])]
      .filter((a) => a?.analysis?.result)
      .sort((a, b) => {
        const dateA = new Date(a.emailDate || 0).getTime();
        const dateB = new Date(b.emailDate || 0).getTime();
        if (dateB !== dateA) return dateB - dateA;
        return (a.emailId || "").localeCompare(b.emailId || "");
      });

    for (const analysisItem of sortedAnalyses) {
      const result = analysisItem.analysis?.result;
      if (!result) continue;

      const isBillEmail = result.emailType === "bill_due" ||
        result.emailType === "payment_reminder";
      const isStatementWithBillInfo = result.emailType === "statement_ready" &&
        result.dueDate &&
        (result.amount || result.statementBalance);

      if (!isBillEmail && !isStatementWithBillInfo) continue;
      if (!result.identifier || !result.dueDate) continue;

      const billAmount = result.amount || result.statementBalance || 0;
      const key = createBillKey(result.identifier, result.dueDate);
      if (billMap[key]) continue;

      const daysUntilDue = calculateDaysUntilDue(result.dueDate, today);
      const isManuallyPaid = paidKeys.includes(key);

      const idPayments = payments[result.identifier] || [];
      const dueDateMs = parseDateToMs(result.dueDate);
      const matchingPayment = idPayments.find((paymentDate) => {
        const paymentMs = parseDateToMs(paymentDate);
        if (isNaN(dueDateMs) || isNaN(paymentMs)) return false;
        const daysDiff = (paymentMs - dueDateMs) / (1000 * 60 * 60 * 24);
        return daysDiff >= -30 && daysDiff <= 60;
      });

      const autoPaid = !!matchingPayment;
      const isLikelyPaid = !isManuallyPaid &&
        !autoPaid &&
        daysUntilDue < LIKELY_PAID_THRESHOLD_DAYS;
      const isPaid = isManuallyPaid || autoPaid || isLikelyPaid;

      let status: BillStatus;
      if (isLikelyPaid) status = "likely_paid";
      else if (isPaid) status = "paid";
      else if (daysUntilDue < 0) status = "overdue";
      else status = "unpaid";

      billMap[key] = {
        key,
        identifier: result.identifier,
        amount: demoPrice(billAmount, isDemoMode),
        dueDate: result.dueDate,
        status,
        isPaid,
        paidDate: matchingPayment || undefined,
        emailDate: analysisItem.emailDate,
        emailId: analysisItem.emailId,
        isManuallyPaid,
        isLikelyPaid,
        daysUntilDue,
      };
    }

    return Object.values(billMap).sort(
      (a, b) => a.daysUntilDue - b.daysUntilDue,
    );
  });

  // Filtered lists
  const unpaidBills = computed(() =>
    bills.filter((bill) => !bill.isPaid && !bill.isLikelyPaid)
  );
  const likelyPaidBills = computed(() =>
    bills
      .filter((bill) => bill.isLikelyPaid)
      .sort((a, b) => b.dueDate.localeCompare(a.dueDate))
  );
  const paidBills = computed(() =>
    bills
      .filter((bill) => bill.isPaid && !bill.isLikelyPaid)
      .sort((a, b) => b.dueDate.localeCompare(a.dueDate))
  );
  const totalUnpaid = computed(() =>
    unpaidBills.reduce((sum, bill) => sum + bill.amount, 0)
  );
  const overdueCount = computed(() =>
    unpaidBills.filter((bill) => bill.daysUntilDue < 0).length
  );

  // ==========================================================================
  // SIMPLE UI COMPONENTS (no list iteration)
  // ==========================================================================

  // Preview UI for compact display (cards, etc.)
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
          backgroundColor: computed(() =>
            overdueCount > 0 ? "#fee2e2" : "#eff6ff"
          ),
          border: computed(() =>
            overdueCount > 0 ? "2px solid #ef4444" : "2px solid #3b82f6"
          ),
          color: computed(() => (overdueCount > 0 ? "#b91c1c" : "#1d4ed8")),
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontWeight: "bold",
          fontSize: "16px",
        }}
      >
        {computed(() => unpaidBills?.length || 0)}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: "600", fontSize: "14px" }}>
          {shortName} Bills
        </div>
        <div style={{ fontSize: "12px", color: "#6b7280" }}>
          {computed(() => formatCurrency(totalUnpaid))} due
          <span
            style={{
              color: "#dc2626",
              marginLeft: "4px",
              display: computed(() => (overdueCount > 0 ? "inline" : "none")),
            }}
          >
            ({computed(() => overdueCount)} overdue)
          </span>
        </div>
        <ProcessingStatus
          totalCount={extractor.emailCount}
          pendingCount={extractor.pendingCount}
          completedCount={extractor.completedCount}
        />
      </div>
    </div>
  );

  // Summary stats UI
  const summaryStatsUI = (
    <div
      style={{
        display: "flex",
        gap: "16px",
        padding: "16px",
        backgroundColor: "#f3f4f6",
        borderRadius: "8px",
      }}
    >
      <div>
        <div
          style={{
            fontSize: "28px",
            fontWeight: "bold",
            color: "#1d4ed8",
          }}
        >
          {computed(() => formatCurrency(totalUnpaid))}
        </div>
        <div style={{ fontSize: "12px", color: "#666" }}>Total Unpaid</div>
      </div>
      <div
        style={{
          borderLeft: "1px solid #d1d5db",
          paddingLeft: "16px",
        }}
      >
        <div
          style={{
            fontSize: "28px",
            fontWeight: "bold",
            color: computed(() => (overdueCount > 0 ? "#dc2626" : "#059669")),
          }}
        >
          {computed(() => unpaidBills?.length || 0)}
        </div>
        <div style={{ fontSize: "12px", color: "#666" }}>Unpaid Bills</div>
      </div>
      <div
        style={{
          borderLeft: "1px solid #d1d5db",
          paddingLeft: "16px",
          display: computed(() => (overdueCount > 0 ? "block" : "none")),
        }}
      >
        <div
          style={{
            fontSize: "28px",
            fontWeight: "bold",
            color: "#dc2626",
          }}
        >
          {computed(() => overdueCount)}
        </div>
        <div style={{ fontSize: "12px", color: "#666" }}>Overdue</div>
      </div>
    </div>
  );

  // Overdue alert UI
  const overdueAlertUI = (
    <div
      style={{
        padding: "16px",
        backgroundColor: "#fee2e2",
        borderRadius: "12px",
        border: "2px solid #ef4444",
        display: computed(() => (overdueCount > 0 ? "block" : "none")),
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "12px",
          marginBottom: "8px",
        }}
      >
        <span style={{ fontSize: "32px" }}>*</span>
        <span
          style={{
            fontWeight: "700",
            fontSize: "20px",
            color: "#b91c1c",
          }}
        >
          {computed(() => overdueCount)} Overdue Bill
          {computed(() => (overdueCount !== 1 ? "s" : ""))}
        </span>
      </div>
      <div style={{ fontSize: "14px", color: "#b91c1c" }}>
        Please pay immediately to avoid late fees.
      </div>
    </div>
  );

  // Website link UI
  const websiteLinkUI = websiteUrl
    ? (
      <div style={{ marginTop: "16px", textAlign: "center" }}>
        <a
          href={websiteUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "inline-block",
            padding: "10px 20px",
            backgroundColor: resolvedBrandColor,
            color: "white",
            borderRadius: "8px",
            textDecoration: "none",
            fontWeight: "500",
            fontSize: "14px",
          }}
        >
          Open {shortName} Website
        </a>
      </div>
    )
    : null;

  // Manual tracking banner UI (shown when provider doesn't send payment confirmation emails)
  const manualTrackingBannerUI = !resolvedSupportsAutoDetect
    ? (
      <div
        style={{
          padding: "12px 16px",
          backgroundColor: "#eff6ff",
          borderRadius: "8px",
          border: "1px solid #3b82f6",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: "10px",
          }}
        >
          <span style={{ fontSize: "16px", color: "#3b82f6" }}>ℹ</span>
          <div>
            <div
              style={{
                fontWeight: "600",
                fontSize: "14px",
                color: "#1e40af",
                marginBottom: "4px",
              }}
            >
              Manual Tracking Required
            </div>
            <div
              style={{ fontSize: "13px", color: "#3730a3", lineHeight: "1.4" }}
            >
              {shortName}{" "}
              doesn't send payment confirmation emails. Use "Mark Paid" to track
              payments, or bills over {Math.abs(LIKELY_PAID_THRESHOLD_DAYS)}
              {" "}
              days old will be assumed paid.
            </div>
          </div>
        </div>
      </div>
    )
    : null;

  return {
    // Pre-computed data (building-block scope)
    bills,
    unpaidBills,
    paidBills,
    likelyPaidBills,
    totalUnpaid,
    overdueCount,

    // Raw data for pattern-scope processing
    rawAnalyses: extractor.rawAnalyses,
    paymentConfirmations,

    // Config
    identifierType,
    title,
    shortName,
    brandColor: resolvedBrandColor,
    websiteUrl,
    supportsAutoDetect: resolvedSupportsAutoDetect,

    // Status
    pendingCount: extractor.pendingCount,
    completedCount: extractor.completedCount,
    emailCount: extractor.emailCount,
    isConnected: extractor.isConnected,

    // Operations
    refresh: extractor.refresh,

    // UI (simple components only)
    ui: {
      authStatusUI: extractor.ui.authStatusUI,
      connectionStatusUI: extractor.ui.connectionStatusUI,
      analysisProgressUI: extractor.ui.analysisProgressUI,
      previewUI,
      summaryStatsUI,
      overdueAlertUI,
      websiteLinkUI,
      manualTrackingBannerUI,
    },

    // Access to underlying extractor
    gmailExtractor: extractor,
  };
}

export default BillExtractor;
