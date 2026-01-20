/// <cts-enable />
/**
 * Email Ticket Finder Pattern
 *
 * Finds upcoming tickets and events in Gmail - flights, concerts, hotel reservations,
 * and more. Displays them in a dashboard with status indicators.
 *
 * Features:
 * - Embeds gmail-importer directly with broad keyword search
 * - LLM analyzes each email to extract ticket information
 * - Deduplicates by confirmation code or title+date
 * - Groups by status: Today, Action Needed, This Week, Later
 * - Supports multiple ticket types: airline, concert, hotel, etc.
 *
 * Usage:
 * 1. Deploy a google-auth charm and complete OAuth
 * 2. Deploy this pattern
 * 3. Link: ct charm link google-auth/auth email-ticket-finder/linkedAuth
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
import ProcessingStatus from "./processing-status.tsx";

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

type TicketSource =
  | "airline"
  | "train"
  | "bus"
  | "concert"
  | "sports"
  | "theater"
  | "movie"
  | "hotel"
  | "rental_car"
  | "conference"
  | "workshop"
  | "restaurant"
  | "tour"
  | "other"
  | "not_a_ticket";

type TicketStatus = "upcoming" | "today" | "past" | "action_needed";

interface ExtractedTicket {
  isTicket: boolean;
  ticketSource: TicketSource;
  eventName: string;
  eventDate?: string; // ISO format YYYY-MM-DD
  eventTime?: string; // HH:MM format
  endDate?: string; // For multi-day events
  location?: string;
  venue?: string;
  confirmationCode?: string;
  seatInfo?: string;
  provider?: string; // Airline name, venue name, etc.
  summary: string;
}

/** A tracked ticket with calculated status */
interface TrackedTicket {
  key: string; // Deduplication key
  eventName: string;
  ticketSource: TicketSource;
  eventDate?: string;
  eventTime?: string;
  endDate?: string;
  location?: string;
  venue?: string;
  confirmationCode?: string;
  seatInfo?: string;
  provider?: string;
  status: TicketStatus;
  daysUntil: number;
  emailId: string;
  emailDate: string;
  emailSubject: string;
}

// =============================================================================
// CONSTANTS
// =============================================================================

// Gmail query to find ticket-related emails
// Broad search with keywords, LLM will filter out false positives
const TICKET_GMAIL_QUERY =
  `subject:ticket OR subject:"boarding pass" OR subject:e-ticket OR subject:"your reservation" OR subject:"event confirmation" OR subject:"your tickets" OR subject:"order confirmation" OR subject:itinerary OR subject:"flight confirmation" OR subject:"hotel confirmation" OR subject:"booking confirmation"`;

// Schema for LLM email analysis
const TICKET_ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    isTicket: {
      type: "boolean",
      description:
        "True ONLY if this email contains a CONFIRMED ticket with a confirmation/booking code. False for promotional emails, invitations to buy tickets, support tickets, lottery tickets, or anything without a clear confirmation code.",
    },
    ticketSource: {
      type: "string",
      enum: [
        "airline",
        "train",
        "bus",
        "concert",
        "sports",
        "theater",
        "movie",
        "hotel",
        "rental_car",
        "conference",
        "workshop",
        "restaurant",
        "tour",
        "other",
        "not_a_ticket",
      ],
      description:
        "The type of ticket or reservation: airline for flights, train/bus for ground transport, concert/sports/theater/movie for entertainment, hotel for accommodations, rental_car for car rentals, conference/workshop for professional events, restaurant for dining reservations, tour for tours/activities, other for misc tickets, not_a_ticket if this is not actually a ticket",
    },
    eventName: {
      type: "string",
      description:
        "Name of the event, flight (e.g., 'Flight to NYC'), show, hotel stay, etc.",
    },
    eventDate: {
      type: "string",
      description:
        "Event/travel date in YYYY-MM-DD format. For flights, use departure date.",
    },
    eventTime: {
      type: "string",
      description:
        "Event/departure time in HH:MM format (24-hour). For flights, use departure time.",
    },
    endDate: {
      type: "string",
      description:
        "End date in YYYY-MM-DD format for multi-day events (hotel checkout, return flight, etc.)",
    },
    location: {
      type: "string",
      description:
        "Location/destination. For flights: arrival city. For hotels: city. For concerts: city.",
    },
    venue: {
      type: "string",
      description:
        "Specific venue name (stadium, theater, hotel name, airport, etc.)",
    },
    confirmationCode: {
      type: "string",
      description:
        "Confirmation/booking/reference code/number (very important for deduplication)",
    },
    seatInfo: {
      type: "string",
      description: "Seat assignment, section, row, or similar positioning info",
    },
    provider: {
      type: "string",
      description:
        "Service provider name (airline, hotel chain, ticketing company, etc.)",
    },
    summary: {
      type: "string",
      description:
        "Brief one-sentence summary of what this ticket/reservation is for",
    },
  },
  required: ["isTicket", "ticketSource", "eventName", "summary"],
} as const satisfies JSONSchema;

type TicketAnalysisResult = Schema<typeof TICKET_ANALYSIS_SCHEMA>;

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Create a deduplication key for a ticket.
 * Uses confirmation code if available, otherwise title+date.
 */
function createTicketKey(ticket: ExtractedTicket): string {
  if (ticket.confirmationCode) {
    return `conf:${ticket.confirmationCode.toLowerCase().trim()}`;
  }
  const name = (ticket.eventName || "").toLowerCase().trim();
  const date = ticket.eventDate || "";
  return `${name}|${date}`;
}

/**
 * Calculate days until event date.
 * Returns negative number for past events.
 */
function calculateDaysUntil(
  eventDate: string | undefined,
  referenceDate: Date,
): number {
  if (!eventDate) return 999; // No date = far in future

  const match = eventDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return 999;

  const [, year, month, day] = match;
  const event = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));

  if (isNaN(event.getTime())) return 999;

  event.setHours(0, 0, 0, 0);
  return Math.ceil(
    (event.getTime() - referenceDate.getTime()) / (1000 * 60 * 60 * 24),
  );
}

/**
 * Determine ticket status based on days until event.
 */
function calculateStatus(daysUntil: number): TicketStatus {
  if (daysUntil < 0) return "past";
  if (daysUntil === 0) return "today";
  // Could add "action_needed" logic here based on ticket type
  // e.g., flights within 24 hours might need check-in
  return "upcoming";
}

/**
 * Validate and parse a date string in YYYY-MM-DD format.
 * Returns null if invalid.
 */
function parseValidDate(dateStr: string | undefined): Date | null {
  if (!dateStr) return null;
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
  if (isNaN(date.getTime())) return null;
  return date;
}

/**
 * Format date for display.
 */
function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return "Date TBD";
  const date = parseValidDate(dateStr);
  if (!date) return "Date TBD";
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/**
 * Get icon for ticket source.
 */
function getTicketIcon(source: TicketSource): string {
  switch (source) {
    case "airline":
      return "✈️";
    case "train":
      return "🚆";
    case "bus":
      return "🚌";
    case "concert":
      return "🎵";
    case "sports":
      return "🏟️";
    case "theater":
      return "🎭";
    case "movie":
      return "🎬";
    case "hotel":
      return "🏨";
    case "rental_car":
      return "🚗";
    case "conference":
      return "📋";
    case "workshop":
      return "🎓";
    case "restaurant":
      return "🍽️";
    case "tour":
      return "🎡";
    default:
      return "🎫";
  }
}

/**
 * Get status color styling.
 */
function getStatusColor(status: TicketStatus): {
  bg: string;
  border: string;
  text: string;
} {
  switch (status) {
    case "today":
      return { bg: "#fef3c7", border: "#f59e0b", text: "#b45309" };
    case "action_needed":
      return { bg: "#fee2e2", border: "#ef4444", text: "#b91c1c" };
    case "upcoming":
      return { bg: "#d1fae5", border: "#10b981", text: "#047857" };
    case "past":
      return { bg: "#f3f4f6", border: "#d1d5db", text: "#6b7280" };
    default:
      return { bg: "#f3f4f6", border: "#d1d5db", text: "#4b5563" };
  }
}

/**
 * Get status label for display.
 */
function getStatusLabel(status: TicketStatus, daysUntil: number): string {
  switch (status) {
    case "today":
      return "Today";
    case "action_needed":
      return "Action Needed";
    case "upcoming":
      if (daysUntil === 1) return "Tomorrow";
      if (daysUntil <= 7) return `In ${daysUntil} days`;
      return `${daysUntil} days away`;
    case "past":
      if (daysUntil === -1) return "Yesterday";
      return `${Math.abs(daysUntil)} days ago`;
    default:
      return "";
  }
}

// =============================================================================
// PATTERN
// =============================================================================

interface PatternInput {
  linkedAuth?: Auth;
  // No additional writable state needed for this pattern
  // (could add dismissed/hidden tickets later)
}

/** Email ticket finder for tracking upcoming events. #emailTickets */
interface PatternOutput {
  tickets: TrackedTicket[];
  todayTickets: TrackedTicket[];
  upcomingTickets: TrackedTicket[];
  pastTickets: TrackedTicket[];
  todayCount: number;
  upcomingCount: number;
  previewUI: unknown;
}

export default pattern<PatternInput, PatternOutput>(({ linkedAuth }) => {
  // Directly instantiate GmailImporter with ticket-specific settings
  const gmailImporter = GmailImporter({
    settings: {
      gmailFilterQuery: TICKET_GMAIL_QUERY,
      autoFetchOnAuth: true,
      resolveInlineImages: false,
      limit: 100,
      debugMode: false,
    },
    linkedAuth,
  });

  // Get emails directly from the embedded gmail-importer
  const allEmails = gmailImporter.emails;

  // All potentially ticket-related emails (we'll let LLM filter)
  const ticketEmails = computed(() => {
    return allEmails || [];
  });

  // Count of emails found
  const emailCount = computed(() => ticketEmails?.length || 0);

  // Check if connected
  const isConnected = computed(() => {
    if (linkedAuth?.token) return true;
    return gmailImporter?.emailCount !== undefined;
  });

  // ==========================================================================
  // REACTIVE LLM ANALYSIS
  // Analyze each email to extract ticket information
  // ==========================================================================

  const emailAnalyses = ticketEmails.map((email: Email) => {
    const analysis = generateObject<TicketAnalysisResult>({
      prompt: computed(() => {
        if (!email?.markdownContent) {
          return undefined;
        }

        return `Analyze this email and determine if it contains an ACTUAL CONFIRMED ticket or reservation.

CRITICAL DISTINCTION - isTicket=true ONLY for CONFIRMED tickets with:
- A confirmation/booking/reference code
- A specific date and time for the event
- Clear indication that a purchase/booking was completed

CONFIRMED TICKETS (isTicket=true):
- Flight tickets with PNR/confirmation code (e.g., "Your confirmation: ABC123")
- Train/bus tickets with booking reference
- Concert/sports/theater tickets that were PURCHASED (with order number)
- Hotel reservations with confirmation number
- Car rental confirmations with reservation number
- Conference registrations with registration ID
- Restaurant reservations with confirmation

NOT TICKETS (isTicket=false):
- Promotional emails ("Get your tickets!", "Buy now!", "Don't miss out!")
- Event announcements or invitations without a confirmed purchase
- Emails asking you to RSVP or register (not yet confirmed)
- Support tickets / help desk tickets
- Lottery tickets / sweepstakes
- Parking tickets / violations
- Order confirmations for physical goods (not events)
- Newsletters, marketing emails, or reminders to buy

KEY RULE: If there's no confirmation code and no clear indication of a completed purchase, it's NOT a confirmed ticket.

EMAIL SUBJECT: ${email.subject || ""}
EMAIL DATE: ${email.date || ""}
EMAIL FROM: ${email.from || ""}

EMAIL CONTENT:
${email.markdownContent.slice(0, 5000)}

Extract:
1. Is this a CONFIRMED ticket/reservation with a confirmation code? (true/false)
2. Type of ticket (airline, concert, hotel, etc.)
3. Event name (flight route, show name, hotel name, etc.)
4. Event date in YYYY-MM-DD format (MUST be a valid future or recent date)
5. Event time in HH:MM format (if available)
6. End date for multi-day events (hotel checkout, etc.)
7. Location/destination
8. Venue name
9. Confirmation/booking code (REQUIRED for isTicket=true)
10. Seat info if available
11. Provider/company name
12. Brief summary`;
      }),
      schema: TICKET_ANALYSIS_SCHEMA,
      model: "anthropic:claude-sonnet-4-5",
    });

    return {
      email,
      emailId: email.id,
      emailDate: email.date,
      emailSubject: email.subject,
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
  // TICKET TRACKING
  // Build deduplicated list of tickets
  // ==========================================================================

  const tickets = computed(() => {
    const ticketMap = new Map<string, TrackedTicket>();

    // Create a single reference date for deterministic calculations
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Sort emails by date (newest first) so we keep most recent data
    const sortedAnalyses = [...(emailAnalyses || [])]
      .filter((a) => a?.result && a.result.isTicket)
      .sort((a, b) => {
        const dateA = new Date(a.emailDate || 0).getTime();
        const dateB = new Date(b.emailDate || 0).getTime();
        if (dateB !== dateA) return dateB - dateA;
        return (a.emailId || "").localeCompare(b.emailId || "");
      });

    for (const analysisItem of sortedAnalyses) {
      const result = analysisItem.result;
      if (!result || !result.isTicket) continue;
      if (result.ticketSource === "not_a_ticket") continue;

      // Skip tickets without a valid date (likely promotional emails that slipped through)
      const eventDate = parseValidDate(result.eventDate);
      if (!eventDate) continue;

      const key = createTicketKey(result);

      // Skip if we already have this ticket (we process newest first)
      if (ticketMap.has(key)) continue;

      const daysUntil = calculateDaysUntil(result.eventDate, today);
      const status = calculateStatus(daysUntil);

      const trackedTicket: TrackedTicket = {
        key,
        eventName: result.eventName,
        ticketSource: result.ticketSource,
        eventDate: result.eventDate,
        eventTime: result.eventTime,
        endDate: result.endDate,
        location: result.location,
        venue: result.venue,
        confirmationCode: result.confirmationCode,
        seatInfo: result.seatInfo,
        provider: result.provider,
        status,
        daysUntil,
        emailId: analysisItem.emailId,
        emailDate: analysisItem.emailDate,
        emailSubject: analysisItem.emailSubject,
      };

      ticketMap.set(key, trackedTicket);
    }

    // Convert to array and sort by event date (soonest first)
    const items = Array.from(ticketMap.values());
    return items.sort((a, b) => {
      // Sort by days until (ascending), with today/upcoming before past
      if (a.status === "past" && b.status !== "past") return 1;
      if (a.status !== "past" && b.status === "past") return -1;
      return a.daysUntil - b.daysUntil;
    });
  });

  // Filter by status
  const todayTickets = computed(() =>
    (tickets || []).filter((t) => t.status === "today")
  );

  const upcomingTickets = computed(() =>
    (tickets || []).filter((t) => t.status === "upcoming")
  );

  const pastTickets = computed(() =>
    (tickets || []).filter((t) => t.status === "past")
  );

  // Counts
  const todayCount = computed(() => todayTickets?.length || 0);
  const upcomingCount = computed(() => upcomingTickets?.length || 0);

  // Next event for preview
  const nextTicket = computed(() => {
    const upcoming = [...(todayTickets || []), ...(upcomingTickets || [])];
    return upcoming[0] || null;
  });

  // Preview UI for compact display
  const previewUI = (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "8px 12px",
        flex: 1,
      }}
    >
      <div
        style={{
          width: "36px",
          height: "36px",
          borderRadius: "8px",
          backgroundColor: computed(() =>
            todayCount > 0 ? "#fef3c7" : "#d1fae5"
          ),
          border: computed(() =>
            todayCount > 0 ? "2px solid #f59e0b" : "2px solid #10b981"
          ),
          color: computed(() => (todayCount > 0 ? "#b45309" : "#047857")),
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontWeight: "bold",
          fontSize: "16px",
        }}
      >
        {computed(() => todayCount + upcomingCount)}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: "600", fontSize: "14px" }}>
          Upcoming Tickets
        </div>
        <div style={{ fontSize: "12px", color: "#6b7280" }}>
          <span
            style={{
              color: "#b45309",
              display: computed(() => (todayCount > 0 ? "inline" : "none")),
            }}
          >
            {todayCount} today
          </span>
          <span
            style={{
              display: computed(() =>
                todayCount > 0 && upcomingCount > 0 ? "inline" : "none"
              ),
            }}
          >
            {" · "}
          </span>
          <span
            style={{
              display: computed(() => (upcomingCount > 0 ? "inline" : "none")),
            }}
          >
            {upcomingCount} upcoming
          </span>
          <span
            style={{
              display: computed(() => nextTicket ? "inline" : "none"),
            }}
          >
            {" - "}
            {computed(() => nextTicket?.eventName || "")}
          </span>
        </div>
      </div>
      {/* Loading/progress indicator */}
      <ProcessingStatus
        totalCount={emailCount}
        pendingCount={pendingCount}
        completedCount={completedCount}
      />
    </div>
  );

  return {
    [NAME]: "Email Tickets",

    tickets,
    todayTickets,
    upcomingTickets,
    pastTickets,
    todayCount,
    upcomingCount,
    previewUI,

    [UI]: (
      <ct-screen>
        <div slot="header">
          <ct-heading level={3}>Email Ticket Finder</ct-heading>
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
                  {emailCount} potential ticket emails found
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
                <span>{emailCount} emails</span>
                <div
                  style={{
                    display: computed(() => pendingCount > 0 ? "flex" : "none"),
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
                    color: "#b45309",
                  }}
                >
                  {todayCount}
                </div>
                <div style={{ fontSize: "12px", color: "#666" }}>Today</div>
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
                    color: "#047857",
                  }}
                >
                  {upcomingCount}
                </div>
                <div style={{ fontSize: "12px", color: "#666" }}>Upcoming</div>
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
                    color: "#6b7280",
                  }}
                >
                  {computed(() => (tickets || []).length)}
                </div>
                <div style={{ fontSize: "12px", color: "#666" }}>Total</div>
              </div>
            </div>

            {/* Today's Events Alert */}
            <div
              style={{
                padding: "16px",
                backgroundColor: "#fef3c7",
                borderRadius: "12px",
                border: "2px solid #f59e0b",
                display: computed(() => (todayCount > 0 ? "block" : "none")),
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
                <span style={{ fontSize: "24px" }}>🎫</span>
                <span
                  style={{
                    fontWeight: "700",
                    fontSize: "18px",
                    color: "#b45309",
                  }}
                >
                  {todayCount} Event{todayCount !== 1 ? "s" : ""} Today!
                </span>
              </div>
              <ct-vstack gap="2">
                {todayTickets.map((ticket) => (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      padding: "8px 12px",
                      backgroundColor: "white",
                      borderRadius: "6px",
                    }}
                  >
                    <span style={{ fontSize: "18px" }}>
                      {getTicketIcon(ticket.ticketSource)}
                    </span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: "600", fontSize: "14px" }}>
                        {ticket.eventName}
                      </div>
                      <div style={{ fontSize: "12px", color: "#6b7280" }}>
                        {ticket.eventTime || ""}{" "}
                        {ticket.venue || ticket.location || ""}
                      </div>
                    </div>
                    <div
                      style={{
                        fontSize: "12px",
                        color: "#b45309",
                        fontWeight: "500",
                        display: ticket.confirmationCode ? "block" : "none",
                      }}
                    >
                      {ticket.confirmationCode}
                    </div>
                  </div>
                ))}
              </ct-vstack>
            </div>

            {/* Upcoming Events Section */}
            <div
              style={{
                display: computed(() => upcomingCount > 0 ? "block" : "none"),
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
                Upcoming Events
              </h3>
              <ct-vstack gap="3">
                {upcomingTickets.map((ticket) => {
                  const statusColors = getStatusColor(ticket.status);
                  return (
                    <div
                      style={{
                        display: "flex",
                        gap: "12px",
                        padding: "16px",
                        backgroundColor: statusColors.bg,
                        borderRadius: "12px",
                        border: `2px solid ${statusColors.border}`,
                      }}
                    >
                      <div
                        style={{
                          fontSize: "28px",
                          display: "flex",
                          alignItems: "center",
                        }}
                      >
                        {getTicketIcon(ticket.ticketSource)}
                      </div>
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
                              fontSize: "16px",
                              color: "#111827",
                            }}
                          >
                            {ticket.eventName}
                          </span>
                          <span
                            style={{
                              padding: "2px 8px",
                              backgroundColor: statusColors.border,
                              borderRadius: "4px",
                              fontSize: "11px",
                              color: "white",
                              fontWeight: "500",
                            }}
                          >
                            {getStatusLabel(ticket.status, ticket.daysUntil)}
                          </span>
                        </div>
                        <div style={{ fontSize: "14px", color: "#4b5563" }}>
                          {formatDate(ticket.eventDate)}
                          {ticket.eventTime ? ` at ${ticket.eventTime}` : ""}
                        </div>
                        <div
                          style={{
                            fontSize: "13px",
                            color: "#6b7280",
                            marginTop: "4px",
                            display: ticket.venue || ticket.location
                              ? "block"
                              : "none",
                          }}
                        >
                          📍 {ticket.venue || ""}{" "}
                          {ticket.venue && ticket.location ? " - " : ""}
                          {ticket.location || ""}
                        </div>
                        <div
                          style={{
                            fontSize: "13px",
                            color: "#6b7280",
                            display: ticket.provider ? "block" : "none",
                          }}
                        >
                          {ticket.provider}
                        </div>
                        <div
                          style={{
                            display: "flex",
                            gap: "12px",
                            marginTop: "8px",
                            fontSize: "12px",
                          }}
                        >
                          <div
                            style={{
                              display: ticket.confirmationCode
                                ? "block"
                                : "none",
                              padding: "4px 8px",
                              backgroundColor: "rgba(255,255,255,0.7)",
                              borderRadius: "4px",
                              fontFamily: "monospace",
                            }}
                          >
                            Conf: {ticket.confirmationCode}
                          </div>
                          <div
                            style={{
                              display: ticket.seatInfo ? "block" : "none",
                              padding: "4px 8px",
                              backgroundColor: "rgba(255,255,255,0.7)",
                              borderRadius: "4px",
                            }}
                          >
                            {ticket.seatInfo}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </ct-vstack>
            </div>

            {/* Past Events Section */}
            <div
              style={{
                display: computed(() =>
                  (pastTickets || []).length > 0 ? "block" : "none"
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
                    color: "#6b7280",
                  }}
                >
                  Past Events ({computed(() => (pastTickets || []).length)})
                </summary>
                <ct-vstack gap="2">
                  {pastTickets.map((ticket) => (
                    <div
                      style={{
                        display: "flex",
                        gap: "12px",
                        padding: "12px",
                        backgroundColor: "#f3f4f6",
                        borderRadius: "8px",
                        border: "1px solid #d1d5db",
                        opacity: 0.7,
                      }}
                    >
                      <div style={{ fontSize: "20px" }}>
                        {getTicketIcon(ticket.ticketSource)}
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: "600", fontSize: "14px" }}>
                          {ticket.eventName}
                        </div>
                        <div style={{ fontSize: "12px", color: "#6b7280" }}>
                          {formatDate(ticket.eventDate)} ·{" "}
                          {getStatusLabel(ticket.status, ticket.daysUntil)}
                        </div>
                      </div>
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
                  Debug View ({emailCount} emails analyzed)
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
                              : analysis.result?.isTicket
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
                          Error: {computed(() =>
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
                                analysis.result?.isTicket
                                  ? "#d1fae5"
                                  : "#f3f4f6"
                              ),
                              borderRadius: "4px",
                            }}
                          >
                            <div style={{ color: "#374151" }}>
                              <strong>Is Ticket:</strong>{" "}
                              {computed(() =>
                                analysis.result?.isTicket ? "Yes ✓" : "No"
                              )}
                            </div>
                            <div
                              style={{
                                color: "#374151",
                                marginTop: "4px",
                                display: computed(() =>
                                  analysis.result?.isTicket ? "block" : "none"
                                ),
                              }}
                            >
                              <strong>Type:</strong> {computed(
                                () => analysis.result?.ticketSource || "N/A",
                              )}
                            </div>
                            <div
                              style={{
                                color: "#374151",
                                marginTop: "4px",
                                display: computed(() =>
                                  analysis.result?.isTicket ? "block" : "none"
                                ),
                              }}
                            >
                              <strong>Event:</strong> {computed(
                                () => analysis.result?.eventName || "N/A",
                              )}
                            </div>
                            <div
                              style={{
                                color: "#374151",
                                marginTop: "4px",
                                display: computed(() =>
                                  analysis.result?.eventDate ? "block" : "none"
                                ),
                              }}
                            >
                              <strong>Date:</strong>{" "}
                              {computed(() =>
                                formatDate(analysis.result?.eventDate)
                              )}
                            </div>
                            <div
                              style={{
                                color: "#374151",
                                marginTop: "4px",
                                display: computed(() =>
                                  analysis.result?.confirmationCode
                                    ? "block"
                                    : "none"
                                ),
                              }}
                            >
                              <strong>Confirmation:</strong> {computed(
                                () => analysis.result?.confirmationCode || "",
                              )}
                            </div>
                            <div
                              style={{ color: "#374151", marginTop: "4px" }}
                            >
                              <strong>Summary:</strong> {computed(
                                () => analysis.result?.summary || "N/A",
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
