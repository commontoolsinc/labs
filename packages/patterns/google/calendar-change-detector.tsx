/// <cts-enable />
/**
 * Calendar Change Detector Pattern
 *
 * Monitors Gmail for last-minute cancellations, reschedules, and schedule changes
 * for calendar events. Shows urgent UI for changes within 48 hours, and only
 * displays if there are changes within the next 7 days.
 *
 * Features:
 * - Embeds gmail-importer directly for schedule-change emails
 * - Extracts change information using LLM from email markdown content
 * - Calculates urgency based on how soon the event is/was
 * - Conditional previewUI that only shows when there are relevant changes
 *
 * Usage:
 * 1. Deploy a google-auth charm and complete OAuth
 * 2. Deploy this pattern
 * 3. Link: ct charm link google-auth/auth calendar-change-detector/linkedAuth
 */
import {
  computed,
  generateObject,
  JSONSchema,
  NAME,
  pattern,
  UI,
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

type ChangeType =
  | "cancelled"
  | "rescheduled"
  | "delayed"
  | "time_changed"
  | "other";

type Urgency = "critical" | "urgent" | "normal";

interface ScheduleChange {
  id: string;
  emailId: string;
  emailDate: string;
  changeType: ChangeType;
  originalEvent: string; // What was scheduled
  originalDate?: string; // Original date/time (YYYY-MM-DD or YYYY-MM-DDTHH:mm)
  newDate?: string; // New date/time if rescheduled
  source: string; // Calendar service, company, etc.
  urgency: Urgency; // Critical=today/tomorrow, Urgent=48hrs, Normal=7days
  summary: string;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Gmail query to find schedule-change emails.
 * Combines subject keywords AND known sender addresses for maximum coverage.
 */
const SCHEDULE_CHANGE_GMAIL_QUERY =
  `(subject:cancelled OR subject:canceled OR subject:rescheduled OR subject:postponed OR subject:"has been changed" OR subject:"time changed" OR subject:"date changed" OR subject:"new date" OR subject:"new time" OR subject:delayed OR subject:"delivery update") OR from:calendar-notification@google.com OR from:notifications@calendly.com OR from:fedex.com OR from:ups.com OR from:amazon.com OR from:notices@library.berkeleypubliclibrary.org`;

// Schema for LLM email analysis
const SCHEDULE_CHANGE_SCHEMA = {
  type: "object",
  properties: {
    isScheduleChange: {
      type: "boolean",
      description:
        "Whether this email is about a schedule change (cancellation, reschedule, delay, etc.). Set to false for marketing, promotions, unrelated notifications, or spam.",
    },
    changeType: {
      type: "string",
      enum: ["cancelled", "rescheduled", "delayed", "time_changed", "other"],
      description:
        "Type of schedule change: cancelled for cancellations, rescheduled for date/time changes, delayed for deliveries/appointments pushed back, time_changed for minor time adjustments, other for unclear changes",
    },
    originalEvent: {
      type: "string",
      description:
        "Brief description of what was scheduled (e.g., 'Dentist appointment', 'FedEx package delivery', 'Meeting with John')",
    },
    originalDate: {
      type: "string",
      description:
        "Original scheduled date/time in ISO format (YYYY-MM-DD or YYYY-MM-DDTHH:mm). Extract from the email if mentioned.",
    },
    newDate: {
      type: "string",
      description:
        "New scheduled date/time in ISO format if rescheduled. Leave empty if cancelled or not mentioned.",
    },
    source: {
      type: "string",
      description:
        "The service, company, or person who sent the notification (e.g., 'Google Calendar', 'Calendly', 'FedEx', 'Dr. Smith's Office')",
    },
    summary: {
      type: "string",
      description:
        "Brief one-sentence summary of the change (e.g., 'Your dentist appointment on Jan 15 has been cancelled')",
    },
  },
  required: ["isScheduleChange", "changeType", "summary"],
} as const satisfies JSONSchema;

type ScheduleChangeAnalysisResult = Schema<typeof SCHEDULE_CHANGE_SCHEMA>;

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Parse a date string to a Date object.
 * Handles both YYYY-MM-DD and YYYY-MM-DDTHH:mm formats.
 */
function parseDate(dateStr: string | undefined): Date | null {
  if (!dateStr) return null;

  // Try ISO datetime format
  const dtMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (dtMatch) {
    const [, year, month, day, hour, minute] = dtMatch;
    return new Date(
      parseInt(year),
      parseInt(month) - 1,
      parseInt(day),
      parseInt(hour),
      parseInt(minute),
    );
  }

  // Try date-only format
  const dMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (dMatch) {
    const [, year, month, day] = dMatch;
    return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
  }

  return null;
}

/**
 * Calculate days until a date.
 * Returns negative number for past dates.
 */
function calculateDaysUntil(
  dateStr: string | undefined,
  referenceDate: Date,
): number {
  const date = parseDate(dateStr);
  if (!date) return 999;

  // Normalize to start of day for comparison
  const ref = new Date(referenceDate);
  ref.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);

  return Math.ceil((date.getTime() - ref.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Determine urgency based on days until event.
 */
function calculateUrgency(daysUntil: number): Urgency {
  if (daysUntil <= 1) return "critical"; // Today or tomorrow
  if (daysUntil <= 2) return "urgent"; // Within 48 hours
  return "normal"; // Within 7 days
}

/**
 * Format date for display.
 */
function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return "N/A";
  const date = parseDate(dateStr);
  if (!date) return dateStr;

  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: dateStr.includes("T") ? "numeric" : undefined,
    minute: dateStr.includes("T") ? "2-digit" : undefined,
  });
}

// =============================================================================
// PATTERN
// =============================================================================

interface PatternInput {
  linkedAuth?: Auth;
}

/** Calendar change detector for tracking schedule changes. #calendarChanges */
interface PatternOutput {
  changes: ScheduleChange[];
  criticalChanges: ScheduleChange[];
  urgentChanges: ScheduleChange[];
  normalChanges: ScheduleChange[];
  hasChanges: boolean;
  previewUI: unknown;
}

export default pattern<PatternInput, PatternOutput>(({ linkedAuth }) => {
  // Directly instantiate GmailImporter with schedule-change query
  const gmailImporter = GmailImporter({
    settings: {
      gmailFilterQuery: SCHEDULE_CHANGE_GMAIL_QUERY,
      autoFetchOnAuth: true,
      resolveInlineImages: false,
      limit: 50,
      debugMode: false,
    },
    linkedAuth,
  });

  // Get emails directly from the embedded gmail-importer
  const allEmails = gmailImporter.emails;

  // Count of emails found
  const emailCount = computed(() => allEmails?.length || 0);

  // Check if connected
  const isConnected = computed(() => {
    if (linkedAuth?.token) return true;
    return gmailImporter?.emailCount !== undefined;
  });

  // ==========================================================================
  // REACTIVE LLM ANALYSIS
  // Analyze each email to extract schedule change information
  // ==========================================================================

  const emailAnalyses = allEmails.map((email: Email) => {
    const analysis = generateObject<ScheduleChangeAnalysisResult>({
      prompt: computed(() => {
        if (!email?.markdownContent) {
          return undefined;
        }

        return `Analyze this email and determine if it's about a schedule change (cancellation, reschedule, delay, etc.).

EMAIL SUBJECT: ${email.subject || ""}
EMAIL DATE: ${email.date || ""}
EMAIL FROM: ${email.from || ""}

EMAIL CONTENT:
${email.markdownContent}

Determine:
1. Is this a legitimate schedule change notification?
   - YES: Appointment cancellations, meeting reschedules, delivery delays, event time changes
   - NO: Marketing emails, promotional offers, subscription notices, spam, newsletters, order confirmations without changes

2. If it IS a schedule change:
   - What type of change is it? (cancelled, rescheduled, delayed, time_changed)
   - What event/appointment/delivery was affected?
   - What was the original date/time? (in YYYY-MM-DD or YYYY-MM-DDTHH:mm format)
   - What is the new date/time if applicable?
   - Who/what service sent this notification?
   - Provide a brief summary

IMPORTANT: Be strict about filtering. Only mark as a schedule change if it's clearly about an existing appointment, meeting, delivery, or event being modified. Ignore marketing, promotions, and general notifications.`;
      }),
      schema: SCHEDULE_CHANGE_SCHEMA,
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
      emailAnalyses?.filter(
        (a) =>
          a?.analysis?.pending === false && a?.analysis?.result !== undefined,
      ).length || 0,
  );

  // ==========================================================================
  // SCHEDULE CHANGE TRACKING
  // Process analyses and build change list
  // ==========================================================================

  const changes = computed(() => {
    const changeList: ScheduleChange[] = [];

    // Create a single reference date for ALL calculations
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Seven days from now
    const sevenDaysFromNow = new Date(today);
    sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);

    for (const analysisItem of emailAnalyses || []) {
      const result = analysisItem.result;
      if (!result) continue;

      // Skip if not a schedule change
      if (!result.isScheduleChange) continue;

      // Determine the relevant date (original date for cancellations, new date for reschedules)
      const relevantDate = result.changeType === "cancelled" ||
          result.changeType === "other"
        ? result.originalDate
        : result.newDate || result.originalDate;

      // Calculate days until the relevant date
      const daysUntil = calculateDaysUntil(relevantDate, today);

      // Only include changes affecting the next 7 days (or recent past events within 2 days)
      if (daysUntil > 7 || daysUntil < -2) continue;

      const urgency = calculateUrgency(daysUntil);

      const change: ScheduleChange = {
        id: analysisItem.emailId,
        emailId: analysisItem.emailId,
        emailDate: analysisItem.emailDate,
        changeType: result.changeType as ChangeType,
        originalEvent: result.originalEvent || "Unknown event",
        originalDate: result.originalDate,
        newDate: result.newDate,
        source: result.source || "Unknown source",
        urgency,
        summary: result.summary,
      };

      changeList.push(change);
    }

    // Sort by urgency (critical first) then by date
    return changeList.sort((a, b) => {
      const urgencyOrder = { critical: 0, urgent: 1, normal: 2 };
      const urgencyDiff = urgencyOrder[a.urgency] - urgencyOrder[b.urgency];
      if (urgencyDiff !== 0) return urgencyDiff;

      // Within same urgency, sort by original date
      const dateA = parseDate(a.originalDate)?.getTime() || 0;
      const dateB = parseDate(b.originalDate)?.getTime() || 0;
      return dateA - dateB;
    });
  });

  // Filter by urgency level
  const criticalChanges = computed(() =>
    changes.filter((c) => c.urgency === "critical")
  );

  const urgentChanges = computed(() =>
    changes.filter((c) => c.urgency === "urgent")
  );

  const normalChanges = computed(() =>
    changes.filter((c) => c.urgency === "normal")
  );

  // Has any changes
  const hasChanges = computed(() => changes.length > 0);

  // Get the most urgent change for preview
  const mostUrgentChange = computed(() => {
    if (criticalChanges.length > 0) return criticalChanges[0];
    if (urgentChanges.length > 0) return urgentChanges[0];
    if (normalChanges.length > 0) return normalChanges[0];
    return null;
  });

  // Preview UI - always renders, shows "All clear" when no changes
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
          backgroundColor: computed(() => {
            if (!hasChanges) return "#d1fae5"; // Green for all clear
            if (criticalChanges.length > 0) return "#fee2e2";
            if (urgentChanges.length > 0) return "#fef3c7";
            return "#eff6ff";
          }),
          border: computed(() => {
            if (!hasChanges) return "2px solid #10b981";
            if (criticalChanges.length > 0) return "2px solid #ef4444";
            if (urgentChanges.length > 0) return "2px solid #f59e0b";
            return "2px solid #3b82f6";
          }),
          color: computed(() => {
            if (!hasChanges) return "#059669";
            if (criticalChanges.length > 0) return "#b91c1c";
            if (urgentChanges.length > 0) return "#92400e";
            return "#1d4ed8";
          }),
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontWeight: "bold",
          fontSize: "16px",
        }}
      >
        {computed(() => (hasChanges ? changes?.length || 0 : "✓"))}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: "600", fontSize: "14px" }}>
          {computed(() => {
            if (!hasChanges) return "Schedule: All Clear";
            const critical = criticalChanges?.length || 0;
            const urgent = urgentChanges?.length || 0;
            if (critical > 0) {
              return `${critical} Critical Change${critical !== 1 ? "s" : ""}!`;
            }
            if (urgent > 0) {
              return `${urgent} Urgent Change${urgent !== 1 ? "s" : ""}`;
            }
            return `${changes?.length || 0} Schedule Change${
              (changes?.length || 0) !== 1 ? "s" : ""
            }`;
          })}
        </div>
        <div
          style={{
            fontSize: "12px",
            color: "#6b7280",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {computed(() => {
            if (!hasChanges) return "No changes in next 7 days";
            const change = mostUrgentChange;
            if (!change) return "";
            return `${change.changeType}: ${change.originalEvent}`;
          })}
        </div>
      </div>
    </div>
  );

  return {
    [NAME]: "Calendar Change Detector",

    changes,
    criticalChanges,
    urgentChanges,
    normalChanges,
    hasChanges,
    previewUI,

    [UI]: (
      <ct-screen>
        <div slot="header">
          <ct-heading level={3}>Calendar Change Detector</ct-heading>
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

            {/* Analysis Status */}
            <div
              style={{
                padding: "12px 16px",
                backgroundColor: "#eff6ff",
                borderRadius: "8px",
                border: "1px solid #3b82f6",
                display: computed(() => (isConnected ? "block" : "none")),
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
                    color: computed(() => {
                      if (criticalChanges.length > 0) return "#dc2626";
                      if (urgentChanges.length > 0) return "#f59e0b";
                      return "#3b82f6";
                    }),
                  }}
                >
                  {computed(() => changes?.length || 0)}
                </div>
                <div style={{ fontSize: "12px", color: "#666" }}>
                  Total Changes
                </div>
              </div>
              <div
                style={{
                  borderLeft: "1px solid #d1d5db",
                  paddingLeft: "16px",
                  display: computed(() =>
                    criticalChanges.length > 0 ? "block" : "none"
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
                  {computed(() => criticalChanges?.length || 0)}
                </div>
                <div style={{ fontSize: "12px", color: "#666" }}>Critical</div>
              </div>
              <div
                style={{
                  borderLeft: "1px solid #d1d5db",
                  paddingLeft: "16px",
                  display: computed(() =>
                    urgentChanges.length > 0 ? "block" : "none"
                  ),
                }}
              >
                <div
                  style={{
                    fontSize: "28px",
                    fontWeight: "bold",
                    color: "#f59e0b",
                  }}
                >
                  {computed(() => urgentChanges?.length || 0)}
                </div>
                <div style={{ fontSize: "12px", color: "#666" }}>Urgent</div>
              </div>
            </div>

            {/* No Changes Message */}
            <div
              style={{
                padding: "24px",
                backgroundColor: "#d1fae5",
                borderRadius: "12px",
                textAlign: "center",
                display: computed(() =>
                  !hasChanges && completedCount > 0 ? "block" : "none"
                ),
              }}
            >
              <div style={{ fontSize: "32px", marginBottom: "8px" }}>
                All clear!
              </div>
              <div style={{ fontSize: "16px", color: "#059669" }}>
                No schedule changes affecting the next 7 days.
              </div>
            </div>

            {/* Critical Changes Section */}
            <div
              style={{
                display: computed(() =>
                  criticalChanges.length > 0 ? "block" : "none"
                ),
              }}
            >
              <div
                style={{
                  padding: "16px",
                  backgroundColor: "#fee2e2",
                  borderRadius: "12px",
                  border: "2px solid #ef4444",
                  marginBottom: "16px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "12px",
                    marginBottom: "12px",
                  }}
                >
                  <span style={{ fontSize: "24px" }}>!</span>
                  <span
                    style={{
                      fontWeight: "700",
                      fontSize: "18px",
                      color: "#b91c1c",
                    }}
                  >
                    Critical - Today/Tomorrow
                  </span>
                </div>
                <ct-vstack gap="3">
                  {criticalChanges.map((change) => (
                    <div
                      style={{
                        padding: "12px",
                        backgroundColor: "white",
                        borderRadius: "8px",
                        border: "1px solid #fecaca",
                      }}
                    >
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
                            padding: "2px 8px",
                            backgroundColor: "#dc2626",
                            borderRadius: "4px",
                            fontSize: "11px",
                            color: "white",
                            fontWeight: "600",
                            textTransform: "uppercase",
                          }}
                        >
                          {change.changeType}
                        </span>
                        <span
                          style={{
                            fontSize: "12px",
                            color: "#6b7280",
                          }}
                        >
                          {change.source}
                        </span>
                      </div>
                      <div
                        style={{
                          fontWeight: "600",
                          fontSize: "16px",
                          marginBottom: "4px",
                        }}
                      >
                        {change.originalEvent}
                      </div>
                      <div style={{ fontSize: "14px", color: "#4b5563" }}>
                        {change.summary}
                      </div>
                      <div
                        style={{
                          fontSize: "12px",
                          color: "#6b7280",
                          marginTop: "8px",
                        }}
                      >
                        {computed(() => {
                          if (
                            change.changeType === "rescheduled" &&
                            change.newDate
                          ) {
                            return `${formatDate(change.originalDate)} → ${
                              formatDate(change.newDate)
                            }`;
                          }
                          return formatDate(change.originalDate);
                        })}
                      </div>
                    </div>
                  ))}
                </ct-vstack>
              </div>
            </div>

            {/* Urgent Changes Section */}
            <div
              style={{
                display: computed(() =>
                  urgentChanges.length > 0 ? "block" : "none"
                ),
              }}
            >
              <div
                style={{
                  padding: "16px",
                  backgroundColor: "#fef3c7",
                  borderRadius: "12px",
                  border: "2px solid #f59e0b",
                  marginBottom: "16px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "12px",
                    marginBottom: "12px",
                  }}
                >
                  <span style={{ fontSize: "24px" }}>!</span>
                  <span
                    style={{
                      fontWeight: "700",
                      fontSize: "18px",
                      color: "#92400e",
                    }}
                  >
                    Urgent - Within 48 Hours
                  </span>
                </div>
                <ct-vstack gap="3">
                  {urgentChanges.map((change) => (
                    <div
                      style={{
                        padding: "12px",
                        backgroundColor: "white",
                        borderRadius: "8px",
                        border: "1px solid #fde68a",
                      }}
                    >
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
                            padding: "2px 8px",
                            backgroundColor: "#f59e0b",
                            borderRadius: "4px",
                            fontSize: "11px",
                            color: "white",
                            fontWeight: "600",
                            textTransform: "uppercase",
                          }}
                        >
                          {change.changeType}
                        </span>
                        <span
                          style={{
                            fontSize: "12px",
                            color: "#6b7280",
                          }}
                        >
                          {change.source}
                        </span>
                      </div>
                      <div
                        style={{
                          fontWeight: "600",
                          fontSize: "16px",
                          marginBottom: "4px",
                        }}
                      >
                        {change.originalEvent}
                      </div>
                      <div style={{ fontSize: "14px", color: "#4b5563" }}>
                        {change.summary}
                      </div>
                      <div
                        style={{
                          fontSize: "12px",
                          color: "#6b7280",
                          marginTop: "8px",
                        }}
                      >
                        {computed(() => {
                          if (
                            change.changeType === "rescheduled" &&
                            change.newDate
                          ) {
                            return `${formatDate(change.originalDate)} → ${
                              formatDate(change.newDate)
                            }`;
                          }
                          return formatDate(change.originalDate);
                        })}
                      </div>
                    </div>
                  ))}
                </ct-vstack>
              </div>
            </div>

            {/* Normal Changes Section */}
            <div
              style={{
                display: computed(() =>
                  normalChanges.length > 0 ? "block" : "none"
                ),
              }}
            >
              <div
                style={{
                  padding: "16px",
                  backgroundColor: "#eff6ff",
                  borderRadius: "12px",
                  border: "2px solid #3b82f6",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "12px",
                    marginBottom: "12px",
                  }}
                >
                  <span style={{ fontSize: "24px" }}>i</span>
                  <span
                    style={{
                      fontWeight: "700",
                      fontSize: "18px",
                      color: "#1d4ed8",
                    }}
                  >
                    Upcoming - Within 7 Days
                  </span>
                </div>
                <ct-vstack gap="3">
                  {normalChanges.map((change) => (
                    <div
                      style={{
                        padding: "12px",
                        backgroundColor: "white",
                        borderRadius: "8px",
                        border: "1px solid #bfdbfe",
                      }}
                    >
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
                            padding: "2px 8px",
                            backgroundColor: "#3b82f6",
                            borderRadius: "4px",
                            fontSize: "11px",
                            color: "white",
                            fontWeight: "600",
                            textTransform: "uppercase",
                          }}
                        >
                          {change.changeType}
                        </span>
                        <span
                          style={{
                            fontSize: "12px",
                            color: "#6b7280",
                          }}
                        >
                          {change.source}
                        </span>
                      </div>
                      <div
                        style={{
                          fontWeight: "600",
                          fontSize: "16px",
                          marginBottom: "4px",
                        }}
                      >
                        {change.originalEvent}
                      </div>
                      <div style={{ fontSize: "14px", color: "#4b5563" }}>
                        {change.summary}
                      </div>
                      <div
                        style={{
                          fontSize: "12px",
                          color: "#6b7280",
                          marginTop: "8px",
                        }}
                      >
                        {computed(() => {
                          if (
                            change.changeType === "rescheduled" &&
                            change.newDate
                          ) {
                            return `${formatDate(change.originalDate)} → ${
                              formatDate(change.newDate)
                            }`;
                          }
                          return formatDate(change.originalDate);
                        })}
                      </div>
                    </div>
                  ))}
                </ct-vstack>
              </div>
            </div>

            {/* Debug View Section */}
            <div
              style={{
                marginTop: "24px",
                padding: "16px",
                backgroundColor: "#f9fafb",
                borderRadius: "8px",
                border: "1px solid #d1d5db",
                display: computed(() => (emailCount > 0 ? "block" : "none")),
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
                  Debug View ({computed(() => emailCount)} emails)
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
                    Fetched Emails:
                  </h4>
                  <ct-vstack gap="2">
                    {allEmails.map((email: Email) => (
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
                          From: {email.from} | Date: {email.date}
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
                              : analysis.result?.isScheduleChange
                              ? "1px solid #10b981"
                              : "1px solid #d1d5db"
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
                          Error:{" "}
                          {computed(() =>
                            analysis.error ? String(analysis.error) : ""
                          )}
                        </div>

                        <div
                          style={{
                            display: computed(() =>
                              !analysis.pending &&
                                !analysis.error &&
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
                              backgroundColor: computed(() =>
                                analysis.result?.isScheduleChange
                                  ? "#d1fae5"
                                  : "#f3f4f6"
                              ),
                              borderRadius: "4px",
                            }}
                          >
                            <div style={{ color: "#374151" }}>
                              <strong>Is Schedule Change:</strong>{" "}
                              {computed(() =>
                                analysis.result?.isScheduleChange ? "Yes" : "No"
                              )}
                            </div>
                            <div
                              style={{
                                color: "#374151",
                                marginTop: "4px",
                                display: computed(() =>
                                  analysis.result?.isScheduleChange
                                    ? "block"
                                    : "none"
                                ),
                              }}
                            >
                              <strong>Type:</strong>{" "}
                              {computed(() =>
                                analysis.result?.changeType || "N/A"
                              )}
                            </div>
                            <div
                              style={{
                                color: "#374151",
                                marginTop: "4px",
                                display: computed(() =>
                                  analysis.result?.isScheduleChange
                                    ? "block"
                                    : "none"
                                ),
                              }}
                            >
                              <strong>Event:</strong>{" "}
                              {computed(() =>
                                analysis.result?.originalEvent || "N/A"
                              )}
                            </div>
                            <div
                              style={{
                                color: "#374151",
                                marginTop: "4px",
                                display: computed(() =>
                                  analysis.result?.isScheduleChange
                                    ? "block"
                                    : "none"
                                ),
                              }}
                            >
                              <strong>Original Date:</strong>{" "}
                              {computed(() =>
                                formatDate(analysis.result?.originalDate)
                              )}
                            </div>
                            <div style={{ color: "#374151", marginTop: "4px" }}>
                              <strong>Summary:</strong>{" "}
                              {computed(() =>
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
          </ct-vstack>
        </ct-vscroll>
      </ct-screen>
    ),
  };
});
