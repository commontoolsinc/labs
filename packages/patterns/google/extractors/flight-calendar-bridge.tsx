/// <cts-enable />
/**
 * Flight Calendar Bridge
 *
 * A bridge pattern that discovers flight trackers and generates calendar events
 * with intelligent travel time blocks. This is the first implementation of a
 * generalizable "calendar enhancement" system.
 *
 * Features:
 * - Discovers flights via wish({ query: "#unitedFlights" })
 * - Discovers home/work addresses via wish({ query: "#profile" })
 * - Generates travel-to-airport events (with security buffer)
 * - Generates travel-from-airport events (with baggage buffer)
 * - Bay Area airport intelligence (SFO, OAK, SJC)
 * - Rush hour detection for travel time estimation
 * - Color-coded linked events (flight + travel same color family)
 *
 * Usage:
 * 1. Deploy a profile pattern with home address
 * 2. Deploy a united-flight-tracker with linked gmail auth
 * 3. Deploy this bridge pattern
 * 4. Link output events to a weekly calendar
 */
import {
  computed,
  derive,
  ifElse,
  NAME,
  pattern,
  UI,
  wish,
  Writable,
} from "commontools";
import type { Output as ProfileOutput } from "../../profile.tsx";

// =============================================================================
// TYPES
// =============================================================================

/** Address type from profile - duplicated here to avoid import issues */
interface Address {
  label: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

/** Flight data from united-flight-tracker */
interface TrackedFlight {
  key: string;
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
  status: "scheduled" | "delayed" | "cancelled" | "completed";
  delayMinutes?: number;
  newDepartureTime?: string;
  checkInAvailable: boolean;
  checkInDeadline?: string;
  isUpcoming: boolean;
  daysUntilFlight: number;
  passengerName?: string;
  emailIds: string[];
}

/** Output from united-flight-tracker */
interface FlightTrackerOutput {
  flights: TrackedFlight[];
  upcomingFlights: TrackedFlight[];
}

/** Calendar event compatible with weekly-calendar */
interface CalendarEvent {
  title: string;
  date: string; // YYYY-MM-DD
  startTime: string; // HH:MM
  endTime: string; // HH:MM
  color: string;
  notes: string;
  isHidden: boolean;
  eventId: string;
  // Extended fields for flight bridge
  eventType?: "flight" | "travel-to" | "travel-from";
  linkedFlightKey?: string;
}

/** A group of linked events for a single flight */
interface FlightEventGroup {
  flightKey: string;
  color: string;
  travelTo?: CalendarEvent;
  flight: CalendarEvent;
  travelFrom?: CalendarEvent;
}

// =============================================================================
// CONSTANTS - BAY AREA AIRPORTS
// =============================================================================

interface AirportInfo {
  name: string;
  defaultMinutes: number; // Default travel time from typical Bay Area location
  rushHourMinutes: number; // Rush hour travel time
  isHomeAirport: boolean; // Whether this is a Bay Area airport
}

const BAY_AREA_AIRPORTS: Record<string, AirportInfo> = {
  SFO: {
    name: "San Francisco International",
    defaultMinutes: 45,
    rushHourMinutes: 75,
    isHomeAirport: true,
  },
  OAK: {
    name: "Oakland International",
    defaultMinutes: 30,
    rushHourMinutes: 50,
    isHomeAirport: true,
  },
  SJC: {
    name: "San Jose International",
    defaultMinutes: 50,
    rushHourMinutes: 80,
    isHomeAirport: true,
  },
};

// Default travel time for non-Bay Area airports
const DEFAULT_TRAVEL_MINUTES = 60;

// Security buffer times (minutes before departure to arrive at airport)
const DOMESTIC_SECURITY_BUFFER = 90;
const INTERNATIONAL_SECURITY_BUFFER = 120;

// Baggage claim buffer (minutes after arrival before leaving airport)
const BAGGAGE_BUFFER = 30;

// International destinations (simplified list)
const INTERNATIONAL_AIRPORTS = new Set([
  "LHR",
  "CDG",
  "FRA",
  "NRT",
  "HND",
  "ICN",
  "PEK",
  "PVG",
  "HKG",
  "SIN",
  "SYD",
  "MEL",
  "AKL",
  "DXB",
  "AMS",
  "MAD",
  "FCO",
  "MUC",
  "ZRH",
  "GVA",
  "CPH",
  "ARN",
  "OSL",
  "HEL",
  "DUB",
  "MAN",
  "EDI",
  "GLA",
  "MEX",
  "GDL",
  "CUN",
  "GRU",
  "EZE",
  "SCL",
  "LIM",
  "BOG",
]);

// =============================================================================
// COLOR PALETTE - Matching event colors for flights and travel
// =============================================================================

const FLIGHT_COLORS = [
  { flight: "#3b82f6", travel: "#93c5fd" }, // Blue
  { flight: "#8b5cf6", travel: "#c4b5fd" }, // Purple
  { flight: "#06b6d4", travel: "#67e8f9" }, // Cyan
  { flight: "#10b981", travel: "#6ee7b7" }, // Emerald
  { flight: "#f59e0b", travel: "#fcd34d" }, // Amber
  { flight: "#ef4444", travel: "#fca5a5" }, // Red
  { flight: "#ec4899", travel: "#f9a8d4" }, // Pink
  { flight: "#6366f1", travel: "#a5b4fc" }, // Indigo
];

/**
 * Get a consistent color pair for a flight based on confirmation number.
 */
function getFlightColors(
  confirmationNumber: string,
): { flight: string; travel: string } {
  if (!confirmationNumber) return FLIGHT_COLORS[0];
  let hash = 0;
  for (let i = 0; i < confirmationNumber.length; i++) {
    hash = (hash * 31 + confirmationNumber.charCodeAt(i)) %
      FLIGHT_COLORS.length;
  }
  return FLIGHT_COLORS[hash];
}

// =============================================================================
// TIME HELPERS
// =============================================================================

/**
 * Convert HH:MM to minutes since midnight.
 */
function timeToMinutes(time: string): number {
  if (!time) return 0;
  const [h, m] = time.split(":").map(Number);
  return h * 60 + (m || 0);
}

/**
 * Convert minutes since midnight to HH:MM.
 */
function minutesToTime(minutes: number): string {
  // Handle day wraparound
  while (minutes < 0) minutes += 24 * 60;
  while (minutes >= 24 * 60) minutes -= 24 * 60;

  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

/**
 * Subtract minutes from a time string.
 */
function subtractMinutes(time: string, mins: number): string {
  return minutesToTime(timeToMinutes(time) - mins);
}

/**
 * Add minutes to a time string.
 */
function addMinutes(time: string, mins: number): string {
  return minutesToTime(timeToMinutes(time) + mins);
}

/**
 * Check if a time falls within rush hour (7-9 AM or 4-7 PM).
 */
function isRushHour(time: string): boolean {
  const mins = timeToMinutes(time);
  const hour = Math.floor(mins / 60);
  return (hour >= 7 && hour < 9) || (hour >= 16 && hour < 19);
}

/**
 * Format time for display (12-hour with AM/PM).
 */
function formatTime12h(time: string): string {
  if (!time) return "";
  const [h, m] = time.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const hour = h % 12 || 12;
  return `${hour}:${m.toString().padStart(2, "0")} ${period}`;
}

/**
 * Format date for display.
 */
function formatDate(dateStr: string): string {
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
 * Generate a deterministic event ID based on flight key and event type.
 * This ensures stable IDs across re-renders for calendar integration.
 */
function generateEventId(
  flightKey: string,
  eventType: "flight" | "travel-to" | "travel-from",
): string {
  return `${flightKey}-${eventType}`;
}

// =============================================================================
// TRAVEL TIME LOGIC
// =============================================================================

/**
 * Get travel time to/from an airport.
 */
function getTravelTime(airportCode: string, time: string): number {
  const airport = BAY_AREA_AIRPORTS[airportCode];
  if (!airport) return DEFAULT_TRAVEL_MINUTES;

  return isRushHour(time) ? airport.rushHourMinutes : airport.defaultMinutes;
}

/**
 * Check if a destination requires international security buffer.
 */
function isInternationalFlight(arrivalAirport: string): boolean {
  return INTERNATIONAL_AIRPORTS.has(arrivalAirport);
}

/**
 * Get security buffer time for a flight.
 */
function getSecurityBuffer(arrivalAirport: string): number {
  return isInternationalFlight(arrivalAirport)
    ? INTERNATIONAL_SECURITY_BUFFER
    : DOMESTIC_SECURITY_BUFFER;
}

// =============================================================================
// EVENT GENERATION
// =============================================================================

/**
 * Generate calendar events for a flight, including travel blocks.
 */
function generateFlightEvents(
  flight: TrackedFlight,
  _homeAddress: string | null,
): FlightEventGroup {
  const colors = getFlightColors(flight.confirmationNumber);

  // Main flight event
  const flightEvent: CalendarEvent = {
    title:
      `${flight.flightNumber} ${flight.departureAirport} -> ${flight.arrivalAirport}`,
    date: flight.departureDate,
    startTime: flight.departureTime || "12:00",
    endTime: flight.arrivalTime ||
      addMinutes(flight.departureTime || "12:00", 180),
    color: colors.flight,
    notes: [
      `Confirmation: ${flight.confirmationNumber}`,
      flight.seat ? `Seat: ${flight.seat}` : null,
      flight.gate ? `Gate: ${flight.gate}` : null,
      flight.terminal ? `Terminal: ${flight.terminal}` : null,
      flight.status === "delayed" && flight.delayMinutes
        ? `DELAYED ${flight.delayMinutes} min`
        : null,
    ]
      .filter(Boolean)
      .join("\n"),
    isHidden: false,
    eventId: generateEventId(flight.key, "flight"),
    eventType: "flight",
    linkedFlightKey: flight.key,
  };

  const group: FlightEventGroup = {
    flightKey: flight.key,
    color: colors.flight,
    flight: flightEvent,
  };

  // Generate travel-to event for departures from Bay Area
  const departureAirport = BAY_AREA_AIRPORTS[flight.departureAirport];
  if (departureAirport?.isHomeAirport && flight.departureTime) {
    const securityBuffer = getSecurityBuffer(flight.arrivalAirport);
    const arriveAtAirportTime = subtractMinutes(
      flight.departureTime,
      securityBuffer,
    );
    const travelTime = getTravelTime(
      flight.departureAirport,
      arriveAtAirportTime,
    );
    const leaveHomeTime = subtractMinutes(arriveAtAirportTime, travelTime);

    group.travelTo = {
      title: `Travel to ${flight.departureAirport}`,
      date: flight.departureDate,
      startTime: leaveHomeTime,
      endTime: arriveAtAirportTime,
      color: colors.travel,
      notes: [
        `For flight ${flight.flightNumber}`,
        `Arrive at airport by ${formatTime12h(arriveAtAirportTime)}`,
        isRushHour(leaveHomeTime) ? "Rush hour - allow extra time" : null,
      ]
        .filter(Boolean)
        .join("\n"),
      isHidden: false,
      eventId: generateEventId(flight.key, "travel-to"),
      eventType: "travel-to",
      linkedFlightKey: flight.key,
    };
  }

  // Generate travel-from event for arrivals to Bay Area
  const arrivalAirport = BAY_AREA_AIRPORTS[flight.arrivalAirport];
  if (arrivalAirport?.isHomeAirport && flight.arrivalTime) {
    const leaveAirportTime = addMinutes(flight.arrivalTime, BAGGAGE_BUFFER);
    const travelTime = getTravelTime(flight.arrivalAirport, leaveAirportTime);
    const arriveHomeTime = addMinutes(leaveAirportTime, travelTime);

    group.travelFrom = {
      title: `Travel from ${flight.arrivalAirport}`,
      date: flight.departureDate, // Same day as flight (may need adjustment for overnight)
      startTime: leaveAirportTime,
      endTime: arriveHomeTime,
      color: colors.travel,
      notes: [
        `After flight ${flight.flightNumber}`,
        `Land at ${formatTime12h(flight.arrivalTime)}`,
        isRushHour(leaveAirportTime) ? "Rush hour - allow extra time" : null,
      ]
        .filter(Boolean)
        .join("\n"),
      isHidden: false,
      eventId: generateEventId(flight.key, "travel-from"),
      eventType: "travel-from",
      linkedFlightKey: flight.key,
    };
  }

  return group;
}

// =============================================================================
// PATTERN
// =============================================================================

// deno-lint-ignore no-empty-interface
interface PatternInput {
  // No required inputs - discovers via wish()
}

/** Flight calendar bridge - generates travel events from flights. #flightCalendar */
interface PatternOutput {
  flightCount: number;
  events: CalendarEvent[];
  flightEvents: CalendarEvent[];
  travelEvents: CalendarEvent[];
  eventGroups: FlightEventGroup[];
  homeAddress: string | null;
  isConnected: boolean;
}

export default pattern<PatternInput, PatternOutput>(() => {
  // Discover flight tracker via wish
  const flightTrackerWish = wish<FlightTrackerOutput>({
    query: "#unitedFlights",
  });

  // Discover profile via wish
  const profileWish = wish<ProfileOutput>({ query: "#profile" });

  // Access the result from wish (WishState has a result property)
  const flightTrackerResult = flightTrackerWish.result;
  const profileResult = profileWish.result;

  // Use derive to extract upcomingFlights from the charm result
  const upcomingFlights = derive(
    flightTrackerResult,
    (tracker) => tracker?.upcomingFlights ?? [],
  );

  // Extract home address from profile using derive
  const homeAddress = derive(
    profileResult,
    (prof: ProfileOutput | undefined) => {
      const addrs = prof?.addresses ?? [];
      const home = addrs.find((a: Address) => a.label === "Home");
      if (home && home.street) {
        return `${home.street}, ${home.city}, ${home.state} ${home.zip}`.trim();
      }
      return null;
    },
  );

  // Check if we have flight data
  const isConnected = computed(() => {
    return flightTrackerResult !== undefined;
  });

  // Generate event groups for each flight
  const eventGroups = computed(() => {
    const flights = upcomingFlights;
    const addr = homeAddress;
    return flights
      .filter((f) => f.status !== "cancelled")
      .map((f) => generateFlightEvents(f, addr));
  });

  // Flatten to all events
  const allEvents = computed(() => {
    const events: CalendarEvent[] = [];
    for (const group of eventGroups) {
      if (group.travelTo) events.push(group.travelTo);
      events.push(group.flight);
      if (group.travelFrom) events.push(group.travelFrom);
    }
    return events;
  });

  // Just flight events
  const flightEvents = computed(() => {
    return allEvents.filter((e) => e.eventType === "flight");
  });

  // Just travel events
  const travelEvents = computed(() => {
    return allEvents.filter(
      (e) => e.eventType === "travel-to" || e.eventType === "travel-from",
    );
  });

  // Flight count
  const flightCount = computed(() => upcomingFlights?.length ?? 0);

  // State for expanded sections (reserved for future debug UI)
  const _showDebug = Writable.of(false);

  return {
    [NAME]: computed(() => `Flight Calendar (${flightCount} flights)`),

    flightCount,
    events: allEvents,
    flightEvents,
    travelEvents,
    eventGroups,
    homeAddress,
    isConnected,

    [UI]: (
      <ct-screen>
        <div slot="header">
          <ct-heading level={3}>Flight Calendar Bridge</ct-heading>
        </div>

        <ct-vscroll flex showScrollbar>
          <ct-vstack padding="6" gap="4">
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
                    backgroundColor: computed(() =>
                      isConnected ? "#10b981" : "#f59e0b"
                    ),
                  }}
                />
                <span>
                  {ifElse(
                    isConnected,
                    "Connected to flight tracker",
                    "Looking for flight tracker (#unitedFlights)...",
                  )}
                </span>
              </div>
            </div>

            {/* Profile Status */}
            <div
              style={{
                padding: "12px 16px",
                backgroundColor: computed(() =>
                  homeAddress ? "#eff6ff" : "#f3f4f6"
                ),
                borderRadius: "8px",
                border: computed(() =>
                  homeAddress ? "1px solid #3b82f6" : "1px solid #d1d5db"
                ),
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                }}
              >
                <span style={{ fontSize: "16px" }}>
                  {ifElse(homeAddress, "Home address found", "No home address")}
                </span>
              </div>
              <div
                style={{
                  fontSize: "12px",
                  color: "#6b7280",
                  marginTop: "4px",
                  display: computed(() => (homeAddress ? "block" : "none")),
                }}
              >
                {homeAddress}
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
                  {flightCount}
                </div>
                <div style={{ fontSize: "12px", color: "#666" }}>
                  Upcoming Flights
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
                  {computed(() => allEvents?.length ?? 0)}
                </div>
                <div style={{ fontSize: "12px", color: "#666" }}>
                  Calendar Events
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
                    color: "#d97706",
                  }}
                >
                  {computed(() => travelEvents?.length ?? 0)}
                </div>
                <div style={{ fontSize: "12px", color: "#666" }}>
                  Travel Blocks
                </div>
              </div>
            </div>

            {/* Event Groups */}
            <div
              style={{
                display: computed(() =>
                  eventGroups?.length > 0 ? "block" : "none"
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
                Generated Events
              </h3>
              <ct-vstack gap="4">
                {eventGroups.map((group) => (
                  <div
                    style={{
                      padding: "16px",
                      backgroundColor: "#fff",
                      borderRadius: "12px",
                      border: "1px solid #e5e7eb",
                      boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
                    }}
                  >
                    {/* Travel To */}
                    {ifElse(
                      computed(() => !!group.travelTo),
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "12px",
                          padding: "8px 12px",
                          marginBottom: "8px",
                          backgroundColor: computed(() =>
                            group.travelTo?.color ?? "#f3f4f6"
                          ),
                          borderRadius: "8px",
                        }}
                      >
                        <span style={{ fontSize: "16px" }}>car</span>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: "600", fontSize: "14px" }}>
                            {computed(() => group.travelTo?.title ?? "")}
                          </div>
                          <div style={{ fontSize: "12px", color: "#374151" }}>
                            {computed(() =>
                              group.travelTo
                                ? `${
                                  formatTime12h(group.travelTo.startTime)
                                } - ${formatTime12h(group.travelTo.endTime)}`
                                : ""
                            )}
                          </div>
                        </div>
                      </div>,
                      null,
                    )}

                    {/* Flight */}
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "12px",
                        padding: "12px",
                        backgroundColor: group.color,
                        borderRadius: "8px",
                        color: "white",
                      }}
                    >
                      <span style={{ fontSize: "20px" }}>plane</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: "700", fontSize: "15px" }}>
                          {group.flight.title}
                        </div>
                        <div style={{ fontSize: "13px", opacity: 0.9 }}>
                          {formatDate(group.flight.date)} |{" "}
                          {formatTime12h(group.flight.startTime)} -{" "}
                          {formatTime12h(group.flight.endTime)}
                        </div>
                      </div>
                    </div>

                    {/* Travel From */}
                    {ifElse(
                      computed(() => !!group.travelFrom),
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "12px",
                          padding: "8px 12px",
                          marginTop: "8px",
                          backgroundColor: computed(() =>
                            group.travelFrom?.color ?? "#f3f4f6"
                          ),
                          borderRadius: "8px",
                        }}
                      >
                        <span style={{ fontSize: "16px" }}>car</span>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: "600", fontSize: "14px" }}>
                            {computed(() => group.travelFrom?.title ?? "")}
                          </div>
                          <div style={{ fontSize: "12px", color: "#374151" }}>
                            {computed(() =>
                              group.travelFrom
                                ? `${
                                  formatTime12h(group.travelFrom.startTime)
                                } - ${formatTime12h(group.travelFrom.endTime)}`
                                : ""
                            )}
                          </div>
                        </div>
                      </div>,
                      null,
                    )}
                  </div>
                ))}
              </ct-vstack>
            </div>

            {/* No flights message */}
            <div
              style={{
                display: computed(() =>
                  isConnected && flightCount === 0 ? "block" : "none"
                ),
                padding: "24px",
                textAlign: "center",
                color: "#6b7280",
              }}
            >
              <div style={{ fontSize: "48px", marginBottom: "12px" }}>
                plane
              </div>
              <div style={{ fontSize: "16px" }}>No upcoming flights found</div>
              <div style={{ fontSize: "14px", marginTop: "8px" }}>
                Flight events will appear here when detected in your email
              </div>
            </div>

            {/* Debug Section */}
            <details style={{ marginTop: "16px" }}>
              <summary
                style={{
                  cursor: "pointer",
                  fontSize: "14px",
                  color: "#6b7280",
                  fontWeight: "500",
                }}
              >
                Debug Info
              </summary>
              <div
                style={{
                  marginTop: "12px",
                  padding: "12px",
                  backgroundColor: "#f9fafb",
                  borderRadius: "8px",
                  fontSize: "12px",
                }}
              >
                <div style={{ marginBottom: "8px" }}>
                  <strong>Bay Area Airports:</strong> SFO, OAK, SJC
                </div>
                <div style={{ marginBottom: "8px" }}>
                  <strong>Domestic Security Buffer:</strong>{" "}
                  {DOMESTIC_SECURITY_BUFFER} min
                </div>
                <div style={{ marginBottom: "8px" }}>
                  <strong>International Security Buffer:</strong>{" "}
                  {INTERNATIONAL_SECURITY_BUFFER} min
                </div>
                <div style={{ marginBottom: "8px" }}>
                  <strong>Baggage Buffer:</strong> {BAGGAGE_BUFFER} min
                </div>
                <div style={{ marginBottom: "8px" }}>
                  <strong>Rush Hours:</strong> 7-9 AM, 4-7 PM
                </div>
                <div style={{ marginTop: "12px" }}>
                  <strong>Raw Events:</strong>
                  <pre
                    style={{
                      marginTop: "4px",
                      padding: "8px",
                      backgroundColor: "#fff",
                      borderRadius: "4px",
                      overflow: "auto",
                      maxHeight: "200px",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {computed(() => JSON.stringify(allEvents, null, 2))}
                  </pre>
                </div>
              </div>
            </details>

            {/* Instructions */}
            <div
              style={{
                marginTop: "16px",
                padding: "16px",
                backgroundColor: "#eff6ff",
                borderRadius: "8px",
                border: "1px solid #3b82f6",
              }}
            >
              <h4
                style={{
                  fontSize: "14px",
                  fontWeight: "600",
                  marginBottom: "8px",
                  color: "#1d4ed8",
                }}
              >
                How to use
              </h4>
              <ol
                style={{
                  fontSize: "13px",
                  color: "#374151",
                  paddingLeft: "20px",
                  margin: 0,
                }}
              >
                <li style={{ marginBottom: "4px" }}>
                  Deploy a profile pattern and add your home address
                </li>
                <li style={{ marginBottom: "4px" }}>
                  Deploy a United flight tracker with Gmail auth linked
                </li>
                <li style={{ marginBottom: "4px" }}>
                  Link the `events` output to a weekly calendar
                </li>
              </ol>
            </div>
          </ct-vstack>
        </ct-vscroll>
      </ct-screen>
    ),
  };
});
