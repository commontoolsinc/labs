/// <cts-enable />
/**
 * United Airlines Flight Tracker
 *
 * Tracks United Airlines flights from email notifications, showing upcoming flights,
 * check-in availability, delays, and confirmation details.
 *
 * Features:
 * - Embeds gmail-importer for United emails
 * - Extracts flight information using LLM from email markdown content
 * - Deduplicates flights across multiple emails (confirmation, check-in, boarding)
 * - Tracks upcoming and past flights
 * - Shows check-in availability, delays, gate changes
 *
 * Usage:
 * 1. Deploy a google-auth charm and complete OAuth
 * 2. Deploy this pattern
 * 3. Link: ct charm link google-auth/auth united-flight-tracker/linkedAuth
 */
import {
  computed,
  generateObject,
  ifElse,
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

type EmailType =
  | "booking_confirmation"
  | "check_in_available"
  | "check_in_confirmation"
  | "boarding_pass"
  | "flight_delay"
  | "flight_cancellation"
  | "gate_change"
  | "upgrade_offer"
  | "itinerary_update"
  | "receipt"
  | "mileageplus"
  | "other";

type FlightStatus = "scheduled" | "delayed" | "cancelled" | "completed";

interface FlightInfo {
  flightNumber?: string; // e.g., "UA 1234"
  confirmationNumber?: string;
  departureCity?: string;
  departureAirport?: string; // 3-letter code
  arrivalCity?: string;
  arrivalAirport?: string; // 3-letter code
  departureDate?: string; // ISO format YYYY-MM-DD
  departureTime?: string; // HH:MM format
  arrivalTime?: string;
  gate?: string;
  seat?: string;
  terminal?: string;
  status?: string; // on-time, delayed, cancelled
  delayMinutes?: number;
  newDepartureTime?: string; // Updated time if delayed
}

interface UnitedEmailAnalysis {
  emailType: EmailType;
  flights: FlightInfo[];
  passengerName?: string;
  checkInAvailable?: boolean;
  checkInDeadline?: string; // ISO datetime
  summary: string;
}

/** A tracked flight with deduplicated data */
interface TrackedFlight {
  key: string; // Deduplication: confirmationNumber|flightNumber|departureDate
  confirmationNumber: string;
  flightNumber: string;
  departureCity: string;
  departureAirport: string;
  arrivalCity: string;
  arrivalAirport: string;
  departureDate: string; // YYYY-MM-DD
  departureTime: string; // HH:MM
  arrivalTime: string;
  seat?: string;
  gate?: string;
  terminal?: string;
  status: FlightStatus;
  delayMinutes?: number;
  newDepartureTime?: string;
  checkInAvailable: boolean;
  checkInDeadline?: string;
  isUpcoming: boolean;
  daysUntilFlight: number;
  passengerName?: string;
  emailIds: string[]; // Source email IDs
}

/** Flights grouped by confirmation number */
interface TrackedTrip {
  confirmationNumber: string;
  flights: TrackedFlight[];
  passengerName?: string;
  hasUpcomingFlights: boolean;
  nextFlight?: TrackedFlight;
}

// =============================================================================
// CONSTANTS
// =============================================================================

// United sends from various addresses
const UNITED_GMAIL_QUERY = "from:united.com";

// 32 distinct colors for flight number badges (to reduce collisions)
const FLIGHT_COLORS = [
  // Blues (United brand-ish)
  "#3b82f6",
  "#2563eb",
  "#1d4ed8",
  "#1e40af",
  // Indigos & purples
  "#6366f1",
  "#4f46e5",
  "#8b5cf6",
  "#7c3aed",
  // Teals & cyans
  "#14b8a6",
  "#0d9488",
  "#06b6d4",
  "#0891b2",
  // Greens
  "#22c55e",
  "#16a34a",
  "#84cc16",
  "#65a30d",
  // Oranges & ambers
  "#f97316",
  "#ea580c",
  "#f59e0b",
  "#d97706",
  // Reds & pinks
  "#ef4444",
  "#dc2626",
  "#ec4899",
  "#db2777",
  // More blues & slates
  "#0ea5e9",
  "#0284c7",
  "#64748b",
  "#475569",
  // More purples
  "#a855f7",
  "#9333ea",
  "#d946ef",
  "#c026d3",
];

/**
 * Get a consistent color for a flight number.
 * Same flight number always gets the same color.
 */
function getFlightColor(flightNumber: string | undefined): string {
  if (!flightNumber || typeof flightNumber !== "string") {
    return FLIGHT_COLORS[0];
  }
  let hash = 0;
  for (let i = 0; i < flightNumber.length; i++) {
    hash = (hash * 31 + flightNumber.charCodeAt(i)) % 32;
  }
  return FLIGHT_COLORS[hash];
}

// Schema for LLM email analysis
const EMAIL_ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    emailType: {
      type: "string",
      enum: [
        "booking_confirmation",
        "check_in_available",
        "check_in_confirmation",
        "boarding_pass",
        "flight_delay",
        "flight_cancellation",
        "gate_change",
        "upgrade_offer",
        "itinerary_update",
        "receipt",
        "mileageplus",
        "other",
      ],
      description: "Type of United email",
    },
    flights: {
      type: "array",
      items: {
        type: "object",
        properties: {
          flightNumber: {
            type: "string",
            description: "Flight number like 'UA 1234' or 'United 1234'",
          },
          confirmationNumber: {
            type: "string",
            description: "6-character booking confirmation code",
          },
          departureCity: {
            type: "string",
            description: "Departure city name",
          },
          departureAirport: {
            type: "string",
            description: "3-letter departure airport code (e.g., SFO, ORD)",
          },
          arrivalCity: {
            type: "string",
            description: "Arrival city name",
          },
          arrivalAirport: {
            type: "string",
            description: "3-letter arrival airport code",
          },
          departureDate: {
            type: "string",
            description: "Departure date in YYYY-MM-DD format",
          },
          departureTime: {
            type: "string",
            description: "Departure time in HH:MM format (24-hour)",
          },
          arrivalTime: {
            type: "string",
            description: "Arrival time in HH:MM format (24-hour)",
          },
          gate: {
            type: "string",
            description: "Gate number if mentioned",
          },
          seat: {
            type: "string",
            description: "Seat assignment if mentioned (e.g., '12A')",
          },
          terminal: {
            type: "string",
            description: "Terminal if mentioned",
          },
          status: {
            type: "string",
            description: "Flight status: on-time, delayed, cancelled",
          },
          delayMinutes: {
            type: "number",
            description: "Delay in minutes if flight is delayed",
          },
          newDepartureTime: {
            type: "string",
            description:
              "New departure time in HH:MM format if flight is delayed",
          },
        },
      },
      description: "List of flights mentioned in the email",
    },
    passengerName: {
      type: "string",
      description: "Passenger name if mentioned",
    },
    checkInAvailable: {
      type: "boolean",
      description: "Whether check-in is currently available",
    },
    checkInDeadline: {
      type: "string",
      description: "Check-in deadline in ISO datetime format if mentioned",
    },
    summary: {
      type: "string",
      description: "Brief one-sentence summary of the email",
    },
  },
  required: ["emailType", "flights", "summary"],
} as const satisfies JSONSchema;

type EmailAnalysisResult = Schema<typeof EMAIL_ANALYSIS_SCHEMA>;

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Create a deduplication key for a flight.
 * Uses confirmation + flight number + departure date.
 */
function createFlightKey(
  confirmationNumber: string,
  flightNumber: string,
  departureDate: string,
): string {
  return `${confirmationNumber}|${flightNumber}|${departureDate}`;
}

/**
 * Calculate days until flight.
 * Returns negative number for past flights.
 */
function calculateDaysUntilFlight(
  departureDate: string | undefined,
  referenceDate: Date,
): number {
  if (!departureDate) return 999;

  const match = departureDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return 999;

  const [, year, month, day] = match;
  const departure = new Date(
    parseInt(year),
    parseInt(month) - 1,
    parseInt(day),
  );

  if (isNaN(departure.getTime())) return 999;

  departure.setHours(0, 0, 0, 0);
  return Math.ceil(
    (departure.getTime() - referenceDate.getTime()) / (1000 * 60 * 60 * 24),
  );
}

/**
 * Format date for display.
 */
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

/**
 * Format time for display.
 */
function formatTime(timeStr: string | undefined): string {
  if (!timeStr) return "";
  // Convert 24h to 12h format
  const [hours, minutes] = timeStr.split(":").map(Number);
  if (isNaN(hours) || isNaN(minutes)) return timeStr;
  const ampm = hours >= 12 ? "PM" : "AM";
  const hour12 = hours % 12 || 12;
  return `${hour12}:${minutes.toString().padStart(2, "0")} ${ampm}`;
}

/**
 * Parse flight status from email analysis.
 */
function parseFlightStatus(status: string | undefined): FlightStatus {
  if (!status) return "scheduled";
  const lower = status.toLowerCase();
  if (lower.includes("delay")) return "delayed";
  if (lower.includes("cancel")) return "cancelled";
  if (lower.includes("complete") || lower.includes("landed")) {
    return "completed";
  }
  return "scheduled";
}

// =============================================================================
// PATTERN
// =============================================================================

interface PatternInput {
  linkedAuth?: Auth;
}

/** United Airlines flight tracker. #unitedFlights */
interface PatternOutput {
  emailCount: number;
  flights: TrackedFlight[];
  upcomingFlights: TrackedFlight[];
  checkInAvailable: TrackedFlight[];
  activeAlerts: TrackedFlight[];
  pastFlights: TrackedFlight[];
  trips: TrackedTrip[];
  previewUI: unknown;
}

export default pattern<PatternInput, PatternOutput>(({ linkedAuth }) => {
  const gmailImporter = GmailImporter({
    settings: {
      gmailFilterQuery: UNITED_GMAIL_QUERY,
      autoFetchOnAuth: true,
      resolveInlineImages: false,
      limit: 100,
      debugMode: false,
    },
    linkedAuth,
  });

  const allEmails = gmailImporter.emails;
  const unitedEmailCount = computed(() => allEmails?.length || 0);

  const isConnected = computed(() => {
    if (linkedAuth?.token) return true;
    return gmailImporter?.emailCount !== undefined;
  });

  // ==========================================================================
  // REACTIVE LLM ANALYSIS
  // ==========================================================================

  const emailAnalyses = allEmails.map((email: Email) => {
    const analysis = generateObject<EmailAnalysisResult>({
      prompt: computed(() => {
        if (!email?.markdownContent) {
          return undefined;
        }

        return `Analyze this United Airlines email and extract flight information.

EMAIL SUBJECT: ${email.subject || ""}
EMAIL DATE: ${email.date || ""}

EMAIL CONTENT:
${email.markdownContent}

Extract:
1. The type of email:
   - booking_confirmation: New booking or itinerary confirmation
   - check_in_available: Check-in is now open (24h before departure)
   - check_in_confirmation: Check-in completed successfully
   - boarding_pass: Mobile boarding pass
   - flight_delay: Flight has been delayed
   - flight_cancellation: Flight has been cancelled
   - gate_change: Gate has changed
   - upgrade_offer: Upgrade opportunity
   - itinerary_update: Pre-trip reminder or itinerary change
   - receipt: Wi-Fi, upgrade, or other purchase receipt
   - mileageplus: MileagePlus status or miles update
   - other: Unrelated to flights

2. All flights mentioned with:
   - Flight number (e.g., "UA 1234")
   - Confirmation number (6-character code)
   - Departure/arrival cities and airport codes
   - Departure date (YYYY-MM-DD) and time (HH:MM 24-hour)
   - Arrival time
   - Gate, terminal, seat if mentioned
   - Status (on-time, delayed, cancelled)
   - Delay in minutes and new time if delayed

3. Passenger name if mentioned

4. Check-in availability and deadline if mentioned

5. Brief summary of the email`;
      }),
      schema: EMAIL_ANALYSIS_SCHEMA,
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

  const pendingCount = computed(
    () => emailAnalyses?.filter((a) => a?.pending)?.length || 0,
  );

  const completedCount = computed(
    () =>
      emailAnalyses?.filter(
        (a) =>
          a?.analysis?.pending === false && a?.analysis?.result !== undefined,
      ).length || 0,
  );

  // ==========================================================================
  // FLIGHT TRACKING - DEDUPLICATION AND MERGING
  // ==========================================================================

  const flights = computed(() => {
    const flightMap: Record<string, TrackedFlight> = {};

    // Create a single reference date for all calculations
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Sort emails by date (newest first) so we get latest status
    const sortedAnalyses = [...(emailAnalyses || [])]
      .filter((a) => a?.result)
      .sort((a, b) => {
        const dateA = new Date(a.emailDate || 0).getTime();
        const dateB = new Date(b.emailDate || 0).getTime();
        if (dateB !== dateA) return dateB - dateA;
        return (a.emailId || "").localeCompare(b.emailId || "");
      });

    // Process each email analysis
    for (const analysisItem of sortedAnalyses) {
      const result = analysisItem.result;
      if (!result || !result.flights) continue;

      const emailType = result.emailType;

      // Skip non-flight emails
      if (
        emailType === "receipt" ||
        emailType === "mileageplus" ||
        emailType === "other"
      ) {
        continue;
      }

      // Process each flight in the email
      for (const flight of result.flights) {
        // Need confirmation, flight number, and date to track
        if (
          !flight.confirmationNumber || !flight.flightNumber ||
          !flight.departureDate
        ) {
          continue;
        }

        const key = createFlightKey(
          flight.confirmationNumber,
          flight.flightNumber,
          flight.departureDate,
        );

        const daysUntilFlight = calculateDaysUntilFlight(
          flight.departureDate,
          today,
        );
        const isUpcoming = daysUntilFlight >= 0;

        // Check if we should mark check-in available
        // Check-in opens 24 hours before departure
        let checkInAvailable = false;
        let checkInDeadline: string | undefined;

        if (emailType === "check_in_available" || result.checkInAvailable) {
          checkInAvailable = true;
          checkInDeadline = result.checkInDeadline;
        } else if (isUpcoming && daysUntilFlight <= 1) {
          // Auto-detect check-in window (within 24 hours)
          checkInAvailable = true;
        }

        // Parse status
        let status = parseFlightStatus(flight.status);

        // Override with email type if more specific
        if (emailType === "flight_delay") {
          status = "delayed";
        } else if (emailType === "flight_cancellation") {
          status = "cancelled";
        }

        // Mark as completed if past
        if (!isUpcoming && status === "scheduled") {
          status = "completed";
        }

        if (flightMap[key]) {
          // Merge with existing flight - update with newer information
          const existing = flightMap[key];

          // Update seat, gate, terminal if we have newer info
          if (flight.seat) existing.seat = flight.seat;
          if (flight.gate) existing.gate = flight.gate;
          if (flight.terminal) existing.terminal = flight.terminal;

          // Update status to more severe (cancelled > delayed > scheduled)
          if (
            status === "cancelled" ||
            (status === "delayed" && existing.status !== "cancelled")
          ) {
            existing.status = status;
          }

          // Update delay info
          if (flight.delayMinutes) {
            existing.delayMinutes = flight.delayMinutes;
          }
          if (flight.newDepartureTime) {
            existing.newDepartureTime = flight.newDepartureTime;
          }

          // Update check-in info
          if (checkInAvailable) {
            existing.checkInAvailable = true;
            if (checkInDeadline) existing.checkInDeadline = checkInDeadline;
          }

          // Update passenger name if we have it
          if (result.passengerName && !existing.passengerName) {
            existing.passengerName = result.passengerName;
          }

          // Add email ID to sources
          if (!existing.emailIds.includes(analysisItem.emailId)) {
            existing.emailIds.push(analysisItem.emailId);
          }
        } else {
          // Create new tracked flight
          flightMap[key] = {
            key,
            confirmationNumber: flight.confirmationNumber,
            flightNumber: flight.flightNumber,
            departureCity: flight.departureCity || "",
            departureAirport: flight.departureAirport || "",
            arrivalCity: flight.arrivalCity || "",
            arrivalAirport: flight.arrivalAirport || "",
            departureDate: flight.departureDate,
            departureTime: flight.departureTime || "",
            arrivalTime: flight.arrivalTime || "",
            seat: flight.seat,
            gate: flight.gate,
            terminal: flight.terminal,
            status,
            delayMinutes: flight.delayMinutes,
            newDepartureTime: flight.newDepartureTime,
            checkInAvailable,
            checkInDeadline,
            isUpcoming,
            daysUntilFlight,
            passengerName: result.passengerName,
            emailIds: [analysisItem.emailId],
          };
        }
      }
    }

    // Convert to array and sort by departure date
    const items = Object.values(flightMap);
    return items.sort((a, b) => a.daysUntilFlight - b.daysUntilFlight);
  });

  // ==========================================================================
  // DERIVED STATE
  // ==========================================================================

  // Upcoming flights (future, not cancelled)
  const upcomingFlights = computed(() =>
    flights
      .filter((f) => f.isUpcoming && f.status !== "cancelled")
      .sort((a, b) => a.daysUntilFlight - b.daysUntilFlight)
  );

  // Flights ready for check-in
  const checkInAvailable = computed(() =>
    upcomingFlights.filter((f) =>
      f.checkInAvailable && f.status !== "cancelled"
    )
  );

  // Active alerts (delays and cancellations)
  const activeAlerts = computed(() =>
    flights.filter(
      (f) =>
        f.isUpcoming && (f.status === "delayed" || f.status === "cancelled"),
    )
  );

  // Past flights
  const pastFlights = computed(() =>
    flights
      .filter((f) => !f.isUpcoming)
      .sort((a, b) => b.departureDate.localeCompare(a.departureDate))
  );

  // Group flights by trip (confirmation number)
  const trips = computed(() => {
    const tripMap: Record<string, TrackedTrip> = {};

    for (const flight of flights || []) {
      const conf = flight.confirmationNumber;
      if (!tripMap[conf]) {
        tripMap[conf] = {
          confirmationNumber: conf,
          flights: [],
          passengerName: flight.passengerName,
          hasUpcomingFlights: false,
          nextFlight: undefined,
        };
      }

      tripMap[conf].flights.push(flight);

      if (flight.isUpcoming && flight.status !== "cancelled") {
        tripMap[conf].hasUpcomingFlights = true;
        if (
          !tripMap[conf].nextFlight ||
          flight.daysUntilFlight < tripMap[conf].nextFlight!.daysUntilFlight
        ) {
          tripMap[conf].nextFlight = flight;
        }
      }

      if (flight.passengerName && !tripMap[conf].passengerName) {
        tripMap[conf].passengerName = flight.passengerName;
      }
    }

    // Sort trips by next flight date
    return Object.values(tripMap).sort((a, b) => {
      if (a.nextFlight && b.nextFlight) {
        return a.nextFlight.daysUntilFlight - b.nextFlight.daysUntilFlight;
      }
      if (a.nextFlight) return -1;
      if (b.nextFlight) return 1;
      return 0;
    });
  });

  // Next upcoming flight for preview
  const nextFlight = computed(() => upcomingFlights[0]);

  // ==========================================================================
  // PREVIEW UI
  // ==========================================================================

  const previewUI = (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "8px 12px",
      }}
    >
      {/* Badge with count */}
      <div
        style={{
          width: "36px",
          height: "36px",
          borderRadius: "8px",
          backgroundColor: computed(() =>
            checkInAvailable?.length > 0
              ? "#fef3c7"
              : activeAlerts?.length > 0
              ? "#fee2e2"
              : "#eff6ff"
          ),
          border: computed(() =>
            checkInAvailable?.length > 0
              ? "2px solid #f59e0b"
              : activeAlerts?.length > 0
              ? "2px solid #ef4444"
              : "2px solid #3b82f6"
          ),
          color: computed(() =>
            checkInAvailable?.length > 0
              ? "#92400e"
              : activeAlerts?.length > 0
              ? "#b91c1c"
              : "#1d4ed8"
          ),
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontWeight: "bold",
          fontSize: "16px",
        }}
      >
        {computed(() => upcomingFlights?.length || 0)}
      </div>
      <div>
        <div style={{ fontWeight: "600", fontSize: "14px" }}>
          United Flights
        </div>
        <div style={{ fontSize: "12px", color: "#6b7280" }}>
          {/* Check-in status */}
          <span
            style={{
              display: computed(() =>
                checkInAvailable?.length > 0 ? "inline" : "none"
              ),
              color: "#d97706",
              fontWeight: "600",
            }}
          >
            {computed(() => checkInAvailable?.length)} ready for check-in
          </span>
          {/* Next flight info */}
          <span
            style={{
              display: computed(() =>
                checkInAvailable?.length === 0 && nextFlight ? "inline" : "none"
              ),
            }}
          >
            {computed(() =>
              nextFlight
                ? `${nextFlight.departureAirport || "???"} → ${
                  nextFlight.arrivalAirport || "???"
                } ${formatDate(nextFlight.departureDate)}`
                : ""
            )}
          </span>
          {/* No upcoming flights */}
          <span
            style={{
              display: computed(() =>
                !nextFlight && upcomingFlights?.length === 0 ? "inline" : "none"
              ),
            }}
          >
            No upcoming flights
          </span>
        </div>
      </div>
    </div>
  );

  // ==========================================================================
  // FULL UI
  // ==========================================================================

  return {
    [NAME]: "United Flight Tracker",

    emailCount: unitedEmailCount,
    flights,
    upcomingFlights,
    checkInAvailable,
    activeAlerts,
    pastFlights,
    trips,
    previewUI,

    [UI]: (
      <ct-screen>
        <div slot="header">
          <ct-heading level={3}>United Flight Tracker</ct-heading>
        </div>

        <ct-vscroll flex showScrollbar>
          <ct-vstack padding="6" gap="4">
            {/* Auth UI */}
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
                  {unitedEmailCount} United emails found
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
                <span>{unitedEmailCount} emails</span>
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
                    color: "#1d4ed8",
                  }}
                >
                  {computed(() => upcomingFlights?.length || 0)}
                </div>
                <div style={{ fontSize: "12px", color: "#666" }}>
                  Upcoming Flights
                </div>
              </div>
              <div
                style={{
                  borderLeft: "1px solid #d1d5db",
                  paddingLeft: "16px",
                  display: computed(() =>
                    checkInAvailable?.length > 0 ? "block" : "none"
                  ),
                }}
              >
                <div
                  style={{
                    fontSize: "28px",
                    fontWeight: "bold",
                    color: "#d97706",
                  }}
                >
                  {computed(() => checkInAvailable?.length || 0)}
                </div>
                <div style={{ fontSize: "12px", color: "#666" }}>
                  Check-in Ready
                </div>
              </div>
              <div
                style={{
                  borderLeft: "1px solid #d1d5db",
                  paddingLeft: "16px",
                  display: computed(() =>
                    activeAlerts?.length > 0 ? "block" : "none"
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
                  {computed(() => activeAlerts?.length || 0)}
                </div>
                <div style={{ fontSize: "12px", color: "#666" }}>Alerts</div>
              </div>
            </div>

            {
              /* ================================================================
                CHECK-IN AVAILABLE SECTION (Yellow, top priority)
                ================================================================ */
            }
            <div
              style={{
                display: computed(() =>
                  checkInAvailable?.length > 0 ? "block" : "none"
                ),
              }}
            >
              <div
                style={{
                  padding: "16px",
                  backgroundColor: "#fef3c7",
                  borderRadius: "12px",
                  border: "2px solid #f59e0b",
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
                  <span style={{ fontSize: "24px" }}>✅</span>
                  <span
                    style={{
                      fontWeight: "700",
                      fontSize: "18px",
                      color: "#92400e",
                    }}
                  >
                    Check-In Available
                  </span>
                </div>
                <ct-vstack gap="3">
                  {checkInAvailable.map((flight) => (
                    <div
                      style={{
                        padding: "12px",
                        backgroundColor: "white",
                        borderRadius: "8px",
                        border: "1px solid #fbbf24",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          marginBottom: "8px",
                        }}
                      >
                        <span
                          style={{
                            fontWeight: "700",
                            fontSize: "14px",
                            color: "white",
                            backgroundColor: computed(() =>
                              getFlightColor(flight.flightNumber)
                            ),
                            padding: "3px 10px",
                            borderRadius: "4px",
                          }}
                        >
                          {flight.flightNumber}
                        </span>
                        <span
                          style={{
                            fontSize: "12px",
                            color: "#6b7280",
                            backgroundColor: "#f3f4f6",
                            padding: "2px 8px",
                            borderRadius: "4px",
                          }}
                        >
                          {flight.confirmationNumber}
                        </span>
                      </div>
                      <div
                        style={{
                          fontSize: "14px",
                          color: "#374151",
                          marginBottom: "4px",
                        }}
                      >
                        {flight.departureAirport || flight.departureCity} →{" "}
                        {flight.arrivalAirport || flight.arrivalCity}
                      </div>
                      <div style={{ fontSize: "12px", color: "#6b7280" }}>
                        {formatDate(flight.departureDate)} at{" "}
                        {formatTime(flight.departureTime)}
                        {computed(() =>
                          flight.seat ? ` • Seat ${flight.seat}` : ""
                        )}
                      </div>
                      <a
                        href="https://www.united.com/en/us/checkin"
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          display: "inline-block",
                          marginTop: "8px",
                          padding: "6px 16px",
                          backgroundColor: "#f59e0b",
                          color: "white",
                          borderRadius: "6px",
                          textDecoration: "none",
                          fontSize: "13px",
                          fontWeight: "600",
                        }}
                      >
                        Check In Now →
                      </a>
                    </div>
                  ))}
                </ct-vstack>
              </div>
            </div>

            {
              /* ================================================================
                ACTIVE ALERTS SECTION (Red, for delays/cancellations)
                ================================================================ */
            }
            <div
              style={{
                display: computed(() =>
                  activeAlerts?.length > 0 ? "block" : "none"
                ),
              }}
            >
              <div
                style={{
                  padding: "16px",
                  backgroundColor: "#fee2e2",
                  borderRadius: "12px",
                  border: "2px solid #ef4444",
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
                  <span style={{ fontSize: "24px" }}>⚠️</span>
                  <span
                    style={{
                      fontWeight: "700",
                      fontSize: "18px",
                      color: "#b91c1c",
                    }}
                  >
                    Flight Alerts
                  </span>
                </div>
                <ct-vstack gap="3">
                  {activeAlerts.map((flight) => (
                    <div
                      style={{
                        padding: "12px",
                        backgroundColor: "white",
                        borderRadius: "8px",
                        border: computed(() =>
                          flight.status === "cancelled"
                            ? "2px solid #dc2626"
                            : "2px solid #f87171"
                        ),
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          marginBottom: "8px",
                        }}
                      >
                        <span
                          style={{
                            fontWeight: "700",
                            fontSize: "14px",
                            color: "white",
                            backgroundColor: computed(() =>
                              getFlightColor(flight.flightNumber)
                            ),
                            padding: "3px 10px",
                            borderRadius: "4px",
                          }}
                        >
                          {flight.flightNumber}
                        </span>
                        <span
                          style={{
                            padding: "2px 8px",
                            borderRadius: "4px",
                            fontSize: "12px",
                            fontWeight: "600",
                            backgroundColor: computed(() =>
                              flight.status === "cancelled"
                                ? "#fee2e2"
                                : "#fef3c7"
                            ),
                            color: computed(() =>
                              flight.status === "cancelled"
                                ? "#dc2626"
                                : "#d97706"
                            ),
                          }}
                        >
                          {ifElse(
                            flight.status === "cancelled",
                            "CANCELLED",
                            "DELAYED",
                          )}
                        </span>
                      </div>
                      <div
                        style={{
                          fontSize: "14px",
                          color: "#374151",
                          marginBottom: "4px",
                        }}
                      >
                        {flight.departureAirport || flight.departureCity} →{" "}
                        {flight.arrivalAirport || flight.arrivalCity}
                      </div>
                      <div style={{ fontSize: "12px", color: "#6b7280" }}>
                        {formatDate(flight.departureDate)}
                        <span
                          style={{
                            color: "#dc2626",
                            marginLeft: "8px",
                            display: computed(() =>
                              flight.status === "delayed" && flight.delayMinutes
                                ? "inline"
                                : "none"
                            ),
                          }}
                        >
                          Delayed {computed(() => flight.delayMinutes || 0)} min
                        </span>
                        <span
                          style={{
                            color: "#059669",
                            marginLeft: "8px",
                            display: computed(() =>
                              flight.newDepartureTime ? "inline" : "none"
                            ),
                          }}
                        >
                          New time: {computed(() =>
                            flight.newDepartureTime
                              ? formatTime(flight.newDepartureTime)
                              : ""
                          )}
                        </span>
                      </div>
                    </div>
                  ))}
                </ct-vstack>
              </div>
            </div>

            {
              /* ================================================================
                UPCOMING FLIGHTS SECTION (Blue cards)
                ================================================================ */
            }
            <div
              style={{
                display: computed(() =>
                  upcomingFlights?.length > 0 ? "block" : "none"
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
                Upcoming Flights
              </h3>
              <ct-vstack gap="3">
                {upcomingFlights.map((flight) => (
                  <div
                    style={{
                      padding: "16px",
                      backgroundColor: "#eff6ff",
                      borderRadius: "12px",
                      border: "1px solid #3b82f6",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        marginBottom: "8px",
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
                            fontWeight: "700",
                            fontSize: "14px",
                            color: "white",
                            backgroundColor: computed(() =>
                              getFlightColor(flight.flightNumber)
                            ),
                            padding: "3px 10px",
                            borderRadius: "4px",
                          }}
                        >
                          {flight.flightNumber}
                        </span>
                        <span
                          style={{
                            padding: "2px 8px",
                            borderRadius: "4px",
                            fontSize: "11px",
                            fontWeight: "500",
                            backgroundColor: computed(() =>
                              flight.status === "delayed"
                                ? "#fef3c7"
                                : flight.status === "cancelled"
                                ? "#fee2e2"
                                : "#d1fae5"
                            ),
                            color: computed(() =>
                              flight.status === "delayed"
                                ? "#d97706"
                                : flight.status === "cancelled"
                                ? "#dc2626"
                                : "#059669"
                            ),
                            display: computed(() =>
                              flight.status !== "scheduled" ? "inline" : "none"
                            ),
                          }}
                        >
                          {flight.status.toUpperCase()}
                        </span>
                      </div>
                      <span
                        style={{
                          fontSize: "12px",
                          color: "#6b7280",
                          backgroundColor: "white",
                          padding: "4px 10px",
                          borderRadius: "4px",
                        }}
                      >
                        {flight.confirmationNumber}
                      </span>
                    </div>

                    {/* Route */}
                    <div
                      style={{
                        fontSize: "16px",
                        color: "#374151",
                        marginBottom: "8px",
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                      }}
                    >
                      <span style={{ fontWeight: "600" }}>
                        {flight.departureAirport || "???"}
                      </span>
                      <span style={{ color: "#9ca3af" }}>→</span>
                      <span style={{ fontWeight: "600" }}>
                        {flight.arrivalAirport || "???"}
                      </span>
                      <span
                        style={{
                          fontSize: "12px",
                          color: "#6b7280",
                          display: computed(() =>
                            flight.departureCity && flight.arrivalCity
                              ? "inline"
                              : "none"
                          ),
                        }}
                      >
                        ({computed(() =>
                          `${flight.departureCity || ""} to ${
                            flight.arrivalCity || ""
                          }`
                        )})
                      </span>
                    </div>

                    {/* Date and Time */}
                    <div
                      style={{
                        display: "flex",
                        gap: "16px",
                        fontSize: "14px",
                        color: "#374151",
                        marginBottom: "8px",
                      }}
                    >
                      <div>
                        <span style={{ fontWeight: "600" }}>
                          {formatDate(flight.departureDate)}
                        </span>
                        <span
                          style={{
                            marginLeft: "8px",
                            padding: "2px 6px",
                            backgroundColor: computed(() =>
                              flight.daysUntilFlight <= 1
                                ? "#fef3c7"
                                : "#e5e7eb"
                            ),
                            borderRadius: "4px",
                            fontSize: "12px",
                          }}
                        >
                          {ifElse(
                            flight.daysUntilFlight === 0,
                            "Today",
                            ifElse(
                              flight.daysUntilFlight === 1,
                              "Tomorrow",
                              `in ${flight.daysUntilFlight} days`,
                            ),
                          )}
                        </span>
                      </div>
                      <div>
                        {formatTime(flight.departureTime)}
                        <span
                          style={{
                            color: "#6b7280",
                            display: computed(() =>
                              flight.arrivalTime ? "inline" : "none"
                            ),
                          }}
                        >
                          {" "}
                          → {computed(() => formatTime(flight.arrivalTime))}
                        </span>
                      </div>
                    </div>

                    {/* Details Row */}
                    <div
                      style={{
                        display: "flex",
                        gap: "16px",
                        fontSize: "13px",
                        color: "#6b7280",
                      }}
                    >
                      <span
                        style={{
                          display: computed(
                            () => (flight.seat ? "inline" : "none"),
                          ),
                        }}
                      >
                        <strong>Seat:</strong>{" "}
                        {computed(() => flight.seat || "")}
                      </span>
                      <span
                        style={{
                          display: computed(
                            () => (flight.gate ? "inline" : "none"),
                          ),
                        }}
                      >
                        <strong>Gate:</strong>{" "}
                        {computed(() => flight.gate || "")}
                      </span>
                      <span
                        style={{
                          display: computed(
                            () => (flight.terminal ? "inline" : "none"),
                          ),
                        }}
                      >
                        <strong>Terminal:</strong>{" "}
                        {computed(() => flight.terminal || "")}
                      </span>
                    </div>
                  </div>
                ))}
              </ct-vstack>
            </div>

            {
              /* ================================================================
                PAST FLIGHTS SECTION (Collapsible, gray)
                ================================================================ */
            }
            <div
              style={{
                display: computed(() =>
                  pastFlights?.length > 0 ? "block" : "none"
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
                  Past Flights ({computed(() => pastFlights?.length || 0)})
                </summary>
                <ct-vstack gap="2">
                  {pastFlights.map((flight) => (
                    <div
                      style={{
                        padding: "12px",
                        backgroundColor: "#f9fafb",
                        borderRadius: "8px",
                        border: "1px solid #d1d5db",
                        opacity: 0.8,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "10px",
                          }}
                        >
                          <span
                            style={{
                              fontWeight: "600",
                              fontSize: "12px",
                              color: "white",
                              backgroundColor: computed(() =>
                                getFlightColor(flight.flightNumber)
                              ),
                              padding: "2px 8px",
                              borderRadius: "4px",
                            }}
                          >
                            {flight.flightNumber}
                          </span>
                          <span
                            style={{
                              color: "#6b7280",
                              fontSize: "14px",
                            }}
                          >
                            {flight.departureAirport} → {flight.arrivalAirport}
                          </span>
                        </div>
                        <span style={{ fontSize: "12px", color: "#9ca3af" }}>
                          {formatDate(flight.departureDate)}
                        </span>
                      </div>
                    </div>
                  ))}
                </ct-vstack>
              </details>
            </div>

            {
              /* ================================================================
                DEBUG VIEW (Collapsible)
                ================================================================ */
            }
            <div
              style={{
                marginTop: "24px",
                padding: "16px",
                backgroundColor: "#f9fafb",
                borderRadius: "8px",
                border: "1px solid #d1d5db",
                display: computed(() =>
                  unitedEmailCount > 0 ? "block" : "none"
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
                  Debug View ({unitedEmailCount} emails)
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
                    {emailAnalyses.map((item) => (
                      <div
                        style={{
                          padding: "12px",
                          backgroundColor: "white",
                          borderRadius: "6px",
                          border: computed(() =>
                            item.pending
                              ? "1px solid #fbbf24"
                              : item.error
                              ? "1px solid #ef4444"
                              : "1px solid #10b981"
                          ),
                          fontSize: "12px",
                        }}
                      >
                        <div
                          style={{ fontWeight: "600", marginBottom: "4px" }}
                        >
                          {item.emailSubject}
                        </div>
                        <div
                          style={{
                            fontSize: "11px",
                            color: "#6b7280",
                            marginBottom: "8px",
                          }}
                        >
                          Date: {item.emailDate}
                        </div>

                        {/* Pending */}
                        <div
                          style={{
                            display: item.pending ? "flex" : "none",
                            alignItems: "center",
                            gap: "4px",
                            color: "#f59e0b",
                          }}
                        >
                          <ct-loader size="sm" />
                          <span>Analyzing...</span>
                        </div>

                        {/* Error */}
                        <div
                          style={{
                            display: item.error ? "block" : "none",
                            color: "#dc2626",
                          }}
                        >
                          Error: {computed(
                            () => (item.error ? String(item.error) : ""),
                          )}
                        </div>

                        {/* Result */}
                        <div
                          style={{
                            display: computed(() =>
                              !item.pending && !item.error && item.result
                                ? "block"
                                : "none"
                            ),
                          }}
                        >
                          <div
                            style={{
                              padding: "8px",
                              backgroundColor: "#f3f4f6",
                              borderRadius: "4px",
                            }}
                          >
                            <div>
                              <strong>Type:</strong>{" "}
                              {computed(() => item.result?.emailType || "N/A")}
                            </div>
                            <div style={{ marginTop: "4px" }}>
                              <strong>Summary:</strong>{" "}
                              {computed(() => item.result?.summary || "N/A")}
                            </div>
                            <div style={{ marginTop: "4px" }}>
                              <strong>Flights:</strong> {computed(() =>
                                JSON.stringify(
                                  item.result?.flights || [],
                                  null,
                                  2,
                                )
                              )}
                            </div>
                            <div
                              style={{
                                marginTop: "4px",
                                display: computed(() =>
                                  item.result?.checkInAvailable !== undefined
                                    ? "block"
                                    : "none"
                                ),
                              }}
                            >
                              <strong>Check-in Available:</strong>{" "}
                              {computed(() =>
                                item.result?.checkInAvailable ? "Yes" : "No"
                              )}
                            </div>
                          </div>

                          {/* Raw email content */}
                          <details style={{ marginTop: "8px" }}>
                            <summary
                              style={{ cursor: "pointer", color: "#2563eb" }}
                            >
                              Show raw email content
                            </summary>
                            <pre
                              style={{
                                marginTop: "8px",
                                padding: "8px",
                                backgroundColor: "#f3f4f6",
                                borderRadius: "4px",
                                fontSize: "10px",
                                overflow: "auto",
                                maxHeight: "300px",
                                whiteSpace: "pre-wrap",
                              }}
                            >
                              {item.email.markdownContent}
                            </pre>
                          </details>
                        </div>
                      </div>
                    ))}
                  </ct-vstack>
                </div>
              </details>
            </div>

            {/* United Website Link */}
            <div style={{ marginTop: "16px", textAlign: "center" }}>
              <a
                href="https://www.united.com/"
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: "inline-block",
                  padding: "10px 20px",
                  backgroundColor: "#1d4ed8",
                  color: "white",
                  borderRadius: "8px",
                  textDecoration: "none",
                  fontWeight: "500",
                  fontSize: "14px",
                }}
              >
                Open United Website
              </a>
            </div>
          </ct-vstack>
        </ct-vscroll>
      </ct-screen>
    ),
  };
});
