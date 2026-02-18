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

// ========== OPTIONAL DERIVE DEBUG INSTRUMENTATION ==========
// Set DEBUG_DERIVE=true to enable derive() call counting for performance investigation.
// IMPORTANT: Keep disabled in production - the setInterval has no cleanup mechanism.
const DEBUG_DERIVE = false;

let deriveCallCount = 0;
let perRowDeriveCount = 0;
let lastLogTime = Date.now();
const startTime = Date.now();

function logDeriveCall(name: string, isPerRow = false) {
  if (!DEBUG_DERIVE) return;
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

// Only start interval if debugging is enabled
if (DEBUG_DERIVE) {
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
    const { ok, status, statusText } = res;

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

// Core fetch logic extracted for reuse
type FetchState = {
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
  selectedCalendarIds?: Writable<string[]>;
};

async function fetchCalendarEvents(state: FetchState): Promise<void> {
  // Set fetching state if available
  if (state.fetching) {
    state.fetching.set(true);
  }
  const debugMode = state.settings.get().debugMode || false;

  debugLog(debugMode, "fetchCalendarEvents!");

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

    // Check if this is first fetch BEFORE fetching new calendars
    const previousCalendarCount = state.calendars.get().length;
    const currentSelected = state.selectedCalendarIds?.get() || [];

    const calendars = await client.getCalendarList();
    debugLog(debugMode, `Found ${calendars.length} calendars`);

    // Only update calendars if the list actually changed (prevents reactive loop)
    const existingCalendars = state.calendars.get();
    const calendarsChanged = existingCalendars.length !== calendars.length ||
      calendars.some(
        (cal, i) =>
          existingCalendars[i]?.id !== cal.id ||
          existingCalendars[i]?.summary !== cal.summary ||
          existingCalendars[i]?.backgroundColor !== cal.backgroundColor ||
          existingCalendars[i]?.foregroundColor !== cal.foregroundColor,
      );
    if (calendarsChanged) {
      debugLog(debugMode, "Calendar list changed, updating...");
      state.calendars.set(calendars);
    }

    // Initialize selectedCalendarIds with all calendars on first fetch
    // Only auto-select all on first fetch (when we had no calendars before AND no selection)
    if (state.selectedCalendarIds) {
      if (currentSelected.length === 0 && previousCalendarCount === 0) {
        state.selectedCalendarIds.set(calendars.map((c) => c.id));
        debugLog(
          debugMode,
          "First fetch - selected all calendars by default",
        );
      }
    }

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

    // Filter calendars based on selection
    // Only fetch from selected calendars (empty selection = fetch nothing, not everything)
    const selectedIds = state.selectedCalendarIds?.get() || [];
    const calendarsToFetch = calendars.filter((c) =>
      selectedIds.includes(c.id)
    );

    debugLog(
      debugMode,
      `Fetching events from ${calendarsToFetch.length} selected calendars`,
    );

    // Fetch events from selected calendars
    const allEvents: CalendarEvent[] = [];

    for (const calendar of calendarsToFetch) {
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
}

// Handler wrapper that calls the core fetch logic
const calendarUpdater = handler<unknown, FetchState>(
  async (_event, state) => {
    await fetchCalendarEvents(state);
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

const toggleCalendarSelection = handler<
  unknown,
  {
    calendarId: string;
    selectedCalendarIds: Writable<string[]>;
    events: Writable<CalendarEvent[]>;
    calendars: Writable<Calendar[]>;
    auth: Writable<Auth>;
    settings: Writable<Settings>;
    fetching?: Writable<boolean>;
  }
>(async (_event, state) => {
  const { calendarId, selectedCalendarIds } = state;
  const current = selectedCalendarIds.get();
  if (current.includes(calendarId)) {
    selectedCalendarIds.set(current.filter((c) => c !== calendarId));
  } else {
    selectedCalendarIds.set([...current, calendarId]);
  }
  // Re-fetch events with new selection - call directly
  await fetchCalendarEvents(state);
});

const selectAllCalendars = handler<
  unknown,
  {
    calendars: Writable<Calendar[]>;
    selectedCalendarIds: Writable<string[]>;
    events: Writable<CalendarEvent[]>;
    auth: Writable<Auth>;
    settings: Writable<Settings>;
    fetching?: Writable<boolean>;
  }
>(async (_event, state) => {
  const { calendars, selectedCalendarIds } = state;
  const allIds = calendars.get().map((c) => c.id);
  selectedCalendarIds.set(allIds);
  // Re-fetch events with new selection - call directly
  await fetchCalendarEvents(state);
});

const deselectAllCalendars = handler<
  unknown,
  {
    selectedCalendarIds: Writable<string[]>;
    events: Writable<CalendarEvent[]>;
    calendars: Writable<Calendar[]>;
    auth: Writable<Auth>;
    settings: Writable<Settings>;
    fetching?: Writable<boolean>;
  }
>(async (_event, state) => {
  state.selectedCalendarIds.set([]);
  // Re-fetch events with new selection (will fetch nothing) - call directly
  await fetchCalendarEvents(state);
});

const _nextPage = handler<unknown, { currentPage: Writable<number> }>(
  (_, { currentPage }) => {
    currentPage.set(currentPage.get() + 1);
  },
);

const _prevPage = handler<unknown, { currentPage: Writable<number> }>(
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

interface GoogleCalendarImporterInput {
  settings?: Default<Settings, {
    daysBack: 7;
    daysForward: 30;
    maxResults: 100;
    debugMode: false;
  }>;
  // Optional: Link auth directly from a Google Auth piece when wish() is unavailable
  // Use: ct piece link googleAuthPiece/auth calendarImporterPiece/overrideAuth
  overrideAuth?: Auth;
}

/** Google Calendar event importer. #calendarEvents */
interface Output {
  events: CalendarEvent[];
  calendars: Calendar[];
  /** Number of events imported */
  eventCount: number;
}

const toggleShowEvents = handler<unknown, { showEvents: Writable<boolean> }>(
  (_, { showEvents }) => {
    showEvents.set(!showEvents.get());
  },
);

const GoogleCalendarImporter = pattern<GoogleCalendarImporterInput, Output>(
  ({ settings, overrideAuth }) => {
    const events = Writable.of<Confidential<CalendarEvent[]>>([]);
    const calendars = Writable.of<Calendar[]>([]);
    const fetching = Writable.of(false);
    const currentPage = Writable.of(0);
    const showEvents = Writable.of(false); // Collapsed by default
    const selectedCalendarIds = Writable.of<string[]>([]); // Empty = all selected on first fetch
    const PAGE_SIZE = 10;

    // Pre-compute calendar selection state for efficient lookup
    // Key insight: Can index computed objects with Cell values directly
    const calendarSelectionMap = computed(() => {
      const selected = selectedCalendarIds.get() ?? [];
      const cals = calendars.get() ?? [];
      const map: Record<string, boolean> = {};
      for (const cal of cals) {
        if (cal?.id) {
          map[cal.id] = selected.includes(cal.id);
        }
      }
      return map;
    });

    // Pre-compute calendar colors map for efficient lookup
    const calendarColorsMap = computed(() => {
      const cals = calendars.get() ?? [];
      const map: Record<string, { bg: string; fg: string }> = {};
      for (const cal of cals) {
        if (cal?.id) {
          map[cal.id] = {
            bg: cal.backgroundColor || "#4285f4",
            fg: cal.foregroundColor || "#ffffff",
          };
        }
      }
      return map;
    });

    // Use createGoogleAuth utility for auth management
    const {
      auth: wishedAuth,
      fullUI,
      isReady: wishedIsReady,
      currentEmail: wishedCurrentEmail,
    } = createGoogleAuth({
      requiredScopes: ["calendar"] as ScopeKey[],
    });

    // Check if overrideAuth is provided (for manual linking when wish() is unavailable)
    const hasLinkedAuth = derive(
      { overrideAuth },
      ({ overrideAuth: la }) => !!(la?.token),
    );
    const overrideAuthEmail = derive(
      { overrideAuth },
      ({ overrideAuth: la }) => la?.user?.email || "",
    );

    // Use overrideAuth if provided, otherwise use wished auth
    // This allows manual linking via CLI when wish() is unavailable (e.g., favorites disabled)
    // Note: We wrap overrideAuth in Writable.of outside of reactive context
    const overrideAuthCell = Writable.of<Auth | null>(null);
    computed(() => {
      if (overrideAuth?.token) {
        overrideAuthCell.set(overrideAuth as any);
      }
    });

    // Choose auth source based on overrideAuth availability
    const auth = ifElse(hasLinkedAuth, overrideAuthCell, wishedAuth) as any;
    const isReady = ifElse(hasLinkedAuth, hasLinkedAuth, wishedIsReady);
    const currentEmail = ifElse(
      hasLinkedAuth,
      overrideAuthEmail,
      wishedCurrentEmail,
    );

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
    const _maxPageNum = derive(
      totalUpcoming,
      (total: number) => Math.max(0, Math.ceil(total / PAGE_SIZE) - 1),
    );

    // Paginated events for display - use computed with events Cell directly
    const _paginatedEvents = computed(() => {
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
                      selectedCalendarIds,
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

              {/* Calendar list with selection */}
              <div style={{ marginTop: "16px" }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: "8px",
                  }}
                >
                  <h4 style={{ fontSize: "16px", margin: 0 }}>
                    Your Calendars ({computed(() => calendars.get().length)})
                  </h4>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button
                      type="button"
                      style={{
                        padding: "4px 8px",
                        fontSize: "11px",
                        border: "1px solid #d1d5db",
                        borderRadius: "4px",
                        backgroundColor: "#fff",
                        cursor: "pointer",
                      }}
                      onClick={selectAllCalendars({
                        calendars,
                        selectedCalendarIds,
                        events,
                        auth,
                        settings,
                        fetching,
                      })}
                    >
                      Select All
                    </button>
                    <button
                      type="button"
                      style={{
                        padding: "4px 8px",
                        fontSize: "11px",
                        border: "1px solid #d1d5db",
                        borderRadius: "4px",
                        backgroundColor: "#fff",
                        cursor: "pointer",
                      }}
                      onClick={deselectAllCalendars({
                        selectedCalendarIds,
                        events,
                        calendars,
                        auth,
                        settings,
                        fetching,
                      })}
                    >
                      Deselect All
                    </button>
                  </div>
                </div>
                <div
                  style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}
                >
                  {calendars.map((cal) => {
                    // Use pre-computed map - direct indexing works with Cell values
                    return (
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
                          cursor: "pointer",
                          opacity: ifElse(calendarSelectionMap[cal.id], 1, 0.4),
                          textDecoration: ifElse(
                            calendarSelectionMap[cal.id],
                            "none",
                            "line-through",
                          ),
                          transition: "opacity 0.15s, text-decoration 0.15s",
                        }}
                        onClick={toggleCalendarSelection({
                          calendarId: cal.id,
                          selectedCalendarIds,
                          events,
                          calendars,
                          auth,
                          settings,
                          fetching,
                        })}
                      >
                        {ifElse(
                          calendarSelectionMap[cal.id],
                          <span>✓</span>,
                          <span />,
                        )}
                        {cal.primary ? <span>★</span> : null}
                        {cal.summary}
                      </div>
                    );
                  })}
                </div>
                <p
                  style={{
                    fontSize: "11px",
                    color: "#666",
                    marginTop: "8px",
                  }}
                >
                  Click calendars to toggle selection. Only selected calendars
                  will be fetched.
                </p>
              </div>

              {/* Collapsible events list */}
              <div style={{ marginTop: "16px" }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    cursor: "pointer",
                  }}
                  onClick={toggleShowEvents({ showEvents })}
                >
                  <span style={{ fontSize: "14px" }}>
                    {ifElse(showEvents, "▼", "▶")}
                  </span>
                  <h4 style={{ fontSize: "16px", margin: 0 }}>
                    {derive(
                      events,
                      (evts: CalendarEvent[]) =>
                        `${evts.length} events imported`,
                    )}
                  </h4>
                </div>
                {ifElse(
                  showEvents,
                  <div
                    style={{
                      marginTop: "12px",
                      maxHeight: "400px",
                      overflowY: "auto",
                      border: "1px solid #e5e7eb",
                      borderRadius: "8px",
                    }}
                  >
                    {events.map((event) => {
                      // Use pre-computed colors map - direct indexing works with Cell values
                      return (
                        <div
                          style={{
                            padding: "8px 12px",
                            borderBottom: "1px solid #f3f4f6",
                            fontSize: "13px",
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
                                padding: "2px 8px",
                                borderRadius: "12px",
                                backgroundColor:
                                  calendarColorsMap[event.calendarId]?.bg ??
                                    "#4285f4",
                                color:
                                  calendarColorsMap[event.calendarId]?.fg ??
                                    "#ffffff",
                                fontSize: "11px",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {event.calendarName}
                            </span>
                            <span style={{ fontWeight: "500" }}>
                              {event.summary}
                            </span>
                          </div>
                          <div
                            style={{
                              color: "#6b7280",
                              fontSize: "12px",
                              marginTop: "4px",
                            }}
                          >
                            {formatEventDate(
                              event.startDateTime,
                              event.endDateTime,
                              event.isAllDay,
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>,
                  <p
                    style={{
                      fontSize: "12px",
                      color: "#666",
                      marginTop: "8px",
                    }}
                  >
                    Click to expand event list.
                  </p>,
                )}
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
      bgUpdater: calendarUpdater({
        events,
        calendars,
        auth,
        settings,
        selectedCalendarIds,
      }),
      // Pattern tools for omnibot
      searchEvents: patternTool(
        ({ query, events }: { query: string; events: CalendarEvent[] }) => {
          return derive({ query, events }, ({ query, events }) => {
            if (!query || !events) return [];
            const lowerQuery = query.toLowerCase();
            return events.filter((event) =>
              event.summary?.toLowerCase().includes(lowerQuery) ||
              event.description?.toLowerCase().includes(lowerQuery) ||
              event.location?.toLowerCase().includes(lowerQuery)
            );
          });
        },
        { events },
      ),
      getEventCount: patternTool(
        ({ events }: { events: CalendarEvent[] }) => {
          return derive(events, (list) => list?.length || 0);
        },
        { events },
      ),
      getUpcomingEvents: patternTool(
        ({ count, events }: { count: number; events: CalendarEvent[] }) => {
          return derive({ count, events }, ({ count, events }) => {
            if (!events || events.length === 0) return "No events";
            const now = new Date();
            const upcoming = events
              .filter((e) => new Date(e.startDateTime || e.start) >= now)
              .slice(0, count || 5);
            return upcoming.map((event) =>
              `${
                formatEventDate(
                  event.startDateTime,
                  event.endDateTime,
                  event.isAllDay,
                )
              }: ${event.summary}${
                event.location ? ` @ ${event.location}` : ""
              }`
            ).join("\n");
          });
        },
        { events },
      ),
      getTodaysEvents: patternTool(
        ({ events }: { events: CalendarEvent[] }) => {
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
                formatEventDate(
                  event.startDateTime,
                  event.endDateTime,
                  event.isAllDay,
                )
              }: ${event.summary}`
            ).join("\n");
          });
        },
        { events },
      ),
    };
  },
);

export default GoogleCalendarImporter;
