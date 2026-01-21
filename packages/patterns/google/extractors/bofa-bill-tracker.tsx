/// <cts-enable />
/**
 * Bank of America Bill Tracker Pattern
 *
 * Tracks Bank of America credit card bills from email notifications, showing
 * unpaid/upcoming bills and automatically or manually marking them as paid.
 *
 * Features:
 * - Uses GmailExtractor building block for email fetching and LLM extraction
 * - Tracks payment confirmations to auto-mark bills as paid
 * - Supports manual "Mark as Paid" for local tracking
 * - Groups bills by card (last 4 digits)
 *
 * Usage:
 * 1. Deploy a google-auth charm and complete OAuth
 * 2. Deploy this pattern
 * 3. Link: ct charm link google-auth/auth bofa-bill-tracker/linkedAuth
 */
import {
  computed,
  Default,
  handler,
  ifElse,
  JSONSchema,
  NAME,
  pattern,
  UI,
  Writable,
} from "commontools";
import type { Schema } from "commontools/schema";
import GmailExtractor from "../building-blocks/gmail-extractor.tsx";
import type { Auth } from "../building-blocks/gmail-importer.tsx";
import ProcessingStatus from "../building-blocks/processing-status.tsx";

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

type BillStatus = "unpaid" | "paid" | "overdue" | "likely_paid";

interface TrackedBill {
  key: string;
  cardLast4: string;
  amount: number;
  dueDate: string;
  status: BillStatus;
  isPaid: boolean;
  paidDate?: string;
  emailDate: string;
  emailId: string;
  isManuallyPaid: boolean;
  isLikelyPaid: boolean;
  daysUntilDue: number;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const LIKELY_PAID_THRESHOLD_DAYS = -45;

const CARD_COLORS = [
  "#ef4444",
  "#dc2626",
  "#f97316",
  "#ea580c",
  "#eab308",
  "#ca8a04",
  "#84cc16",
  "#65a30d",
  "#22c55e",
  "#16a34a",
  "#14b8a6",
  "#0d9488",
  "#06b6d4",
  "#0891b2",
  "#0ea5e9",
  "#0284c7",
  "#3b82f6",
  "#2563eb",
  "#6366f1",
  "#4f46e5",
  "#8b5cf6",
  "#7c3aed",
  "#a855f7",
  "#9333ea",
  "#d946ef",
  "#c026d3",
  "#ec4899",
  "#db2777",
  "#f43f5e",
  "#e11d48",
  "#78716c",
  "#57534e",
];

const BOFA_GMAIL_QUERY =
  "from:onlinebanking@ealerts.bankofamerica.com OR from:alerts@bankofamerica.com";

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
        "Type of Bank of America email: bill_due for payment due notifications, payment_received for payment confirmations, payment_reminder for upcoming due reminders, statement_ready for new statement notifications, autopay_scheduled for autopay confirmation, other for unrelated emails",
    },
    cardLast4: {
      type: "string",
      description:
        "Last 4 digits of the credit card (e.g., '1234'). Look for patterns like 'ending in 1234' or '...1234' or 'card 1234'",
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

const EXTRACTION_PROMPT_TEMPLATE =
  `Analyze this Bank of America credit card email and extract billing/payment information.

EMAIL SUBJECT: {{email.subject}}
EMAIL DATE: {{email.date}}

EMAIL CONTENT:
{{email.markdownContent}}

Extract:
1. The type of email:
   - bill_due: A notification that a payment is due
   - payment_received: Confirmation that a payment was received/processed
   - payment_reminder: Reminder about upcoming due date
   - statement_ready: New statement is available
   - autopay_scheduled: Autopay confirmation
   - other: Unrelated to billing

2. Card last 4 digits - look for patterns like "ending in 1234", "...1234", "card 1234"

3. Amount - the payment amount or bill amount (number only, no $ sign)

4. Due date - in YYYY-MM-DD format

5. Payment date - for payment confirmations, in YYYY-MM-DD format

6. Other details like minimum payment, statement balance, autopay status

7. Brief summary of what this email is about`;

// =============================================================================
// HELPERS
// =============================================================================

function createBillKey(cardLast4: string, dueDate: string): string {
  return `${cardLast4}|${dueDate}`;
}

function calculateDaysUntilDue(
  dueDate: string | undefined,
  referenceDate: Date,
): number {
  if (!dueDate) return 999;
  const match = dueDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return 999;
  const [, year, month, day] = match;
  const due = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
  if (isNaN(due.getTime())) return 999;
  due.setHours(0, 0, 0, 0);
  return Math.ceil(
    (due.getTime() - referenceDate.getTime()) / (1000 * 60 * 60 * 24),
  );
}

function parseDateToMs(dateStr: string): number {
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return NaN;
  const [, year, month, day] = match;
  const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function formatCurrency(amount: number | undefined): string {
  if (amount === undefined) return "N/A";
  return `$${amount.toFixed(2)}`;
}

function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return "N/A";
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function getCardColor(last4: string | undefined): string {
  if (!last4 || typeof last4 !== "string") return CARD_COLORS[0];
  let hash = 0;
  for (let i = 0; i < last4.length; i++) {
    hash = (hash * 31 + last4.charCodeAt(i)) % 32;
  }
  return CARD_COLORS[hash];
}

function demoPrice(amount: number, isDemoMode: boolean): number {
  if (!isDemoMode) return amount;
  if (!Number.isFinite(amount)) return 0;
  const str = amount.toFixed(2);
  let hash = 0;
  for (const char of str) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }
  const normalized = (hash >>> 0) / 0xFFFFFFFF;
  const powerLaw = Math.pow(normalized, 2);
  return Math.round(powerLaw * 500000) / 100;
}

// =============================================================================
// HANDLERS
// =============================================================================

const markAsPaid = handler<
  void,
  { paidKeys: Writable<string[]>; bill: TrackedBill }
>(
  (_event, { paidKeys, bill }) => {
    const current = paidKeys.get() || [];
    const key = bill.key;
    if (key && !current.includes(key)) {
      paidKeys.set([...current, key]);
    }
  },
);

const unmarkAsPaid = handler<
  void,
  { paidKeys: Writable<string[]>; bill: TrackedBill }
>(
  (_event, { paidKeys, bill }) => {
    const current = paidKeys.get() || [];
    const key = bill.key;
    paidKeys.set(current.filter((k: string) => k !== key));
  },
);

// =============================================================================
// PATTERN
// =============================================================================

interface PatternInput {
  linkedAuth?: Auth;
  manuallyPaid?: Writable<Default<string[], []>>;
  demoMode?: Writable<Default<boolean, true>>;
}

interface PatternOutput {
  bills: TrackedBill[];
  unpaidBills: TrackedBill[];
  paidBills: TrackedBill[];
  totalUnpaid: number;
  overdueCount: number;
  previewUI: unknown;
}

export default pattern<PatternInput, PatternOutput>(
  ({ linkedAuth, manuallyPaid, demoMode }) => {
    // Use GmailExtractor building block for email fetching and LLM extraction
    const extractor = GmailExtractor<EmailAnalysisResult>({
      gmailQuery: BOFA_GMAIL_QUERY,
      extractionSchema: EMAIL_ANALYSIS_SCHEMA,
      extractionPromptTemplate: EXTRACTION_PROMPT_TEMPLATE,
      title: "BofA Emails",
      resolveInlineImages: false,
      limit: 100,
      linkedAuth,
    });

    // Extract payment confirmations for auto-marking bills as paid
    const paymentConfirmations = computed(() => {
      const confirmations: Record<string, Set<string>> = {};

      for (const item of extractor.rawAnalyses || []) {
        const result = item.result;
        if (!result) continue;

        if (
          result.emailType === "payment_received" && result.cardLast4 &&
          result.paymentDate
        ) {
          const key = result.cardLast4;
          if (!confirmations[key]) confirmations[key] = new Set();
          confirmations[key].add(result.paymentDate);
        }
      }

      const sortedResult: Record<string, string[]> = {};
      for (const cardKey of Object.keys(confirmations).sort()) {
        sortedResult[cardKey] = [...confirmations[cardKey]].sort((a, b) =>
          a.localeCompare(b)
        );
      }
      return sortedResult;
    });

    // Process analyses and build bill list with domain-specific logic
    const bills = computed(() => {
      const billMap: Record<string, TrackedBill> = {};
      const paidKeys = manuallyPaid.get() || [];
      const payments = paymentConfirmations || {};
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const sortedAnalyses = [...(extractor.rawAnalyses || [])]
        .filter((a) => a?.result)
        .sort((a, b) => {
          const dateA = new Date(a.emailDate || 0).getTime();
          const dateB = new Date(b.emailDate || 0).getTime();
          if (dateB !== dateA) return dateB - dateA;
          return (a.emailId || "").localeCompare(b.emailId || "");
        });

      for (const analysisItem of sortedAnalyses) {
        const result = analysisItem.result;
        if (!result) continue;

        const isBillEmail = result.emailType === "bill_due" ||
          result.emailType === "payment_reminder";
        const isStatementWithBillInfo =
          result.emailType === "statement_ready" &&
          result.dueDate && (result.amount || result.statementBalance);

        if (!isBillEmail && !isStatementWithBillInfo) continue;
        if (!result.cardLast4 || !result.dueDate) continue;

        const billAmount = result.amount || result.statementBalance || 0;
        const key = createBillKey(result.cardLast4, result.dueDate);
        if (billMap[key]) continue;

        const daysUntilDue = calculateDaysUntilDue(result.dueDate, today);
        const isManuallyPaid = paidKeys.includes(key);

        const cardPayments = payments[result.cardLast4] || [];
        const dueDateMs = parseDateToMs(result.dueDate);
        const matchingPayment = cardPayments.find((paymentDate) => {
          const paymentMs = parseDateToMs(paymentDate);
          if (isNaN(dueDateMs) || isNaN(paymentMs)) return false;
          const daysDiff = (paymentMs - dueDateMs) / (1000 * 60 * 60 * 24);
          return daysDiff >= -30 && daysDiff <= 60;
        });

        const autoPaid = !!matchingPayment;
        const isLikelyPaid = !isManuallyPaid && !autoPaid &&
          daysUntilDue < LIKELY_PAID_THRESHOLD_DAYS;
        const isPaid = isManuallyPaid || autoPaid || isLikelyPaid;

        let status: BillStatus;
        if (isLikelyPaid) status = "likely_paid";
        else if (isPaid) status = "paid";
        else if (daysUntilDue < 0) status = "overdue";
        else status = "unpaid";

        billMap[key] = {
          key,
          cardLast4: result.cardLast4,
          amount: demoPrice(billAmount, demoMode.get()),
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

      return Object.values(billMap).sort((a, b) =>
        a.daysUntilDue - b.daysUntilDue
      );
    });

    const unpaidBills = computed(() =>
      bills.filter((bill) => !bill.isPaid && !bill.isLikelyPaid)
    );
    const likelyPaidBills = computed(() =>
      bills.filter((bill) => bill.isLikelyPaid).sort((a, b) =>
        b.dueDate.localeCompare(a.dueDate)
      )
    );
    const paidBills = computed(() =>
      bills.filter((bill) => bill.isPaid && !bill.isLikelyPaid).sort((a, b) =>
        b.dueDate.localeCompare(a.dueDate)
      )
    );
    const totalUnpaid = computed(() =>
      unpaidBills.reduce((sum, bill) => sum + bill.amount, 0)
    );
    const overdueCount = computed(() =>
      unpaidBills.filter((bill) => bill.daysUntilDue < 0).length
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
            color: computed(() => overdueCount > 0 ? "#b91c1c" : "#1d4ed8"),
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
          <div style={{ fontWeight: "600", fontSize: "14px" }}>BofA Bills</div>
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
          <ProcessingStatus
            totalCount={extractor.emailCount}
            pendingCount={extractor.pendingCount}
            completedCount={extractor.completedCount}
          />
        </div>
      </div>
    );

    return {
      [NAME]: "BofA Bill Tracker",
      bills,
      unpaidBills,
      paidBills,
      totalUnpaid,
      overdueCount,
      previewUI,

      [UI]: (
        <ct-screen>
          <div slot="header">
            <ct-heading level={3}>Bank of America Bill Tracker</ct-heading>
          </div>

          <ct-vscroll flex showScrollbar>
            <ct-vstack padding="6" gap="4">
              {/* Auth UI from GmailExtractor */}
              {extractor.ui.authStatusUI}

              {/* Connection Status */}
              {extractor.ui.connectionStatusUI}

              {/* Analysis Status */}
              {extractor.ui.analysisProgressUI}

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
                    display: computed(() =>
                      overdueCount > 0 ? "block" : "none"
                    ),
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

              {/* Overdue Alert */}
              <div
                style={{
                  padding: "16px",
                  backgroundColor: "#fee2e2",
                  borderRadius: "12px",
                  border: "2px solid #ef4444",
                  display: computed(() => overdueCount > 0 ? "block" : "none"),
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
                  <span style={{ fontSize: "32px" }}>🚨</span>
                  <span
                    style={{
                      fontWeight: "700",
                      fontSize: "20px",
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
                    unpaidBills.length > 0 ? "block" : "none"
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
                        <div style={{ fontSize: "14px", color: "#92400e" }}>
                          Due in {bill.daysUntilDue} days -{" "}
                          {formatDate(bill.dueDate)}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={markAsPaid({ paidKeys: manuallyPaid, bill })}
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

              {/* Likely Paid Bills Section */}
              <div
                style={{
                  display: computed(() =>
                    likelyPaidBills.length > 0 ? "block" : "none"
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
                    Likely Paid ({computed(() => likelyPaidBills?.length || 0)})
                    <span
                      title="Bills over 45 days old with no detected payment are likely already paid"
                      style={{
                        fontSize: "14px",
                        color: "#9ca3af",
                        cursor: "help",
                        marginLeft: "8px",
                      }}
                    >
                      ⓘ
                    </span>
                  </summary>
                  <div
                    style={{
                      fontSize: "12px",
                      color: "#6b7280",
                      marginBottom: "12px",
                      fontStyle: "italic",
                    }}
                  >
                    Old bills without detected payment. Click "Confirm Paid" to
                    move to paid list.
                  </div>
                  <ct-vstack gap="2">
                    {likelyPaidBills.map((bill) => (
                      <div
                        style={{
                          display: "flex",
                          gap: "12px",
                          padding: "12px",
                          backgroundColor: "#d1fae5",
                          borderRadius: "8px",
                          border: "1px solid #10b981",
                          opacity: 0.9,
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
                          </div>
                          <div style={{ fontSize: "12px", color: "#047857" }}>
                            Was due: {formatDate(bill.dueDate)}{" "}
                            ({computed(() => Math.abs(bill.daysUntilDue ?? 0))}
                            {" "}
                            days ago)
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={markAsPaid({ paidKeys: manuallyPaid, bill })}
                          style={{
                            padding: "8px 14px",
                            backgroundColor: "#6b7280",
                            color: "white",
                            border: "none",
                            borderRadius: "6px",
                            cursor: "pointer",
                            fontSize: "13px",
                            fontWeight: "600",
                            alignSelf: "center",
                          }}
                        >
                          Confirm Paid
                        </button>
                      </div>
                    ))}
                  </ct-vstack>
                </details>
              </div>

              {/* Paid Bills Section */}
              <div
                style={{
                  display: computed(() =>
                    paidBills.length > 0 ? "block" : "none"
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
                              style={{ fontSize: "12px", color: "#059669" }}
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

              {/* BofA Website Link */}
              <div style={{ marginTop: "16px", textAlign: "center" }}>
                <a
                  href="https://www.bankofamerica.com/"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: "inline-block",
                    padding: "10px 20px",
                    backgroundColor: "#c51f23",
                    color: "white",
                    borderRadius: "8px",
                    textDecoration: "none",
                    fontWeight: "500",
                    fontSize: "14px",
                  }}
                >
                  Open Bank of America Website
                </a>
              </div>

              {/* Demo Mode Toggle */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "6px",
                  marginTop: "8px",
                }}
              >
                <ct-checkbox $checked={demoMode} />
                <span
                  style={{ fontSize: "11px", color: "#9ca3af" }}
                  title="Uses fake numbers for privacy"
                >
                  Demo mode
                </span>
              </div>
            </ct-vstack>
          </ct-vscroll>
        </ct-screen>
      ),
    };
  },
);
