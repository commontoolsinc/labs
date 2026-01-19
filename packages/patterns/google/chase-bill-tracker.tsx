/// <cts-enable />
/**
 * Chase Bill Tracker Pattern
 *
 * Tracks Chase credit card bills from email notifications, showing unpaid/upcoming
 * bills and automatically or manually marking them as paid.
 *
 * Features:
 * - Embeds gmail-importer directly for Chase emails
 * - Extracts bill information using LLM from email markdown content
 * - Tracks payment confirmations to auto-mark bills as paid
 * - Supports manual "Mark as Paid" for local tracking
 * - Groups bills by card (last 4 digits)
 *
 * Usage:
 * 1. Deploy a google-auth charm and complete OAuth
 * 2. Deploy this pattern
 * 3. Link: ct charm link google-auth/auth chase-bill-tracker/linkedAuth
 */
import {
  computed,
  Default,
  generateObject,
  handler,
  ifElse,
  JSONSchema,
  NAME,
  pattern,
  UI,
  Writable,
} from "commontools";
import type { Schema } from "commontools/schema";
import GmailImporter, { type Auth } from "./gmail-importer.tsx";

// Email type - matches GmailImporter's Email type
interface Email {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  threadId: string;
  labelIds: string[];
  htmlContent: string;
  plainText: string;
  markdownContent: string;
}

// =============================================================================
// TYPES
// =============================================================================

type EmailType =
  | "bill_due"
  | "payment_received"
  | "payment_reminder"
  | "statement_ready"
  | "autopay_scheduled"
  | "other";

type BillStatus = "unpaid" | "paid" | "overdue";

interface ChaseEmailAnalysis {
  emailType: EmailType;
  cardLast4?: string;
  amount?: number;
  dueDate?: string; // ISO format YYYY-MM-DD
  paymentDate?: string; // For payment confirmations
  minimumPayment?: number;
  statementBalance?: number;
  autopayEnabled?: boolean;
  summary: string;
}

/** A tracked bill */
interface TrackedBill {
  key: string; // Deduplication key
  cardLast4: string;
  amount: number;
  dueDate: string;
  status: BillStatus;
  isPaid: boolean;
  paidDate?: string;
  emailDate: string;
  emailId: string;
  isManuallyPaid: boolean;
  daysUntilDue: number;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * DEMO_MODE: When true, all dollar amounts are hashed to fake values
 * for privacy during demos. This ensures no real financial data is shown.
 */
const DEMO_MODE = true;

// 16 distinct colors for card badges
const CARD_COLORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#84cc16",
  "#22c55e",
  "#14b8a6",
  "#06b6d4",
  "#0ea5e9",
  "#3b82f6",
  "#6366f1",
  "#8b5cf6",
  "#a855f7",
  "#d946ef",
  "#ec4899",
  "#f43f5e",
  "#78716c",
];

// Chase sends from various addresses - capture the main patterns
const _CHASE_SENDERS = [
  "no-reply@alertsp.chase.com",
  "chase@email.chase.com",
  "no.reply.alerts@chase.com",
] as const;

// Gmail query to find Chase emails - build manually to avoid .map() transformation
const CHASE_GMAIL_QUERY =
  "from:no-reply@alertsp.chase.com OR from:chase@email.chase.com OR from:no.reply.alerts@chase.com";

// Schema for LLM email analysis
const EMAIL_ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    emailType: {
      type: "string",
      enum: [
        "bill_due",
        "payment_received",
        "payment_reminder",
        "statement_ready",
        "autopay_scheduled",
        "other",
      ],
      description:
        "Type of Chase email: bill_due for payment due notifications, payment_received for payment confirmations, payment_reminder for upcoming due reminders, statement_ready for new statement notifications, autopay_scheduled for autopay confirmation, other for unrelated emails",
    },
    cardLast4: {
      type: "string",
      description:
        "Last 4 digits of the credit card (e.g., '1234'). Look for patterns like 'ending in 1234' or '...1234'",
    },
    amount: {
      type: "number",
      description:
        "The payment amount or bill amount in dollars (just the number, no $ sign)",
    },
    dueDate: {
      type: "string",
      description: "Payment due date in ISO format YYYY-MM-DD (if mentioned)",
    },
    paymentDate: {
      type: "string",
      description:
        "Date payment was received/processed in ISO format YYYY-MM-DD (for payment confirmations)",
    },
    minimumPayment: {
      type: "number",
      description: "Minimum payment amount if mentioned",
    },
    statementBalance: {
      type: "number",
      description: "Statement balance if mentioned",
    },
    autopayEnabled: {
      type: "boolean",
      description: "Whether autopay is mentioned as being enabled",
    },
    summary: {
      type: "string",
      description: "Brief one-sentence summary of the email content",
    },
  },
  required: ["emailType", "summary"],
} as const satisfies JSONSchema;

type EmailAnalysisResult = Schema<typeof EMAIL_ANALYSIS_SCHEMA>;

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Create a deduplication key for a bill.
 * Uses card last 4 + due date to identify unique bills.
 */
function createBillKey(cardLast4: string, dueDate: string): string {
  return `${cardLast4}|${dueDate}`;
}

/**
 * Calculate days until due date.
 * Returns negative number for overdue items.
 */
function calculateDaysUntilDue(dueDate: string | undefined): number {
  if (!dueDate) return 999;

  const match = dueDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return 999;

  const [, year, month, day] = match;
  const due = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));

  if (isNaN(due.getTime())) return 999;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  due.setHours(0, 0, 0, 0);
  return Math.ceil((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Format currency for display.
 */
function formatCurrency(amount: number | undefined): string {
  if (amount === undefined) return "N/A";
  return `$${amount.toFixed(2)}`;
}

/**
 * Format date for display.
 * Parses YYYY-MM-DD as local date to avoid UTC timezone shift.
 */
function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return "N/A";
  // Parse YYYY-MM-DD as local date components to avoid UTC interpretation
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(year, month - 1, day); // month is 0-indexed
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/**
 * Get a consistent color for a card based on its last 4 digits.
 * Same card always gets the same color.
 */
function getCardColor(last4: string): string {
  let hash = 0;
  for (const char of last4) {
    hash = (hash + char.charCodeAt(0)) % 16;
  }
  return CARD_COLORS[hash];
}

/**
 * In demo mode, hash any price to a deterministic value $0-$5000.
 * Uses a simple string hash on the input to ensure same input = same output.
 */
function demoPrice(amount: number): number {
  if (!DEMO_MODE) return amount;
  // Hash the amount to get deterministic pseudo-random value
  const str = amount.toFixed(2);
  let hash = 0;
  for (const char of str) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }
  // Map to 0-5000 range
  return Math.abs(hash % 500000) / 100; // 0.00 to 4999.99
}

// =============================================================================
// HANDLERS
// =============================================================================

// Handler to mark a bill as paid
// Pass the entire bill cell, read key inside handler (idiomatic pattern from shopping-list.tsx)
const markAsPaid = handler<
  void,
  { paidKeys: Writable<string[]>; bill: TrackedBill }
>((_event, { paidKeys, bill }) => {
  const current = paidKeys.get() || [];
  const key = bill.key;
  if (key && !current.includes(key)) {
    paidKeys.set([...current, key]);
  }
});

// Handler to unmark a bill as paid
const unmarkAsPaid = handler<
  void,
  { paidKeys: Writable<string[]>; bill: TrackedBill }
>((_event, { paidKeys, bill }) => {
  const current = paidKeys.get() || [];
  const key = bill.key;
  paidKeys.set(current.filter((k: string) => k !== key));
});

// =============================================================================
// PATTERN
// =============================================================================

interface PatternInput {
  linkedAuth?: Auth;
  manuallyPaid: Writable<Default<string[], []>>;
}

/** Chase credit card bill tracker. #chaseBills */
interface PatternOutput {
  bills: TrackedBill[];
  unpaidBills: TrackedBill[];
  paidBills: TrackedBill[];
  totalUnpaid: number;
  overdueCount: number;
  // previewUI: unknown;
}

export default pattern<PatternInput, PatternOutput>(
  ({ linkedAuth, manuallyPaid }) => {
    // Directly instantiate GmailImporter with Chase-specific settings
    const gmailImporter = GmailImporter({
      settings: {
        gmailFilterQuery: CHASE_GMAIL_QUERY,
        autoFetchOnAuth: true,
        resolveInlineImages: false,
        limit: 100,
        debugMode: false,
      },
      linkedAuth,
    });

    // Get emails directly from the embedded gmail-importer
    const allEmails = gmailImporter.emails;

    // Filter for Chase emails
    const chaseEmails = computed(() => {
      return (allEmails || []).filter((e: Email) => {
        const from = (e.from || "").toLowerCase();
        return from.includes("alertsp.chase.com") ||
          from.includes("email.chase.com") ||
          from.includes("alerts@chase.com");
      });
    });

    // Count of Chase emails found
    const chaseEmailCount = computed(() => chaseEmails?.length || 0);

    // Check if connected
    const isConnected = computed(() => {
      if (linkedAuth?.token) return true;
      return gmailImporter?.emailCount !== undefined;
    });

    // ==========================================================================
    // REACTIVE LLM ANALYSIS
    // Analyze each Chase email to extract bill/payment information
    // ==========================================================================

    const emailAnalyses = chaseEmails.map((email: Email) => {
      const analysis = generateObject<EmailAnalysisResult>({
        prompt: computed(() => {
          if (!email?.markdownContent) {
            return undefined;
          }

          return `Analyze this Chase credit card email and extract billing/payment information.

EMAIL SUBJECT: ${email.subject || ""}
EMAIL DATE: ${email.date || ""}

EMAIL CONTENT:
${email.markdownContent}

Extract:
1. The type of email:
   - bill_due: A notification that a payment is due
   - payment_received: Confirmation that a payment was received/processed
   - payment_reminder: Reminder about upcoming due date
   - statement_ready: New statement is available
   - autopay_scheduled: Autopay confirmation
   - other: Unrelated to billing

2. Card last 4 digits - look for patterns like "ending in 1234", "...1234", "card ending 1234"

3. Amount - the payment amount or bill amount (number only, no $ sign)

4. Due date - in YYYY-MM-DD format

5. Payment date - for payment confirmations, in YYYY-MM-DD format

6. Other details like minimum payment, statement balance, autopay status

7. Brief summary of what this email is about`;
        }),
        schema: EMAIL_ANALYSIS_SCHEMA,
        model: "anthropic:claude-sonnet-4-5",
      });

      return {
        email,
        emailId: email.id,
        emailDate: email.date,
        analysis,
        pending: analysis.pending,
        error: analysis.error,
        result: analysis.result,
      };
    });

    // Count pending analyses
    const pendingCount = computed(
      () => emailAnalyses?.filter((a) => a?.pending)?.length || 0,
    );

    // Count completed analyses
    const completedCount = computed(
      () =>
        emailAnalyses?.filter((a) =>
          a?.analysis?.pending === false && a?.analysis?.result !== undefined
        ).length || 0,
    );

    // ==========================================================================
    // BILL TRACKING
    // Combine bill notifications and payment confirmations
    // ==========================================================================

    // Extract payment confirmations (to auto-mark bills as paid)
    // Using Record<string, string> instead of Map since Map is not JSON-serializable
    const paymentConfirmations = computed(() => {
      const confirmations: Record<string, string> = {}; // cardLast4 -> paymentDate

      for (const analysisItem of emailAnalyses || []) {
        const result = analysisItem.result;
        if (!result) continue;

        if (
          result.emailType === "payment_received" &&
          result.cardLast4 &&
          result.paymentDate
        ) {
          // Find the bill this payment applies to
          // We'll match by card last 4 and look for nearby due dates
          const key = result.cardLast4;
          confirmations[key] = result.paymentDate;
        }
      }

      return confirmations;
    });

    // Process all analyses and build bill list
    const bills = computed(() => {
      const billMap: Record<string, TrackedBill> = {};
      // manuallyPaid is Writable - use .get() to access value
      const paidKeys = manuallyPaid.get() || [];
      // Access the computed value - paymentConfirmations returns a Record
      const payments = (paymentConfirmations || {}) as Record<string, string>;

      // Sort emails by date (newest first) so we keep most recent data
      const sortedAnalyses = [...(emailAnalyses || [])]
        .filter((a) => a?.result)
        .sort((a, b) => {
          const dateA = new Date(a.emailDate || 0).getTime();
          const dateB = new Date(b.emailDate || 0).getTime();
          return dateB - dateA;
        });

      for (const analysisItem of sortedAnalyses) {
        const result = analysisItem.result;
        if (!result) continue;

        // Track bills from multiple email types:
        // - bill_due: Explicit "payment due" notifications
        // - payment_reminder: Upcoming due date reminders
        // - statement_ready: Statement notifications (these often contain the bill amount/due date)
        const isBillEmail = result.emailType === "bill_due" ||
          result.emailType === "payment_reminder";
        const isStatementWithBillInfo =
          result.emailType === "statement_ready" &&
          result.dueDate &&
          (result.amount || result.statementBalance);

        if (!isBillEmail && !isStatementWithBillInfo) {
          continue;
        }

        // Need card last 4 and due date to track a bill
        if (!result.cardLast4 || !result.dueDate) continue;

        // For statement_ready, use statementBalance if amount isn't set
        const billAmount = result.amount || result.statementBalance || 0;

        const key = createBillKey(result.cardLast4, result.dueDate);

        // Skip if we already have this bill (we process newest first)
        if (billMap[key]) continue;

        const daysUntilDue = calculateDaysUntilDue(result.dueDate);

        // Check if this bill has been paid (auto or manual)
        const isManuallyPaid = paidKeys.includes(key);
        // TODO(@anthropic): Auto-pay detection is broad - any payment for a card marks
        // all bills for that card as paid. Could match payment amounts/dates for precision.
        const autoPaid = result.cardLast4 in payments;
        const isPaid = isManuallyPaid || autoPaid;

        const trackedBill: TrackedBill = {
          key,
          cardLast4: result.cardLast4,
          amount: demoPrice(billAmount),
          dueDate: result.dueDate,
          status: isPaid ? "paid" : daysUntilDue < 0 ? "overdue" : "unpaid",
          isPaid,
          paidDate: autoPaid ? payments[result.cardLast4] : undefined,
          emailDate: analysisItem.emailDate,
          emailId: analysisItem.emailId,
          isManuallyPaid,
          daysUntilDue,
        };

        billMap[key] = trackedBill;
      }

      // Convert to array and sort by due date (soonest first)
      const items = Object.values(billMap);
      return items.sort((a, b) => a.daysUntilDue - b.daysUntilDue);
    });

    // Unpaid bills
    const unpaidBills = computed(() =>
      (bills || []).filter((bill) => !bill.isPaid)
    );

    // Paid bills - sorted by due date descending (newest first)
    const paidBills = computed(() =>
      (bills || [])
        .filter((bill) => bill.isPaid)
        .sort((a, b) => b.dueDate.localeCompare(a.dueDate))
    );

    // Total unpaid amount
    const totalUnpaid = computed(() =>
      (unpaidBills || []).reduce((sum, bill) => sum + bill.amount, 0)
    );

    // Overdue count
    const overdueCount = computed(
      () => (unpaidBills || []).filter((bill) => bill.daysUntilDue < 0).length,
    );

    // Preview UI for compact display
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
        <div>
          <div style={{ fontWeight: "600", fontSize: "14px" }}>Chase Bills</div>
          <div style={{ fontSize: "12px", color: "#6b7280" }}>
            {computed(() => formatCurrency(totalUnpaid))} due
            <span
              style={{
                color: "#dc2626",
                marginLeft: "4px",
                display: computed(() => overdueCount > 0 ? "inline" : "none"),
              }}
            >
              ({computed(() => overdueCount)} overdue)
            </span>
          </div>
        </div>
      </div>
    );

    return {
      [NAME]: "Chase Bill Tracker",

      bills,
      unpaidBills,
      paidBills,
      totalUnpaid,
      overdueCount,
      previewUI,

      [UI]: (
        <ct-screen>
          <div slot="header">
            <ct-heading level={3}>Chase Bill Tracker</ct-heading>
          </div>

          <ct-vscroll flex showScrollbar>
            <ct-vstack padding="6" gap="4">
              {/* Auth UI from embedded Gmail Importer */}
              {gmailImporter.authUI}

              {/* Connection Status */}
              <div
                style={{
                  padding: "12px 16px",
                  backgroundColor: computed(() =>
                    isConnected ? "#d1fae5" : "#fef3c7"
                  ),
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
                    {computed(() => chaseEmailCount)} Chase emails found
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

              {/* Analysis Status */}
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
                  <span>{computed(() => chaseEmailCount)} emails</span>
                  <div
                    style={{
                      display: computed(() =>
                        pendingCount > 0 ? "flex" : "none"
                      ),
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

              {/* Summary Stats */}
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
                  <div style={{ fontSize: "12px", color: "#666" }}>
                    Total Unpaid
                  </div>
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
                      color: computed(() =>
                        overdueCount > 0 ? "#dc2626" : "#059669"
                      ),
                    }}
                  >
                    {computed(() => unpaidBills?.length || 0)}
                  </div>
                  <div style={{ fontSize: "12px", color: "#666" }}>
                    Unpaid Bills
                  </div>
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
                      color: "#059669",
                    }}
                  >
                    {computed(() => paidBills?.length || 0)}
                  </div>
                  <div style={{ fontSize: "12px", color: "#666" }}>
                    Paid Bills
                  </div>
                </div>
              </div>

              {/* Overdue Alert */}
              <div
                style={{
                  padding: "16px",
                  backgroundColor: "#fee2e2",
                  borderRadius: "12px",
                  border: "2px solid #ef4444",
                  display: computed(
                    () => (overdueCount > 0 ? "block" : "none"),
                  ),
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    marginBottom: "8px",
                  }}
                >
                  <span style={{ fontSize: "20px" }}>!</span>
                  <span
                    style={{
                      fontWeight: "700",
                      fontSize: "18px",
                      color: "#b91c1c",
                    }}
                  >
                    {computed(() => overdueCount)}{" "}
                    Overdue Bill{computed(() => overdueCount !== 1 ? "s" : "")}
                  </span>
                </div>
                <div style={{ fontSize: "14px", color: "#b91c1c" }}>
                  Please pay immediately to avoid late fees.
                </div>
              </div>

              {/* Unpaid Bills Section */}
              <div
                style={{
                  display: computed(() =>
                    (unpaidBills || []).length > 0 ? "block" : "none"
                  ),
                }}
              >
                <h3
                  style={{
                    fontSize: "16px",
                    fontWeight: "600",
                    marginBottom: "12px",
                    color: "#374151",
                  }}
                >
                  Unpaid Bills
                </h3>
                <ct-vstack gap="3">
                  {unpaidBills.map((bill) => (
                    <div
                      style={{
                        display: "flex",
                        gap: "12px",
                        padding: "16px",
                        backgroundColor: "#fef3c7",
                        borderRadius: "12px",
                        border: "2px solid #f59e0b",
                      }}
                    >
                      <div style={{ flex: 1 }}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                            marginBottom: "4px",
                          }}
                        >
                          <span
                            style={{
                              fontWeight: "700",
                              fontSize: "18px",
                              color: "#111827",
                            }}
                          >
                            {formatCurrency(bill.amount)}
                          </span>
                          <span
                            style={{
                              padding: "2px 8px",
                              backgroundColor: getCardColor(bill.cardLast4),
                              borderRadius: "4px",
                              fontSize: "12px",
                              color: "white",
                              fontWeight: "500",
                            }}
                          >
                            ...{bill.cardLast4}
                          </span>
                        </div>
                        <div
                          style={{
                            fontSize: "14px",
                            color: "#92400e",
                          }}
                        >
                          Due in {bill.daysUntilDue} days -{" "}
                          {formatDate(bill.dueDate)}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={markAsPaid({
                          paidKeys: manuallyPaid,
                          bill,
                        })}
                        style={{
                          padding: "8px 16px",
                          backgroundColor: "#10b981",
                          color: "white",
                          border: "none",
                          borderRadius: "8px",
                          cursor: "pointer",
                          fontSize: "14px",
                          fontWeight: "600",
                          alignSelf: "center",
                        }}
                      >
                        Mark Paid
                      </button>
                    </div>
                  ))}
                </ct-vstack>
              </div>

              {/* Paid Bills Section */}
              <div
                style={{
                  display: computed(() =>
                    (paidBills || []).length > 0 ? "block" : "none"
                  ),
                }}
              >
                <details>
                  <summary
                    style={{
                      cursor: "pointer",
                      fontWeight: "600",
                      fontSize: "16px",
                      marginBottom: "12px",
                      color: "#059669",
                    }}
                  >
                    Paid Bills ({computed(() => paidBills?.length || 0)})
                  </summary>
                  <ct-vstack gap="2">
                    {paidBills.map((bill) => (
                      <div
                        style={{
                          display: "flex",
                          gap: "12px",
                          padding: "12px",
                          backgroundColor: "#d1fae5",
                          borderRadius: "8px",
                          border: "1px solid #10b981",
                          opacity: 0.8,
                        }}
                      >
                        <div style={{ flex: 1 }}>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "8px",
                            }}
                          >
                            <span
                              style={{
                                fontWeight: "600",
                                fontSize: "16px",
                                color: "#047857",
                              }}
                            >
                              {formatCurrency(bill.amount)}
                            </span>
                            <span
                              style={{
                                padding: "2px 6px",
                                backgroundColor: getCardColor(bill.cardLast4),
                                borderRadius: "4px",
                                fontSize: "11px",
                                color: "white",
                                fontWeight: "500",
                              }}
                            >
                              ...{bill.cardLast4}
                            </span>
                            <span
                              style={{
                                fontSize: "12px",
                                color: "#059669",
                              }}
                            >
                              {ifElse(
                                bill.isManuallyPaid,
                                "(manually marked)",
                                "(auto-detected)",
                              )}
                            </span>
                          </div>
                          <div
                            style={{
                              fontSize: "12px",
                              color: "#047857",
                              marginTop: "4px",
                            }}
                          >
                            Was due: {formatDate(bill.dueDate)}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={unmarkAsPaid({
                            paidKeys: manuallyPaid,
                            bill,
                          })}
                          style={{
                            padding: "6px 12px",
                            backgroundColor: "#6b7280",
                            color: "white",
                            border: "none",
                            borderRadius: "6px",
                            cursor: "pointer",
                            fontSize: "12px",
                            fontWeight: "500",
                            alignSelf: "center",
                            display: bill.isManuallyPaid ? "block" : "none",
                          }}
                        >
                          Undo
                        </button>
                      </div>
                    ))}
                  </ct-vstack>
                </details>
              </div>

              {/* Debug View Section */}
              <div
                style={{
                  marginTop: "24px",
                  padding: "16px",
                  backgroundColor: "#f9fafb",
                  borderRadius: "8px",
                  border: "1px solid #d1d5db",
                  display: computed(() =>
                    chaseEmailCount > 0 ? "block" : "none"
                  ),
                }}
              >
                <details>
                  <summary
                    style={{
                      cursor: "pointer",
                      fontWeight: "600",
                      fontSize: "16px",
                      marginBottom: "12px",
                      color: "#374151",
                    }}
                  >
                    Debug View ({computed(() => chaseEmailCount)} emails)
                  </summary>

                  <div style={{ marginTop: "12px" }}>
                    <h4
                      style={{
                        fontSize: "14px",
                        fontWeight: "600",
                        marginBottom: "8px",
                        color: "#6b7280",
                      }}
                    >
                      Fetched Chase Emails:
                    </h4>
                    <ct-vstack gap="2">
                      {chaseEmails.map((email: Email) => (
                        <div
                          style={{
                            padding: "8px 12px",
                            backgroundColor: "white",
                            borderRadius: "6px",
                            border: "1px solid #e5e7eb",
                            fontSize: "12px",
                          }}
                        >
                          <div
                            style={{ fontWeight: "600", marginBottom: "4px" }}
                          >
                            {email.subject}
                          </div>
                          <div style={{ color: "#6b7280" }}>
                            From: {email.from} • Date:{" "}
                            {computed(() => formatDate(email.date))}
                          </div>
                          <details style={{ marginTop: "4px" }}>
                            <summary
                              style={{ cursor: "pointer", color: "#3b82f6" }}
                            >
                              Show content
                            </summary>
                            <pre
                              style={{
                                marginTop: "8px",
                                padding: "8px",
                                backgroundColor: "#f3f4f6",
                                borderRadius: "4px",
                                fontSize: "10px",
                                overflow: "auto",
                                maxHeight: "200px",
                                whiteSpace: "pre-wrap",
                              }}
                            >
                              {email.markdownContent}
                            </pre>
                          </details>
                        </div>
                      ))}
                    </ct-vstack>

                    <h4
                      style={{
                        fontSize: "14px",
                        fontWeight: "600",
                        marginTop: "16px",
                        marginBottom: "8px",
                        color: "#6b7280",
                      }}
                    >
                      LLM Analysis Results:
                    </h4>
                    <ct-vstack gap="2">
                      {emailAnalyses.map((analysis) => (
                        <div
                          style={{
                            padding: "12px",
                            backgroundColor: "white",
                            borderRadius: "6px",
                            border: computed(() =>
                              analysis.pending
                                ? "1px solid #fbbf24"
                                : analysis.error
                                ? "1px solid #ef4444"
                                : "1px solid #10b981"
                            ),
                            fontSize: "12px",
                          }}
                        >
                          <div
                            style={{
                              fontWeight: "600",
                              marginBottom: "4px",
                              color: "#111827",
                            }}
                          >
                            {analysis.email.subject}
                          </div>

                          <div
                            style={{
                              display: analysis.pending ? "flex" : "none",
                              alignItems: "center",
                              gap: "4px",
                              color: "#f59e0b",
                              marginTop: "4px",
                            }}
                          >
                            <ct-loader size="sm" />
                            <span>Analyzing...</span>
                          </div>

                          <div
                            style={{
                              display: analysis.error ? "block" : "none",
                              color: "#dc2626",
                              marginTop: "4px",
                            }}
                          >
                            Error: {computed(() =>
                              analysis.error ? String(analysis.error) : ""
                            )}
                          </div>

                          <div
                            style={{
                              display: computed(() =>
                                !analysis.pending && !analysis.error &&
                                  analysis.result
                                  ? "block"
                                  : "none"
                              ),
                            }}
                          >
                            <div
                              style={{
                                marginTop: "8px",
                                padding: "8px",
                                backgroundColor: "#f3f4f6",
                                borderRadius: "4px",
                              }}
                            >
                              <div style={{ color: "#374151" }}>
                                <strong>Type:</strong> {computed(() =>
                                  analysis.result?.emailType || "N/A"
                                )}
                              </div>
                              <div
                                style={{ color: "#374151", marginTop: "4px" }}
                              >
                                <strong>Card:</strong> ...
                                {computed(() =>
                                  analysis.result?.cardLast4 || "N/A"
                                )}
                              </div>
                              <div
                                style={{ color: "#374151", marginTop: "4px" }}
                              >
                                <strong>Amount:</strong> {computed(() =>
                                  formatCurrency(
                                    analysis.result?.amount !== undefined
                                      ? demoPrice(analysis.result.amount)
                                      : undefined,
                                  )
                                )}
                              </div>
                              <div
                                style={{ color: "#374151", marginTop: "4px" }}
                              >
                                <strong>Due:</strong> {computed(() =>
                                  formatDate(analysis.result?.dueDate)
                                )}
                              </div>
                              <div
                                style={{ color: "#374151", marginTop: "4px" }}
                              >
                                <strong>Summary:</strong> {computed(() =>
                                  analysis.result?.summary || "N/A"
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </ct-vstack>
                  </div>
                </details>
              </div>

              {/* Chase Website Link */}
              <div style={{ marginTop: "16px", textAlign: "center" }}>
                <a
                  href="https://www.chase.com/"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: "inline-block",
                    padding: "10px 20px",
                    backgroundColor: "#1a5276",
                    color: "white",
                    borderRadius: "8px",
                    textDecoration: "none",
                    fontWeight: "500",
                    fontSize: "14px",
                  }}
                >
                  Open Chase Website
                </a>
              </div>

              {/* Demo Mode Indicator */}
              {DEMO_MODE && (
                <div
                  style={{
                    fontSize: "11px",
                    color: "#9ca3af",
                    cursor: "help",
                    textAlign: "center",
                    marginTop: "8px",
                  }}
                  title="Uses fake numbers for privacy"
                >
                  Demo Mode
                </div>
              )}
            </ct-vstack>
          </ct-vscroll>
        </ct-screen>
      ),
    };
  },
);
