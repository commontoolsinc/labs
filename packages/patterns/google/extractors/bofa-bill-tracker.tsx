/// <cts-enable />
/**
 * Bank of America Bill Tracker Pattern
 *
 * Tracks Bank of America credit card bills from email notifications, showing
 * unpaid/upcoming bills with payment status tracking.
 *
 * Features:
 * - Uses BillExtractor building block for data processing
 * - Uses "likely paid" heuristic for old bills (>45 days past due assumed paid)
 * - Supports manual "Mark as Paid" for local tracking
 * - Groups bills by card (last 4 digits)
 *
 * Usage:
 * 1. Deploy a google-auth piece and complete OAuth
 * 2. Deploy this pattern
 * 3. Link: ct piece link google-auth/auth bofa-bill-tracker/overrideAuth
 */
import {
  computed,
  Default,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
  Writable,
} from "commontools";
import BillExtractor, {
  type Auth,
  formatCurrency,
  formatDate,
  formatIdentifier,
  getIdentifierColor,
  processBills,
  type TrackedBill,
} from "../core/bill-extractor/index.tsx";

const BOFA_GMAIL_QUERY =
  "from:onlinebanking@ealerts.bankofamerica.com OR from:alerts@bankofamerica.com";

const BOFA_EXTRACTION_PROMPT =
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

2. For "identifier": extract the card's last 4 digits (e.g., "1234").
   Look for patterns like "ending in 1234", "...1234", or "card 1234".

3. Amount - the payment amount or bill amount (number only, no $ sign)

4. Due date - in YYYY-MM-DD format

5. Payment date - for payment confirmations, in YYYY-MM-DD format

6. Other details like minimum payment, statement balance, autopay status

7. Brief summary of what this email is about`;

// =============================================================================
// HANDLERS (module scope)
// =============================================================================

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
  overrideAuth?: Auth;
  manuallyPaid?: Writable<Default<string[], []>>;
  demoMode?: Writable<Default<boolean, true>>;
}

export default pattern<PatternInput>(
  ({ overrideAuth, manuallyPaid, demoMode }) => {
    // Use BillExtractor building block for data processing
    const tracker = BillExtractor({
      gmailQuery: BOFA_GMAIL_QUERY,
      extractionPrompt: BOFA_EXTRACTION_PROMPT,
      identifierType: "card",
      title: "Bank of America Bill Tracker",
      shortName: "BofA",
      brandColor: "#c51f23",
      websiteUrl: "https://www.bankofamerica.com/",
      overrideAuth,
      manuallyPaid,
      demoMode,
      // BofA doesn't send payment confirmation emails, so auto-detection isn't possible
      supportsAutoDetect: false,
    });

    // Create computed arrays in PATTERN scope (not building block scope)
    // This ensures closures in .map() can access pattern-scope variables like manuallyPaid
    const bills = computed(() => {
      // Use .get() to access Writable values inside computed
      const paidKeys = manuallyPaid?.get() || [];
      const isDemoMode = demoMode?.get() ?? true;
      return processBills(
        tracker.rawAnalyses || [],
        tracker.paymentConfirmations || {},
        paidKeys,
        isDemoMode,
      );
    });

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
      unpaidBills.reduce((sum, bill) => sum + (bill.amount || 0), 0)
    );

    const overdueCount = computed(() =>
      unpaidBills.filter((bill) => bill.status === "overdue").length
    );

    // UI components from building block
    const { title, ui } = tracker;

    return {
      [NAME]: "BofA Bill Tracker",
      bills: bills,
      unpaidBills: unpaidBills,
      paidBills: paidBills,
      totalUnpaid: totalUnpaid,
      overdueCount: overdueCount,
      previewUI: ui.previewUI,

      [UI]: (
        <ct-screen>
          <div slot="header">
            <ct-heading level={3}>{title}</ct-heading>
          </div>

          <ct-vscroll flex showScrollbar>
            <ct-vstack padding="6" gap="4">
              {/* Auth UI */}
              {ui.authStatusUI}

              {/* Connection Status */}
              {ui.connectionStatusUI}

              {/* Manual Tracking Banner (BofA doesn't send payment confirmation emails) */}
              {ui.manualTrackingBannerUI}

              {/* Analysis Status */}
              {ui.analysisProgressUI}

              {/* Summary Stats */}
              {ui.summaryStatsUI}

              {/* Overdue Alert */}
              {ui.overdueAlertUI}

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
                              backgroundColor: getIdentifierColor(
                                bill.identifier,
                              ),
                              borderRadius: "4px",
                              fontSize: "12px",
                              color: "white",
                              fontWeight: "500",
                            }}
                          >
                            {formatIdentifier(bill.identifier, "card")}
                          </span>
                        </div>
                        <div style={{ fontSize: "14px", color: "#92400e" }}>
                          Due in {bill.daysUntilDue} days -{" "}
                          {formatDate(bill.dueDate)}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={markAsPaid({ paidKeys: manuallyPaid!, bill })}
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
                    Likely Paid (
                    {computed(() => likelyPaidBills?.length || 0)})
                    <span
                      title="Bills over 45 days old with no detected payment are likely already paid"
                      style={{
                        fontSize: "14px",
                        color: "#9ca3af",
                        cursor: "help",
                        marginLeft: "8px",
                      }}
                    >
                      (i)
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
                                backgroundColor: getIdentifierColor(
                                  bill.identifier,
                                ),
                                borderRadius: "4px",
                                fontSize: "11px",
                                color: "white",
                                fontWeight: "500",
                              }}
                            >
                              {formatIdentifier(
                                bill.identifier,
                                tracker.identifierType,
                              )}
                            </span>
                          </div>
                          <div style={{ fontSize: "12px", color: "#047857" }}>
                            Was due: {formatDate(bill.dueDate)} (
                            {computed(() => Math.abs(bill.daysUntilDue ?? 0))}
                            {" "}
                            days ago)
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={markAsPaid({
                            paidKeys: manuallyPaid!,
                            bill,
                          })}
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
                    Paid Bills ({computed(() => paidBills?.length || 0)}
                    )
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
                                backgroundColor: getIdentifierColor(
                                  bill.identifier,
                                ),
                                borderRadius: "4px",
                                fontSize: "11px",
                                color: "white",
                                fontWeight: "500",
                              }}
                            >
                              {formatIdentifier(
                                bill.identifier,
                                tracker.identifierType,
                              )}
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
                            paidKeys: manuallyPaid!,
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

              {/* Website Link */}
              {ui.websiteLinkUI}

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
                <ct-checkbox $checked={demoMode!} />
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
