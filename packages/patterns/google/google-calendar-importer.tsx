/// <cts-enable />
import {
  computed,
  Default,
  derive,
  getRecipeEnvironment,
  handler,
  ifElse,
  NAME,
  pattern,
  patternTool,
  str,
  UI,
  Writable,
} from "commontools";
import {
  createGoogleAuth,
  type ScopeKey,
} from "./util/google-auth-manager.tsx";

type CFC<T, C extends string> = T;
type Secret<T> = CFC<T, "secret">;
type Confidential<T> = CFC<T, "confidential">;

// This is used by the various Google tokens created with tokenToAuthData
export type Auth = {
  token: Default<Secret<string>, "">;
  tokenType: Default<string, "">;
  scope: Default<string[], []>;
  expiresIn: Default<number, 0>;
  expiresAt: Default<number, 0>;
  refreshToken: Default<Secret<string>, "">;
  user: Default<{
    email: string;
    name: string;
    picture: string;
  }, { email: ""; name: ""; picture: "" }>;
};

const env = getRecipeEnvironment();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ========== DERIVE DEBUG INSTRUMENTATION ==========
// Track derive execution counts to investigate performance issues
let deriveCallCount = 0;
let perRowDeriveCount = 0;
let lastLogTime = Date.now();
let startTime = Date.now();

function logDeriveCall(name: string, isPerRow = false) {
  deriveCallCount++;
  if (isPerRow) perRowDeriveCount++;
  const now = Date.now();
  const elapsed = now - startTime;
  // Log on milestones or every second
  if (now - lastLogTime > 1000 || deriveCallCount % 100 === 0) {
    console.log(
      `[DERIVE DEBUG] ${name}: total=${deriveCallCount}, perRow=${perRowDeriveCount}, elapsed=${elapsed}ms`,
    );
    lastLogTime = now;
  }
}

// Start summary interval - using try/catch to handle server vs browser execution
try {
  setInterval(() => {
    const elapsed = Date.now() - startTime;
    console.log(
      `[DERIVE DEBUG SUMMARY] total=${deriveCallCount}, perRow=${perRowDeriveCount}, elapsed=${elapsed}ms`,
    );
  }, 5000);
} catch {
  // Ignore if setInterval isn't available during compilation
}
// ========== END DEBUG INSTRUMENTATION ==========

export type CalendarEvent = {
  id: string;
  summary: string;
  description: string;
  location: string;
  start: string;
  end: string;
  startDateTime: string;
  endDateTime: string;
  isAllDay: boolean;
  status: string;
  htmlLink: string;
  calendarId: string;
  calendarName: string;
  attendees: Default<
    { email: string; displayName: string; responseStatus: string }[],
    []
  >;
  organizer: { email: string; displayName: string };
};

export type Calendar = {
  id: string;
  summary: string;
  description: string;
  primary: boolean;
  backgroundColor: string;
  foregroundColor: string;
};

type Settings = {
  // Number of days in the past to fetch
  daysBack: Default<number, 7>;
  // Number of days in the future to fetch
  daysForward: Default<number, 30>;
  // Maximum number of events to fetch per calendar
  maxResults: Default<number, 100>;
  // Enable verbose console logging for debugging
  debugMode: Default<boolean, false>;
};

// Debug logging helpers
function debugLog(debugMode: boolean, ...args: unknown[]) {
  if (debugMode) console.log(...args);
}
function debugWarn(debugMode: boolean, ...args: unknown[]) {
  if (debugMode) console.warn(...args);
}

interface CalendarClientConfig {
  retries?: number;
  delay?: number;
  delayIncrement?: number;
  debugMode?: boolean;
}

// Helper function to parse calendar API response (extracted to module scope for compiler compliance)
function parseCalendarApiItem(apiItem: any): Calendar {
  return {
    id: apiItem.id,
    summary: apiItem.summary || "",
    description: apiItem.description || "",
    primary: apiItem.primary || false,
    backgroundColor: apiItem.backgroundColor || "#4285f4",
    foregroundColor: apiItem.foregroundColor || "#ffffff",
  };
}

class CalendarClient {
  private auth: Writable<Auth>;
  private retries: number;
  private delay: number;
  private delayIncrement: number;
  private debugMode: boolean;

  constructor(
    auth: Writable<Auth>,
    { retries = 3, delay = 1000, delayIncrement = 100, debugMode = false }:
      CalendarClientConfig = {},
  ) {
    this.auth = auth;
    this.retries = retries;
    this.delay = delay;
    this.delayIncrement = delayIncrement;
    this.debugMode = debugMode;
  }

  private async refreshAuth() {
    const body = {
      refreshToken: this.auth.get().refreshToken,
    };

    debugLog(this.debugMode, "refreshAuthToken", body);

    const res = await fetch(
      new URL("/api/integrations/google-oauth/refresh", env.apiUrl),
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      throw new Error("Could not acquire a refresh token.");
    }
    const json = await res.json();
    const authData = json.tokenInfo as Auth;
    this.auth.update(authData);
  }

  async getCalendarList(): Promise<Calendar[]> {
    const url = new URL(
      "https://www.googleapis.com/calendar/v3/users/me/calendarList",
    );
    const res = await this.googleRequest(url);
    const json = await res.json();

    if (!json.items || !Array.isArray(json.items)) {
      debugLog(this.debugMode, "No calendars found:", json);
      return [];
    }

    return json.items.map(parseCalendarApiItem);
  }

  async getEvents(
    calendarId: string,
    timeMin: Date,
    timeMax: Date,
    maxResults: number = 100,
  ): Promise<any[]> {
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${
        encodeURIComponent(calendarId)
      }/events`,
    );
    url.searchParams.set("timeMin", timeMin.toISOString());
    url.searchParams.set("timeMax", timeMax.toISOString());
    url.searchParams.set("maxResults", maxResults.toString());
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");

    debugLog(this.debugMode, "Fetching events from:", url.toString());

    const res = await this.googleRequest(url);
    const json = await res.json();

    if (!json.items || !Array.isArray(json.items)) {
      debugLog(this.debugMode, "No events found:", json);
      return [];
    }

    return json.items;
  }

  private async googleRequest(
    url: URL,
    _options?: RequestInit,
    _retries?: number,
  ): Promise<Response> {
    const token = this.auth.get().token;
    if (!token) {
      throw new Error("No authorization token.");
    }

    const retries = _retries ?? this.retries;
    const options = _options ?? {};
    options.headers = new Headers(options.headers);
    options.headers.set("Authorization", `Bearer ${token}`);

    const res = await fetch(url, options);
    let { ok, status, statusText } = res;

    if (ok) {
      debugLog(this.debugMode, `${url}: ${status} ${statusText}`);
      return res;
    }

    debugWarn(
      this.debugMode,
      `${url}: ${status} ${statusText}`,
      `Remaining retries: ${retries}`,
    );
    if (retries === 0) {
      throw new Error("Too many failed attempts.");
    }

    await sleep(this.delay);

    if (status === 401) {
      await this.refreshAuth();
    } else if (status === 429) {
      this.delay += this.delayIncrement;
      debugLog(this.debugMode, `Incrementing delay to ${this.delay}`);
      await sleep(this.delay);
    }
    return this.googleRequest(url, _options, retries - 1);
  }
}

function parseCalendarEvent(
  event: any,
  calendarId: string,
  calendarName: string,
): CalendarEvent {
  const isAllDay = !event.start?.dateTime;
  const startDateTime = event.start?.dateTime || event.start?.date || "";
  const endDateTime = event.end?.dateTime || event.end?.date || "";

  return {
    id: event.id || "",
    summary: event.summary || "(No title)",
    description: event.description || "",
    location: event.location || "",
    start: event.start?.date || event.start?.dateTime?.split("T")[0] || "",
    end: event.end?.date || event.end?.dateTime?.split("T")[0] || "",
    startDateTime,
    endDateTime,
    isAllDay,
    status: event.status || "confirmed",
    htmlLink: event.htmlLink || "",
    calendarId,
    calendarName,
    attendees: (event.attendees || []).map((a: any) => ({
      email: a.email || "",
      displayName: a.displayName || a.email || "",
      responseStatus: a.responseStatus || "needsAction",
    })),
    organizer: {
      email: event.organizer?.email || "",
      displayName: event.organizer?.displayName || event.organizer?.email || "",
    },
  };
}

const calendarUpdater = handler<unknown, {
  events: Writable<CalendarEvent[]>;
  calendars: Writable<Calendar[]>;
  auth: Writable<Auth>;
  settings: Writable<{
    daysBack: number;
    daysForward: number;
    maxResults: number;
    debugMode: boolean;
  }>;
  fetching?: Writable<boolean>;
}>(
  async (_event, state) => {
    // Set fetching state if available
    if (state.fetching) {
      state.fetching.set(true);
    }
    const debugMode = state.settings.get().debugMode || false;

    debugLog(debugMode, "calendarUpdater!");

    if (!state.auth.get().token) {
      debugWarn(debugMode, "no token found in auth cell");
      if (state.fetching) state.fetching.set(false);
      return;
    }

    const settings = state.settings.get();
    const client = new CalendarClient(state.auth, { debugMode });

    try {
      // Get calendar list
      debugLog(debugMode, "Fetching calendar list...");
      const calendars = await client.getCalendarList();
      debugLog(debugMode, `Found ${calendars.length} calendars`);
      state.calendars.set(calendars);

      // Calculate time range
      const now = new Date();
      const timeMin = new Date(now);
      timeMin.setDate(timeMin.getDate() - settings.daysBack);
      const timeMax = new Date(now);
      timeMax.setDate(timeMax.getDate() + settings.daysForward);

      debugLog(
        debugMode,
        `Time range: ${timeMin.toISOString()} to ${timeMax.toISOString()}`,
      );

      // Fetch events from all calendars
      const allEvents: CalendarEvent[] = [];

      for (const calendar of calendars) {
        try {
          debugLog(
            debugMode,
            `Fetching events from calendar: ${calendar.summary} (${calendar.id})`,
          );
          const rawEvents = await client.getEvents(
            calendar.id,
            timeMin,
            timeMax,
            settings.maxResults,
          );

          const events = rawEvents.map((e) =>
            parseCalendarEvent(e, calendar.id, calendar.summary)
          );
          debugLog(
            debugMode,
            `Found ${events.length} events in ${calendar.summary}`,
          );
          allEvents.push(...events);

          // Small delay between calendar requests to avoid rate limiting
          await sleep(200);
        } catch (error) {
          debugWarn(
            debugMode,
            `Error fetching events from ${calendar.summary}:`,
            error,
          );
        }
      }

      // Sort events by start time
      allEvents.sort((a, b) => {
        const aStart = new Date(a.startDateTime || a.start).getTime();
        const bStart = new Date(b.startDateTime || b.start).getTime();
        return aStart - bStart;
      });

      debugLog(debugMode, `Total events fetched: ${allEvents.length}`);
      state.events.set(allEvents);
    } finally {
      // Clear fetching state
      if (state.fetching) state.fetching.set(false);
    }
  },
);

const toggleDebugMode = handler<
  { target: { checked: boolean } },
  { settings: Writable<Settings> }
>(
  ({ target }, { settings }) => {
    const current = settings.get();
    settings.set({ ...current, debugMode: target.checked });
  },
);

const nextPage = handler<unknown, { currentPage: Writable<number> }>(
  (_, { currentPage }) => {
    currentPage.set(currentPage.get() + 1);
  },
);

const prevPage = handler<unknown, { currentPage: Writable<number> }>(
  (_, { currentPage }) => {
    const current = currentPage.get();
    if (current > 0) {
      currentPage.set(current - 1);
    }
  },
);

// Format date for display
function formatEventDate(
  startDateTime: string,
  endDateTime: string,
  isAllDay: boolean,
): string {
  if (isAllDay) {
    return startDateTime;
  }
  const start = new Date(startDateTime);
  const end = new Date(endDateTime);
  const dateStr = start.toLocaleDateString();
  const startTime = start.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const endTime = end.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${dateStr} ${startTime} - ${endTime}`;
}

// ============================================================================
// PatternTool Helpers (at module scope for compiler compliance)
// ============================================================================

const searchEventsImpl = (
  { query, events }: { query: string; events: CalendarEvent[] },
) => {
  return derive({ query, events }, ({ query, events }) => {
    if (!query || !events) return [];
    const lowerQuery = query.toLowerCase();
    return events.filter((event) =>
      event.summary?.toLowerCase().includes(lowerQuery) ||
      event.description?.toLowerCase().includes(lowerQuery) ||
      event.location?.toLowerCase().includes(lowerQuery)
    );
  });
};

const getEventCountImpl = ({ events }: { events: CalendarEvent[] }) => {
  return derive(events, (list) => list?.length || 0);
};

const getUpcomingEventsImpl = (
  { count, events }: { count: number; events: CalendarEvent[] },
) => {
  return derive({ count, events }, ({ count, events }) => {
    if (!events || events.length === 0) return "No events";
    const now = new Date();
    const upcoming = events
      .filter((e) => new Date(e.startDateTime || e.start) >= now)
      .slice(0, count || 5);
    return upcoming.map((event) =>
      `${
        formatEventDate(event.startDateTime, event.endDateTime, event.isAllDay)
      }: ${event.summary}${event.location ? ` @ ${event.location}` : ""}`
    ).join("\n");
  });
};

const getTodaysEventsImpl = ({ events }: { events: CalendarEvent[] }) => {
  return derive(events, (events) => {
    if (!events || events.length === 0) return "No events";
    const today = new Date().toISOString().split("T")[0];
    const todayEvents = events.filter((e) =>
      e.start === today ||
      (e.startDateTime && e.startDateTime.startsWith(today))
    );
    if (todayEvents.length === 0) return "No events today";
    return todayEvents.map((event) =>
      `${
        formatEventDate(event.startDateTime, event.endDateTime, event.isAllDay)
      }: ${event.summary}`
    ).join("\n");
  });
};

interface GoogleCalendarImporterInput {
  settings?: Default<Settings, {
    daysBack: 7;
    daysForward: 30;
    maxResults: 100;
    debugMode: false;
  }>;
}

/** Google Calendar event importer. #calendarEvents */
interface Output {
  events: CalendarEvent[];
  calendars: Calendar[];
  /** Number of events imported */
  eventCount: number;
}

const GoogleCalendarImporter = pattern<GoogleCalendarImporterInput, Output>(
  ({ settings }) => {
    const events = Writable.of<Confidential<CalendarEvent[]>>([]);
    const calendars = Writable.of<Calendar[]>([]);
    const fetching = Writable.of(false);
    const currentPage = Writable.of(0);
    const PAGE_SIZE = 10;

    // Use createGoogleAuth utility for auth management
    const { auth, fullUI, isReady, currentEmail } = createGoogleAuth({
      requiredScopes: ["calendar"] as ScopeKey[],
    });

    // Computed values for pagination
    const upcomingEvents = derive(events, (evts: CalendarEvent[]) => {
      const now = new Date();
      return [...evts]
        .filter((e) => new Date(e.startDateTime || e.start) >= now)
        .sort((a, b) =>
          new Date(a.startDateTime || a.start).getTime() -
          new Date(b.startDateTime || b.start).getTime()
        );
    });

    const totalUpcoming = derive(
      upcomingEvents,
      (evts: CalendarEvent[]) => evts.length,
    );
    const maxPageNum = derive(
      totalUpcoming,
      (total: number) => Math.max(0, Math.ceil(total / PAGE_SIZE) - 1),
    );

    // Paginated events for display - use computed with events Cell directly
    const paginatedEvents = computed(() => {
      const allEvents = events.get() || [];
      const now = new Date();
      const upcoming = [...allEvents]
        .filter((e: CalendarEvent) =>
          new Date(e.startDateTime || e.start) >= now
        )
        .sort((a: CalendarEvent, b: CalendarEvent) =>
          new Date(a.startDateTime || a.start).getTime() -
          new Date(b.startDateTime || b.start).getTime()
        );
      const page = currentPage.get();
      const start = page * PAGE_SIZE;
      const end = Math.min(start + PAGE_SIZE, upcoming.length);
      return upcoming.slice(start, end);
    });

    return {
      [NAME]: str`Calendar Importer ${currentEmail}`,
      [UI]: (
        <ct-screen>
          <div slot="header">
            <ct-hstack align="center" gap="2">
              <ct-heading level={3}>Google Calendar Importer</ct-heading>
            </ct-hstack>
          </div>

          <ct-vscroll flex showScrollbar>
            <ct-vstack padding="6" gap="4">
              {/* Auth status - handled by createGoogleAuth utility */}
              {fullUI}

              <h3 style={{ fontSize: "18px", fontWeight: "bold" }}>
                Imported event count: {computed(() => events.get().length)}
              </h3>

              <div style={{ fontSize: "14px", color: "#666" }}>
                Calendars found: {computed(() => calendars.get().length)}
              </div>

              <ct-vstack gap="4">
                <div>
                  <label
                    style={{
                      display: "block",
                      marginBottom: "4px",
                      fontSize: "14px",
                    }}
                  >
                    Days Back
                  </label>
                  <ct-input
                    type="number"
                    $value={settings.daysBack}
                    placeholder="7"
                  />
                </div>

                <div>
                  <label
                    style={{
                      display: "block",
                      marginBottom: "4px",
                      fontSize: "14px",
                    }}
                  >
                    Days Forward
                  </label>
                  <ct-input
                    type="number"
                    $value={settings.daysForward}
                    placeholder="30"
                  />
                </div>

                <div>
                  <label
                    style={{
                      display: "block",
                      marginBottom: "4px",
                      fontSize: "14px",
                    }}
                  >
                    Max Results per Calendar
                  </label>
                  <ct-input
                    type="number"
                    $value={settings.maxResults}
                    placeholder="100"
                  />
                </div>

                <div>
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      fontSize: "14px",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={settings.debugMode}
                      onChange={toggleDebugMode({ settings })}
                    />
                    Debug Mode (verbose console logging)
                  </label>
                </div>
                {ifElse(
                  isReady,
                  <ct-button
                    type="button"
                    onClick={calendarUpdater({
                      events,
                      calendars,
                      auth,
                      settings,
                      fetching,
                    })}
                    disabled={fetching}
                  >
                    {ifElse(
                      fetching,
                      <span
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                        }}
                      >
                        <ct-loader size="sm" show-elapsed></ct-loader>
                        Fetching...
                      </span>,
                      "Fetch Calendar Events",
                    )}
                  </ct-button>,
                  null,
                )}
              </ct-vstack>

              {/* Calendar list */}
              {ifElse(
                computed(() => calendars.get().length > 0),
                <div style={{ marginTop: "16px" }}>
                  <h4 style={{ fontSize: "16px", marginBottom: "8px" }}>
                    Your Calendars
                  </h4>
                  <div
                    style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}
                  >
                    {calendars.map((cal) => (
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "6px",
                          padding: "4px 10px",
                          borderRadius: "16px",
                          backgroundColor: cal.backgroundColor,
                          color: cal.foregroundColor,
                          fontSize: "12px",
                        }}
                      >
                        {ifElse(
                          cal.primary,
                          <span>★</span>,
                          <span />,
                        )}
                        {cal.summary}
                      </div>
                    ))}
                  </div>
                </div>,
                <div />,
              )}

              {
                /*
                 * Events summary - showing only count instead of full event list.
                 *
                 * NOTE: This minimal UI is intentional due to performance limitations.
                 * Rendering 200+ events with reactive cells causes Chrome CPU to spike
                 * to 100% for extended periods. Ideally we'd show all events in a full
                 * table/list view, but until the framework supports virtualization or
                 * more efficient rendering, we display just the summary.
                 *
                 * See: https://linear.app/common-tools/issue/CT-1111/performance-derive-inside-map-causes-8x-more-calls-than-expected-never
                 *
                 * The full event data is still available via the `events` output for
                 * other patterns to access via linking/wishing.
                 */
              }
              <div style={{ marginTop: "16px" }}>
                <h4 style={{ fontSize: "16px", margin: 0 }}>
                  {derive(
                    events,
                    (evts: CalendarEvent[]) => `${evts.length} events imported`,
                  )}
                </h4>
                <p
                  style={{ fontSize: "12px", color: "#666", marginTop: "8px" }}
                >
                  Full event data available for other patterns via linking.
                  (Event list hidden for performance - rendering 200+ items
                  causes CPU issues)
                </p>
              </div>
            </ct-vstack>
          </ct-vscroll>
        </ct-screen>
      ),
      events,
      calendars,
      eventCount: derive(events, (list: CalendarEvent[]) => {
        logDeriveCall(`eventCount (length=${list?.length})`);
        return list?.length || 0;
      }),
      bgUpdater: calendarUpdater({ events, calendars, auth, settings }),
      // Pattern tools for omnibot (implementations at module scope)
      searchEvents: patternTool(searchEventsImpl, { events }),
      getEventCount: patternTool(getEventCountImpl, { events }),
      getUpcomingEvents: patternTool(getUpcomingEventsImpl, { events }),
      getTodaysEvents: patternTool(getTodaysEventsImpl, { events }),
    };
  },
);

export default GoogleCalendarImporter;
