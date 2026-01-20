/// <cts-enable />
/**
 * BAM School Dashboard Pattern
 *
 * An intelligent school dashboard that extracts structured data from school emails,
 * highlights special events requiring action, and displays upcoming dates.
 *
 * Features:
 * - LLM-powered extraction of events from school emails
 * - Prioritizes teacher messages over general announcements
 * - Highlights urgent items (field trips, deadlines, awards)
 * - Upcoming events timeline view
 * - Dismissable items with persistent state
 *
 * Usage:
 * 1. Deploy a google-auth charm and complete OAuth
 * 2. Deploy this pattern
 * 3. Link: ct charm link google-auth/auth bam-school-dashboard/linkedAuth
 */
import {
  computed,
  Default,
  generateObject,
  handler,
  JSONSchema,
  NAME,
  pattern,
  UI,
  Writable,
} from "commontools";
import type { Schema } from "commontools/schema";
import GmailImporter, { type Auth, type Email } from "./gmail-importer.tsx";

// =============================================================================
// TYPES
// =============================================================================

interface SchoolSettings {
  childName: Default<string, "Adeline Komoroske">;
  schoolName: Default<string, "Berkeley Arts Magnet">;
  grade: Default<string, "Kindergarten">;
  teacher: Default<string, "Mr. Zaragoza">;
}

type EventCategory =
  | "field_trip"
  | "award"
  | "deadline"
  | "no_school"
  | "event"
  | "announcement"
  | "attendance"
  | "other";

type SourceType = "teacher" | "school" | "district" | "coordinator";

interface SchoolEvent {
  id: string; // Email ID for deduplication
  category: EventCategory;
  title: string;
  date?: string; // ISO YYYY-MM-DD
  time?: string; // e.g., "10:00 AM"
  actionRequired?: string; // "Bring bagged lunch", "Sign form"
  isUrgent: boolean;
  summary: string;
  sourceType: SourceType;
  sourceEmail: string;
  emailDate: string;
  originalSubject: string;
}

// Schema for LLM event extraction
const SCHOOL_EVENT_SCHEMA = {
  type: "object",
  properties: {
    category: {
      type: "string",
      enum: [
        "field_trip",
        "award",
        "deadline",
        "no_school",
        "event",
        "announcement",
        "attendance",
        "other",
      ],
      description:
        "Category: field_trip for outings/excursions, award for recognition/coyote awards, deadline for forms/registration due, no_school for holidays/breaks, event for assemblies/gatherings, announcement for general info, attendance for absence-related, other for misc",
    },
    title: {
      type: "string",
      description:
        "Concise event title (e.g., 'Tilden Park Hike', 'Coyote Award', 'Picture Day')",
    },
    date: {
      type: "string",
      description:
        "Event date in ISO format YYYY-MM-DD if mentioned (parse dates like 'January 15' or 'next Wednesday')",
    },
    time: {
      type: "string",
      description:
        "Event time if mentioned (e.g., '10:00 AM', '9:00-11:00 AM')",
    },
    actionRequired: {
      type: "string",
      description:
        "Action needed from parent if any (e.g., 'Bring bagged lunch', 'Sign permission slip', 'RSVP by Friday')",
    },
    isUrgent: {
      type: "boolean",
      description:
        "True if: event is within 7 days, action is required soon, or it's time-sensitive (awards, field trips)",
    },
    summary: {
      type: "string",
      description:
        "Brief 1-2 sentence summary of what parents need to know from this email",
    },
  },
  required: ["category", "title", "isUrgent", "summary"],
} as const satisfies JSONSchema;

type SchoolEventResult = Schema<typeof SCHOOL_EVENT_SCHEMA>;

// =============================================================================
// CONSTANTS
// =============================================================================

// Category display info
const CATEGORY_INFO: Record<
  EventCategory,
  { label: string; icon: string; color: string }
> = {
  field_trip: { label: "Field Trip", icon: "🥾", color: "#059669" },
  award: { label: "Award", icon: "🏆", color: "#d97706" },
  deadline: { label: "Deadline", icon: "📋", color: "#dc2626" },
  no_school: { label: "No School", icon: "🏠", color: "#6366f1" },
  event: { label: "Event", icon: "📅", color: "#8b5cf6" },
  announcement: { label: "News", icon: "📢", color: "#3b82f6" },
  attendance: { label: "Attendance", icon: "✓", color: "#6b7280" },
  other: { label: "Other", icon: "📌", color: "#9ca3af" },
};

// Source type display info
const SOURCE_INFO: Record<SourceType, { label: string; priority: number }> = {
  teacher: { label: "Teacher", priority: 1 },
  coordinator: { label: "Class Coordinator", priority: 2 },
  school: { label: "School", priority: 3 },
  district: { label: "District", priority: 4 },
};

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Classify email source based on sender address
 */
function classifySource(from: string): SourceType {
  const fromLower = from.toLowerCase();

  // Teacher - Mr. Zaragoza
  if (fromLower.includes("zaragoza") || fromLower.includes("jacobzaragoza")) {
    return "teacher";
  }

  // Class coordinator
  if (fromLower.includes("gracelee06")) {
    return "coordinator";
  }

  // District level
  if (
    fromLower.includes("superintendent") ||
    fromLower.includes("busd") ||
    (fromLower.includes("berkeley.net") &&
      !fromLower.includes("bam") &&
      !fromLower.includes("zaragoza"))
  ) {
    return "district";
  }

  // Default to school
  return "school";
}

/**
 * Calculate days until a date (negative if past)
 */
function daysUntil(dateStr: string | undefined, referenceDate: Date): number {
  if (!dateStr) return 999;

  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return 999;

  const [, year, month, day] = match;
  const targetDate = new Date(
    parseInt(year),
    parseInt(month) - 1,
    parseInt(day),
  );

  if (isNaN(targetDate.getTime())) return 999;

  targetDate.setHours(0, 0, 0, 0);
  return Math.ceil(
    (targetDate.getTime() - referenceDate.getTime()) / (1000 * 60 * 60 * 24),
  );
}

/**
 * Format date for display
 */
function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return "";
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/**
 * Get relative date label (Today, Tomorrow, This Week, etc.)
 */
function getDateLabel(days: number): string {
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days < 0) return `${Math.abs(days)} days ago`;
  if (days <= 7) return `In ${days} days`;
  if (days <= 14) return "Next week";
  if (days <= 30) return "This month";
  return "Upcoming";
}

/**
 * Get urgency color based on days until event
 */
function getUrgencyColor(days: number, isUrgent: boolean): string {
  if (days < 0) return "#9ca3af"; // Past - gray
  if (isUrgent || days <= 2) return "#dc2626"; // Urgent - red
  if (days <= 7) return "#f59e0b"; // Soon - amber
  return "#3b82f6"; // Normal - blue
}

// =============================================================================
// HANDLERS
// =============================================================================

// Handler to dismiss an event
const dismissEvent = handler<
  unknown,
  { dismissedIds: Writable<string[]>; eventId: string }
>((_event, { dismissedIds, eventId }) => {
  const current = dismissedIds.get() || [];
  if (!current.includes(eventId)) {
    dismissedIds.set([...current, eventId]);
  }
});

// Handler to restore a dismissed event
const restoreEvent = handler<
  unknown,
  { dismissedIds: Writable<string[]>; eventId: string }
>((_event, { dismissedIds, eventId }) => {
  const current = dismissedIds.get() || [];
  dismissedIds.set(current.filter((id: string) => id !== eventId));
});

// =============================================================================
// PATTERN
// =============================================================================

interface PatternInput {
  settings: Default<
    SchoolSettings,
    {
      childName: "Adeline Komoroske";
      schoolName: "Berkeley Arts Magnet";
      grade: "Kindergarten";
      teacher: "Mr. Zaragoza";
    }
  >;
  dismissedIds: Writable<Default<string[], []>>;
  linkedAuth?: Auth;
}

/** BAM School Dashboard - At-a-glance view of school events and announcements. #bamSchool */
interface PatternOutput {
  emails: Email[];
  events: SchoolEvent[];
  urgentEvents: SchoolEvent[];
  upcomingEvents: SchoolEvent[];
  teacherMessages: SchoolEvent[];
  previewUI: unknown;
}

export default pattern<PatternInput, PatternOutput>(
  ({ settings, dismissedIds, linkedAuth }) => {
    // Build Gmail query to find BAM school emails
    // Excludes fundraising emails (schoolsfund.berkeley.net)
    const gmailQuery = computed(() => {
      return `(from:bamannouncements OR from:bamattendance OR from:mail.remind.com OR from:homeroom.com OR from:gracelee06 OR from:zaragoza OR from:berkeley.net OR subject:"Berkeley Arts Magnet" OR subject:"BAM ") -from:schoolsfund.berkeley.net`;
    });

    // Directly instantiate GmailImporter with school-specific settings
    const gmailImporter = GmailImporter({
      settings: {
        gmailFilterQuery: gmailQuery,
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
    // LLM ANALYSIS
    // Analyze each email to extract school event information
    // ==========================================================================

    const emailAnalyses = allEmails.map((email: Email) => {
      const sourceType = computed(() => classifySource(email.from || ""));

      const analysis = generateObject<SchoolEventResult>({
        prompt: computed(() => {
          if (!email?.markdownContent) {
            return undefined;
          }

          const source = sourceType;
          return `Analyze this school email and extract event/announcement information.

EMAIL FROM: ${email.from || ""}
SUBJECT: ${email.subject || ""}
DATE: ${email.date || ""}
SOURCE TYPE: ${source} (${SOURCE_INFO[source as SourceType].label})

EMAIL CONTENT:
${email.markdownContent}

Extract:
1. Category: field_trip (outings), award (recognition/coyote awards), deadline (forms due), no_school (holidays), event (assemblies/gatherings), announcement (general news), attendance (absence-related), other

2. Title: Concise name for this item (e.g., "Tilden Park Hike", "Coyote Award Ceremony", "Picture Day")

3. Date: If a specific date is mentioned, format as YYYY-MM-DD. Parse relative dates based on the email date.

4. Time: If mentioned (e.g., "10:00 AM")

5. Action Required: What does the parent need to do? (e.g., "Bring bagged lunch", "Sign permission slip by Friday", "RSVP")

6. Is Urgent: True if within 7 days, action required, or time-sensitive

7. Summary: 1-2 sentences of what parents need to know`;
        }),
        schema: SCHOOL_EVENT_SCHEMA,
        model: "anthropic:claude-haiku-4-5",
      });

      const emailDate = computed(() => email.date || "");

      return {
        email,
        emailId: email.id as string,
        emailDate,
        sourceType,
        analysis,
        pending: analysis.pending,
        error: analysis.error,
        result: analysis.result,
      };
    });

    // Count pending/completed analyses
    const pendingCount = computed(
      () => emailAnalyses?.filter((a) => a?.pending)?.length || 0,
    );
    const completedCount = computed(
      () =>
        emailAnalyses?.filter(
          (a) => a?.analysis?.pending === false && a?.analysis?.result,
        )?.length || 0,
    );

    // ==========================================================================
    // EVENT PROCESSING
    // Build structured events from LLM analysis results
    // ==========================================================================

    const allEvents = computed(() => {
      const events: SchoolEvent[] = [];
      const dismissed = new Set(dismissedIds.get() || []);

      for (const analysisItem of emailAnalyses || []) {
        const result = analysisItem.result;
        if (!result) continue;

        // Skip dismissed events
        if (dismissed.has(analysisItem.emailId)) continue;

        const event: SchoolEvent = {
          id: analysisItem.emailId,
          category: (result.category as EventCategory) || "other",
          title: result.title || analysisItem.email.subject || "Untitled",
          date: result.date,
          time: result.time,
          actionRequired: result.actionRequired,
          isUrgent: result.isUrgent || false,
          summary: result.summary || "",
          sourceType: analysisItem.sourceType,
          sourceEmail: analysisItem.email.from || "",
          emailDate: analysisItem.emailDate,
          originalSubject: analysisItem.email.subject || "",
        };

        events.push(event);
      }

      // Sort by: urgent first, then by date (soonest first), then by source priority
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      return events.sort((a, b) => {
        // Urgent items first
        if (a.isUrgent !== b.isUrgent) return a.isUrgent ? -1 : 1;

        // Then by date (soonest first)
        const daysA = daysUntil(a.date, today);
        const daysB = daysUntil(b.date, today);
        if (daysA !== daysB) return daysA - daysB;

        // Then by source priority (teacher first)
        return (
          SOURCE_INFO[a.sourceType].priority -
          SOURCE_INFO[b.sourceType].priority
        );
      });
    });

    // Filter events by category/criteria
    const urgentEvents = computed(() => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      return allEvents.filter((e) => {
        const days = daysUntil(e.date, today);
        // Urgent if: marked urgent, has action required, or is within 7 days
        return (
          e.isUrgent ||
          e.actionRequired ||
          (days >= 0 && days <= 7) ||
          e.category === "field_trip" ||
          e.category === "deadline"
        );
      });
    });

    const upcomingEvents = computed(() => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      return allEvents
        .filter((e) => {
          if (!e.date) return false;
          const days = daysUntil(e.date, today);
          return days >= 0 && days <= 30;
        })
        .sort((a, b) => {
          const daysA = daysUntil(a.date, today);
          const daysB = daysUntil(b.date, today);
          return daysA - daysB;
        });
    });

    const teacherMessages = computed(() =>
      allEvents.filter((e) => e.sourceType === "teacher")
    );

    // Counts for UI
    const urgentCount = computed(() => urgentEvents?.length || 0);
    const dismissedCount = computed(() => (dismissedIds.get() || []).length);

    // Get next upcoming event for preview
    const nextEvent = computed(() => {
      const upcoming = upcomingEvents;
      return upcoming?.length > 0 ? upcoming[0] : null;
    });

    // Preview UI for compact display in lists/pickers
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
              urgentCount > 0 ? "#fef2f2" : "#f3e8ff"
            ),
            border: computed(() =>
              urgentCount > 0 ? "2px solid #ef4444" : "2px solid #8b5cf6"
            ),
            color: computed(() => (urgentCount > 0 ? "#dc2626" : "#7c3aed")),
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: "bold",
            fontSize: "14px",
          }}
        >
          BAM
        </div>
        <div>
          <div style={{ fontWeight: "600", fontSize: "14px" }}>
            {settings.schoolName}
          </div>
          <div style={{ fontSize: "12px", color: "#6b7280" }}>
            {computed(() => {
              const count = urgentCount;
              const next = nextEvent;
              if (count > 0) {
                const base = `${count} action item${count !== 1 ? "s" : ""}`;
                if (next?.title) {
                  return `${base} • ${next.title}`;
                }
                return base;
              }
              if (next?.title) {
                return `Next: ${next.title}`;
              }
              return `${settings.childName}'s updates`;
            })}
          </div>
        </div>
      </div>
    );

    return {
      [NAME]: computed(() => `BAM Dashboard - ${settings.childName}`),

      emails: allEmails,
      events: allEvents,
      urgentEvents,
      upcomingEvents,
      teacherMessages,
      previewUI,

      [UI]: (
        <ct-screen>
          <div slot="header">
            <ct-heading level={3}>{settings.schoolName} Dashboard</ct-heading>
            <div style={{ fontSize: "12px", color: "#6b7280" }}>
              {settings.childName} - {settings.grade} - {settings.teacher}
            </div>
          </div>

          <ct-vscroll flex showScrollbar>
            <ct-vstack padding="6" gap="4">
              {/* Auth UI from embedded Gmail Importer */}
              {gmailImporter.authUI}

              {/* Connection Status */}
              <div
                style={{
                  padding: "12px 16px",
                  backgroundColor: "#d1fae5",
                  borderRadius: "8px",
                  border: "1px solid #10b981",
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
                    {emailCount} school emails
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
                    Refresh
                  </button>
                </div>
              </div>

              {/* Analysis Progress */}
              <div
                style={{
                  padding: "12px 16px",
                  backgroundColor: "#eff6ff",
                  borderRadius: "8px",
                  border: "1px solid #3b82f6",
                  display: computed(() => pendingCount > 0 ? "block" : "none"),
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "12px",
                  }}
                >
                  <ct-loader size="sm" />
                  <span>
                    Analyzing emails... {completedCount}/{emailCount} complete
                  </span>
                </div>
              </div>

              {/* ============================================================ */}
              {/* URGENT / ACTION REQUIRED SECTION */}
              {/* ============================================================ */}
              <div
                style={{
                  display: computed(() =>
                    urgentEvents?.length > 0 ? "block" : "none"
                  ),
                }}
              >
                <h3
                  style={{
                    fontSize: "16px",
                    fontWeight: "700",
                    marginBottom: "12px",
                    color: "#dc2626",
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                  }}
                >
                  <span style={{ fontSize: "20px" }}>⚠️</span>
                  Action Required ({urgentCount})
                </h3>

                <ct-vstack gap="3">
                  {urgentEvents.map((event: SchoolEvent) => (
                    <div
                      style={{
                        padding: "16px",
                        backgroundColor: "#fef2f2",
                        borderRadius: "12px",
                        border: "2px solid #fecaca",
                        borderLeft: computed(
                          () =>
                            `4px solid ${
                              CATEGORY_INFO[event.category]?.color || "#9ca3af"
                            }`,
                        ),
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: "12px",
                        }}
                      >
                        <div
                          style={{
                            fontSize: "24px",
                            lineHeight: "1",
                          }}
                        >
                          {computed(
                            () => CATEGORY_INFO[event.category]?.icon || "📌",
                          )}
                        </div>
                        <div style={{ flex: 1 }}>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "8px",
                              marginBottom: "4px",
                              flexWrap: "wrap",
                            }}
                          >
                            <span
                              style={{
                                fontWeight: "700",
                                fontSize: "15px",
                                color: "#111827",
                              }}
                            >
                              {event.title}
                            </span>
                            <span
                              style={{
                                padding: "2px 8px",
                                backgroundColor: computed(
                                  () =>
                                    CATEGORY_INFO[event.category]?.color ||
                                    "#9ca3af",
                                ),
                                borderRadius: "4px",
                                fontSize: "11px",
                                color: "white",
                                fontWeight: "500",
                              }}
                            >
                              {computed(
                                () =>
                                  CATEGORY_INFO[event.category]?.label ||
                                  "Other",
                              )}
                            </span>
                            <span
                              style={{
                                padding: "2px 8px",
                                backgroundColor: computed(() =>
                                  SOURCE_INFO[event.sourceType]?.priority === 1
                                    ? "#8b5cf6"
                                    : "#6b7280"
                                ),
                                borderRadius: "4px",
                                fontSize: "11px",
                                color: "white",
                                fontWeight: "500",
                              }}
                            >
                              {computed(
                                () =>
                                  SOURCE_INFO[event.sourceType]?.label ||
                                  "School",
                              )}
                            </span>
                          </div>

                          {/* Date badge */}
                          <div
                            style={{
                              display: computed(() =>
                                event.date ? "flex" : "none"
                              ),
                              alignItems: "center",
                              gap: "8px",
                              marginBottom: "8px",
                            }}
                          >
                            <span
                              style={{
                                padding: "4px 10px",
                                backgroundColor: computed(() => {
                                  const today = new Date();
                                  today.setHours(0, 0, 0, 0);
                                  return getUrgencyColor(
                                    daysUntil(event.date, today),
                                    event.isUrgent,
                                  );
                                }),
                                borderRadius: "6px",
                                fontSize: "12px",
                                color: "white",
                                fontWeight: "600",
                              }}
                            >
                              {computed(() => {
                                const today = new Date();
                                today.setHours(0, 0, 0, 0);
                                return getDateLabel(
                                  daysUntil(event.date, today),
                                );
                              })}
                            </span>
                            <span
                              style={{ fontSize: "13px", color: "#6b7280" }}
                            >
                              {computed(
                                () =>
                                  `${formatDate(event.date)}${
                                    event.time ? ` at ${event.time}` : ""
                                  }`,
                              )}
                            </span>
                          </div>

                          {/* Action required badge */}
                          <div
                            style={{
                              display: computed(() =>
                                event.actionRequired ? "block" : "none"
                              ),
                              padding: "8px 12px",
                              backgroundColor: "#fee2e2",
                              borderRadius: "6px",
                              marginBottom: "8px",
                            }}
                          >
                            <span
                              style={{
                                fontSize: "13px",
                                fontWeight: "600",
                                color: "#b91c1c",
                              }}
                            >
                              {computed(() => `📌 ${event.actionRequired}`)}
                            </span>
                          </div>

                          <div
                            style={{
                              fontSize: "13px",
                              color: "#4b5563",
                              lineHeight: "1.4",
                            }}
                          >
                            {event.summary}
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={dismissEvent({
                            dismissedIds,
                            eventId: event.id,
                          })}
                          style={{
                            padding: "4px 8px",
                            backgroundColor: "#e5e7eb",
                            color: "#6b7280",
                            border: "none",
                            borderRadius: "4px",
                            cursor: "pointer",
                            fontSize: "12px",
                          }}
                          title="Dismiss"
                        >
                          ✓
                        </button>
                      </div>
                    </div>
                  ))}
                </ct-vstack>
              </div>

              {/* ============================================================ */}
              {/* TEACHER MESSAGES SECTION */}
              {/* ============================================================ */}
              <div
                style={{
                  display: computed(() =>
                    teacherMessages?.length > 0 ? "block" : "none"
                  ),
                }}
              >
                <h3
                  style={{
                    fontSize: "16px",
                    fontWeight: "700",
                    marginBottom: "12px",
                    color: "#7c3aed",
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                  }}
                >
                  <span style={{ fontSize: "20px" }}>👨‍🏫</span>
                  From {settings.teacher} ({computed(
                    () => teacherMessages?.length || 0,
                  )})
                </h3>

                <ct-vstack gap="3">
                  {teacherMessages.map((event: SchoolEvent) => (
                    <div
                      style={{
                        padding: "16px",
                        backgroundColor: "#f5f3ff",
                        borderRadius: "12px",
                        border: "2px solid #ddd6fe",
                        borderLeft: "4px solid #8b5cf6",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: "12px",
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
                            <span style={{ fontSize: "16px" }}>
                              {computed(
                                () =>
                                  CATEGORY_INFO[event.category]?.icon || "📌",
                              )}
                            </span>
                            <span
                              style={{
                                fontWeight: "600",
                                fontSize: "15px",
                                color: "#111827",
                              }}
                            >
                              {event.title}
                            </span>
                          </div>

                          <div
                            style={{
                              display: computed(() =>
                                event.date ? "inline-block" : "none"
                              ),
                              padding: "2px 8px",
                              backgroundColor: "#8b5cf6",
                              borderRadius: "4px",
                              fontSize: "11px",
                              color: "white",
                              fontWeight: "500",
                              marginBottom: "8px",
                            }}
                          >
                            {computed(
                              () =>
                                `${formatDate(event.date)}${
                                  event.time ? ` at ${event.time}` : ""
                                }`,
                            )}
                          </div>

                          <div
                            style={{
                              fontSize: "13px",
                              color: "#4b5563",
                              lineHeight: "1.4",
                            }}
                          >
                            {event.summary}
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={dismissEvent({
                            dismissedIds,
                            eventId: event.id,
                          })}
                          style={{
                            padding: "4px 8px",
                            backgroundColor: "#e5e7eb",
                            color: "#6b7280",
                            border: "none",
                            borderRadius: "4px",
                            cursor: "pointer",
                            fontSize: "12px",
                          }}
                          title="Dismiss"
                        >
                          ✓
                        </button>
                      </div>
                    </div>
                  ))}
                </ct-vstack>
              </div>

              {/* ============================================================ */}
              {/* UPCOMING EVENTS TIMELINE */}
              {/* ============================================================ */}
              <div
                style={{
                  display: computed(() =>
                    upcomingEvents?.length > 0 ? "block" : "none"
                  ),
                }}
              >
                <h3
                  style={{
                    fontSize: "16px",
                    fontWeight: "700",
                    marginBottom: "12px",
                    color: "#374151",
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                  }}
                >
                  <span style={{ fontSize: "20px" }}>📅</span>
                  Upcoming Events ({computed(() => upcomingEvents?.length || 0)}
                  )
                </h3>

                <ct-vstack gap="2">
                  {upcomingEvents.map((event: SchoolEvent) => (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "12px",
                        padding: "12px 16px",
                        backgroundColor: "#f9fafb",
                        borderRadius: "8px",
                        border: "1px solid #e5e7eb",
                      }}
                    >
                      {/* Date badge */}
                      <div
                        style={{
                          minWidth: "70px",
                          textAlign: "center",
                          padding: "8px",
                          backgroundColor: computed(() => {
                            const today = new Date();
                            today.setHours(0, 0, 0, 0);
                            return getUrgencyColor(
                              daysUntil(event.date, today),
                              event.isUrgent,
                            );
                          }),
                          borderRadius: "8px",
                          color: "white",
                        }}
                      >
                        <div
                          style={{
                            fontSize: "11px",
                            fontWeight: "500",
                            opacity: 0.9,
                          }}
                        >
                          {computed(() => {
                            const today = new Date();
                            today.setHours(0, 0, 0, 0);
                            return getDateLabel(daysUntil(event.date, today));
                          })}
                        </div>
                        <div style={{ fontSize: "14px", fontWeight: "700" }}>
                          {computed(() =>
                            formatDate(event.date)
                              .split(",")[0]
                              .replace(/\s+\d+$/, "")
                          )}
                        </div>
                      </div>

                      {/* Event info */}
                      <div style={{ flex: 1 }}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "6px",
                          }}
                        >
                          <span style={{ fontSize: "14px" }}>
                            {computed(
                              () => CATEGORY_INFO[event.category]?.icon || "📌",
                            )}
                          </span>
                          <span
                            style={{
                              fontWeight: "600",
                              fontSize: "14px",
                              color: "#111827",
                            }}
                          >
                            {event.title}
                          </span>
                        </div>
                        <div style={{ fontSize: "12px", color: "#6b7280" }}>
                          {computed(
                            () =>
                              `${formatDate(event.date)}${
                                event.time ? ` • ${event.time}` : ""
                              }`,
                          )}
                        </div>
                      </div>

                      {/* Action badge */}
                      <div
                        style={{
                          display: computed(() =>
                            event.actionRequired ? "block" : "none"
                          ),
                          padding: "4px 8px",
                          backgroundColor: "#fee2e2",
                          borderRadius: "4px",
                          fontSize: "11px",
                          fontWeight: "600",
                          color: "#b91c1c",
                        }}
                      >
                        Action
                      </div>
                    </div>
                  ))}
                </ct-vstack>
              </div>

              {/* ============================================================ */}
              {/* ALL EVENTS (Collapsed) */}
              {/* ============================================================ */}
              <details>
                <summary
                  style={{
                    cursor: "pointer",
                    fontWeight: "600",
                    fontSize: "14px",
                    color: "#6b7280",
                  }}
                >
                  All Updates ({computed(() => allEvents?.length || 0)})
                </summary>

                <ct-vstack gap="2" style={{ marginTop: "12px" }}>
                  {allEvents.map((event: SchoolEvent) => (
                    <div
                      style={{
                        padding: "12px",
                        backgroundColor: "#f9fafb",
                        borderRadius: "8px",
                        border: "1px solid #e5e7eb",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: "8px",
                        }}
                      >
                        <span style={{ fontSize: "16px" }}>
                          {computed(
                            () => CATEGORY_INFO[event.category]?.icon || "📌",
                          )}
                        </span>
                        <div style={{ flex: 1 }}>
                          <div
                            style={{
                              fontWeight: "600",
                              fontSize: "14px",
                              color: "#111827",
                            }}
                          >
                            {event.title}
                          </div>
                          <div
                            style={{
                              fontSize: "12px",
                              color: "#6b7280",
                              marginTop: "2px",
                            }}
                          >
                            {computed(
                              () =>
                                `${
                                  SOURCE_INFO[event.sourceType]?.label ||
                                  "School"
                                }${
                                  event.date
                                    ? ` • ${formatDate(event.date)}`
                                    : ""
                                }`,
                            )}
                          </div>
                          <div
                            style={{
                              fontSize: "13px",
                              color: "#4b5563",
                              marginTop: "4px",
                            }}
                          >
                            {event.summary}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={dismissEvent({
                            dismissedIds,
                            eventId: event.id,
                          })}
                          style={{
                            padding: "4px 8px",
                            backgroundColor: "#e5e7eb",
                            color: "#6b7280",
                            border: "none",
                            borderRadius: "4px",
                            cursor: "pointer",
                            fontSize: "12px",
                          }}
                          title="Dismiss"
                        >
                          ✓
                        </button>
                      </div>
                    </div>
                  ))}
                </ct-vstack>
              </details>

              {/* ============================================================ */}
              {/* DISMISSED ITEMS */}
              {/* ============================================================ */}
              <div
                style={{
                  display: computed(() =>
                    dismissedCount > 0 ? "block" : "none"
                  ),
                }}
              >
                <details>
                  <summary
                    style={{
                      cursor: "pointer",
                      fontWeight: "600",
                      fontSize: "14px",
                      color: "#9ca3af",
                    }}
                  >
                    Dismissed ({dismissedCount})
                  </summary>
                  <ct-vstack gap="2" style={{ marginTop: "8px" }}>
                    {allEmails.map((email: Email) => (
                      <div
                        style={{
                          padding: "8px 12px",
                          backgroundColor: "#f3f4f6",
                          borderRadius: "6px",
                          opacity: 0.7,
                          display: computed(() =>
                            (dismissedIds.get() || []).includes(
                                email.id as string,
                              )
                              ? "flex"
                              : "none"
                          ),
                          alignItems: "center",
                          gap: "8px",
                        }}
                      >
                        <span
                          style={{
                            fontSize: "13px",
                            color: "#6b7280",
                            flex: 1,
                          }}
                        >
                          {email.subject}
                        </span>
                        <button
                          type="button"
                          onClick={restoreEvent({
                            dismissedIds,
                            eventId: email.id,
                          })}
                          style={{
                            padding: "2px 6px",
                            backgroundColor: "#8b5cf6",
                            color: "white",
                            border: "none",
                            borderRadius: "4px",
                            cursor: "pointer",
                            fontSize: "11px",
                          }}
                        >
                          Restore
                        </button>
                      </div>
                    ))}
                  </ct-vstack>
                </details>
              </div>

              {/* ============================================================ */}
              {/* SETTINGS */}
              {/* ============================================================ */}
              <details>
                <summary
                  style={{
                    cursor: "pointer",
                    fontWeight: "600",
                    fontSize: "14px",
                    color: "#6b7280",
                  }}
                >
                  Settings
                </summary>
                <div
                  style={{
                    marginTop: "8px",
                    padding: "12px",
                    backgroundColor: "#f9fafb",
                    borderRadius: "8px",
                    fontSize: "13px",
                  }}
                >
                  <div>
                    <strong>Child:</strong> {settings.childName}
                  </div>
                  <div>
                    <strong>School:</strong> {settings.schoolName}
                  </div>
                  <div>
                    <strong>Grade:</strong> {settings.grade}
                  </div>
                  <div>
                    <strong>Teacher:</strong> {settings.teacher}
                  </div>
                </div>
              </details>
            </ct-vstack>
          </ct-vscroll>
        </ct-screen>
      ),
    };
  },
);
