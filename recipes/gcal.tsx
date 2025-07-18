import {
  Cell,
  cell,
  derive,
  getRecipeEnvironment,
  h,
  handler,
  ID,
  ifElse,
  JSONSchema,
  Mutable,
  NAME,
  recipe,
  Schema,
  str,
  UI,
} from "commontools";

const Classification = {
  Unclassified: "unclassified",
  Confidential: "confidential",
  Secret: "secret",
  TopSecret: "topsecret",
} as const;

const ClassificationSecret = "secret";

// This is used by the various Google tokens created with tokenToAuthData
export const AuthSchema = {
  type: "object",
  properties: {
    token: {
      type: "string",
      default: "",
      ifc: { classification: [ClassificationSecret] },
    },
    tokenType: { type: "string", default: "" },
    scope: { type: "array", items: { type: "string" }, default: [] },
    expiresIn: { type: "number", default: 0 },
    expiresAt: { type: "number", default: 0 },
    refreshToken: {
      type: "string",
      default: "",
      ifc: { classification: [ClassificationSecret] },
    },
    user: {
      type: "object",
      properties: {
        email: { type: "string", default: "" },
        name: { type: "string", default: "" },
        picture: { type: "string", default: "" },
      },
    },
  },
} as const satisfies JSONSchema;

const env = getRecipeEnvironment();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const CalendarEventSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    summary: { type: "string" },
    description: { type: "string" },
    start: { type: "string" },
    end: { type: "string" },
    location: { type: "string" },
    eventType: { type: "string" },
    hangoutLink: { type: "string" },
    attendees: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          email: { type: "string" },
          displayName: { type: "string" },
          organizer: { type: "boolean" },
          self: { type: "boolean" },
          resource: { type: "boolean" },
          optional: { type: "boolean" },
          responseStatus: { type: "string" },
          comment: { type: "string" },
          additionalGuests: { type: "integer" },
        },
        required: ["email"], // or add others as needed
      },
    },
  },
  required: ["id", "start", "end"],
  ifc: { classification: [Classification.Confidential] },
} as const satisfies JSONSchema;
type CalendarEvent = Mutable<Schema<typeof CalendarEventSchema>>;

type Auth = Schema<typeof AuthSchema>;

const GcalImporterInputs = {
  type: "object",
  properties: {
    settings: {
      type: "object",
      properties: {
        calendarId: {
          type: "string",
          description: "Calendar ID to fetch events from",
          default: "primary",
        },
        limit: {
          type: "number",
          description: "number of events to import",
          default: 250,
        },
        syncToken: {
          type: "string",
          description: "Google Calendar sync token for incremental sync",
          default: "",
        },
      },
      required: ["calendarId", "limit", "syncToken"],
    },
    auth: AuthSchema,
  },
  required: ["settings", "auth"],
  description: "GCal Importer",
} as const satisfies JSONSchema;

const ResultSchema = {
  type: "object",
  properties: {
    events: {
      type: "array",
      items: {
        type: "object",
        properties: CalendarEventSchema.properties,
      },
    },
    googleUpdater: { asStream: true, type: "object", properties: {} },
  },
} as const satisfies JSONSchema;

const updateLimit = handler({
  type: "object",
  properties: {
    detail: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
  },
}, {
  type: "object",
  properties: { limit: { type: "number", asCell: true } },
  required: ["limit"],
}, ({ detail }, state) => {
  state.limit.set(parseInt(detail?.value ?? "250") || 0);
});

const updateCalendarId = handler({
  type: "object",
  properties: {
    detail: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
  },
}, {
  type: "object",
  properties: { calendarId: { type: "string", asCell: true } },
  required: ["calendarId"],
}, ({ detail }, state) => {
  state.calendarId.set(detail?.value ?? "primary");
});

const refreshAuthToken = async (auth: Cell<Auth>) => {
  const body = {
    refreshToken: auth.get().refreshToken,
  };

  console.log("refreshAuthToken", body);

  const res = await fetch(
    new URL("/api/integrations/google-oauth/refresh", env.apiUrl),
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    throw new Error("Could not acquir a refresh token.");
  }
  const json = await res.json();
  const authData = json.tokenInfo as Auth;
  return authData;
};

const calendarUpdater = handler(
  {},
  {
    type: "object",
    properties: {
      events: {
        type: "array",
        items: CalendarEventSchema,
        default: [],
        asCell: true,
      },
      auth: { ...AuthSchema, asCell: true },
      settings: { ...GcalImporterInputs.properties.settings, asCell: true },
    },
    required: ["events", "auth", "settings"],
  } as const satisfies JSONSchema,
  async (_event, state) => {
    console.log("calendarUpdater!");

    if (!state.auth.get().token) {
      console.warn("no token found in auth cell");
      return;
    }

    const settings = state.settings.get();
    const result = await fetchCalendar(
      state.auth,
      settings.limit,
      settings.calendarId,
      settings.syncToken,
      state,
    );

    if (!result) return;

    // Handle deleted events
    if (result.deletedEventIds && result.deletedEventIds.length > 0) {
      console.log(`Removing ${result.deletedEventIds.length} deleted events`);
      const deleteSet = new Set(result.deletedEventIds);
      const currentEvents = state.events.get();
      const remainingEvents = currentEvents.filter((event) =>
        !deleteSet.has(event.id)
      );
      state.events.set(remainingEvents);
    }

    // Add new events
    if (result.newEvents && result.newEvents.length > 0) {
      console.log(`Adding ${result.newEvents.length} new events`);
      state.events.push(...result.newEvents);
    }

    // Update syncToken
    if (result.newSyncToken) {
      const currentSettings = state.settings.get();
      console.log("=== UPDATING SYNC TOKEN ===");
      console.log("Previous syncToken:", currentSettings.syncToken || "none");
      console.log("New syncToken:", result.newSyncToken);
      state.settings.set({
        ...currentSettings,
        syncToken: result.newSyncToken,
      });
      console.log("SyncToken updated successfully");
      console.log("==========================");
    }
  },
);

async function googleRequest(
  auth: Cell<Auth>,
  url: URL,
  _options?: RequestInit,
  _retries?: number,
): Promise<Response> {
  const token = auth.get().token;
  if (!token) {
    throw new Error("No authorization token.");
  }

  const retries = _retries ?? 3;
  const options = _options ?? {};
  options.headers = new Headers(options.headers);
  options.headers.set("Authorization", `Bearer ${token}`);

  if (options.body && typeof options.body === "string") {
    // Rewrite the authorization in the body here in case reauth was necessary
    options.body = options.body.replace(
      /Authorization: Bearer [^\n]*/g,
      `Authorization: Bearer ${token}`,
    );
  }

  const res = await fetch(url, options);
  let { ok, status, statusText } = res;

  // Batch requests expect a text response on success, but upon error, we get a 200 status code
  // with error details in the json response.
  if (options.method === "POST") {
    // `body` can only be consumed once. Clone the body before consuming as json.
    try {
      const json = await res.clone().json();
      if (json?.error?.code) {
        ok = false;
        status = json.error.code;
        statusText = json.error?.message;
      }
    } catch (e) {
      // If parsing as json failed, then this is probably a real 200 scenario
    }
  }

  // Allow all 2xx status
  if (ok) {
    console.log(`${url}: ${status} ${statusText}`);
    return res;
  }

  console.warn(
    `${url}: ${status} ${statusText}`,
    `Remaining retries: ${retries}`,
  );
  if (retries === 0) {
    throw new Error("Too many failed attempts.");
  }

  await sleep(1000);

  if (status === 401) {
    const refreshed = await refreshAuthToken(auth);
    auth.update(refreshed);
  } else if (status === 429) {
    console.log("429 rate limiting, sleeping");
    await sleep(5000);
  }
  return googleRequest(auth, url, _options, retries - 1);
}

export async function fetchCalendar(
  auth: Cell<Auth>,
  maxResults: number = 250,
  calendarId: string = "primary",
  currentSyncToken: string = "",
  state: {
    events: Cell<CalendarEvent[]>;
  },
): Promise<
  | {
    newSyncToken?: string;
    newEvents?: CalendarEvent[];
    deletedEventIds?: string[];
  }
  | void
> {
  if (!auth.get()) {
    console.warn("no token");
    return;
  }

  // Get existing event IDs for lookup
  const existingEventIds = new Set(
    state.events.get().map((event) => event.id),
  );

  let newSyncToken: string | undefined;
  const eventsToAdd: CalendarEvent[] = [];
  const eventsToDelete: string[] = [];

  // If we have a sync token, use incremental sync
  if (currentSyncToken) {
    console.log("=== INCREMENTAL SYNC MODE ===");
    console.log("Using syncToken:", currentSyncToken);

    try {
      const syncUrl = new URL(
        `https://www.googleapis.com/calendar/v3/calendars/${
          encodeURIComponent(calendarId.trim())
        }/events?syncToken=${
          encodeURIComponent(currentSyncToken)
        }&singleEvents=true`,
      );

      const syncResponse = await googleRequest(auth, syncUrl);
      const syncData = await syncResponse.json();

      if (syncData.items && Array.isArray(syncData.items)) {
        for (const event of syncData.items) {
          if (event.status === "cancelled") {
            console.log(`Event deleted: ${event.id}`);
            eventsToDelete.push(event.id);
          } else if (!existingEventIds.has(event.id)) {
            console.log(`New/Updated event: ${event.id} - ${event.summary}`);
            eventsToAdd.push({
              id: event.id,
              summary: event.summary || "",
              description: event.description || "",
              start: event.start
                ? event.start.dateTime || event.start.date || ""
                : "",
              end: event.end ? event.end.dateTime || event.end.date || "" : "",
              location: event.location || "",
              eventType: event.eventType || "",
              hangoutLink: event.hangoutLink || "",
              attendees: event.attendees || [],
            });
          }
        }
      }

      newSyncToken = syncData.nextSyncToken;
      console.log("Incremental sync complete. New syncToken:", newSyncToken);
    } catch (error: any) {
      if (error.message && error.message.includes("410")) {
        console.log("Sync token expired, falling back to full sync");
        currentSyncToken = ""; // Force full sync below
      } else {
        throw error;
      }
    }
  }

  // If no sync token or it expired, do a full sync
  if (!currentSyncToken) {
    console.log("=== FULL SYNC MODE ===");

    // First, fetch events with timeMin to get the events we want to display
    const now = new Date().toISOString();
    const eventsUrl = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${
        encodeURIComponent(calendarId.trim())
      }/events?maxResults=${maxResults}&timeMin=${
        encodeURIComponent(now)
      }&singleEvents=true&orderBy=startTime`,
    );

    const eventsResponse = await googleRequest(auth, eventsUrl);
    const eventsData = await eventsResponse.json();

    if (eventsData.items && Array.isArray(eventsData.items)) {
      for (const event of eventsData.items) {
        if (!existingEventIds.has(event.id)) {
          eventsToAdd.push({
            id: event.id,
            summary: event.summary || "",
            description: event.description || "",
            start: event.start
              ? event.start.dateTime || event.start.date || ""
              : "",
            end: event.end ? event.end.dateTime || event.end.date || "" : "",
            location: event.location || "",
            eventType: event.eventType || "",
            hangoutLink: event.hangoutLink || "",
            attendees: event.attendees || [],
          });
        }
      }
    }

    console.log(`Fetched ${eventsToAdd.length} new future events`);

    // Now we need to get the sync token by iterating through ALL pages
    console.log("Getting sync token by iterating through all pages...");
    let pageToken: string | undefined;
    let pageCount = 0;
    const maxPages = 1000; // Safety limit

    const tokenUrl = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${
        encodeURIComponent(calendarId.trim())
      }/events?maxResults=250&singleEvents=true&fields=nextPageToken,nextSyncToken`,
    );

    do {
      pageCount++;
      if (pageToken) {
        tokenUrl.searchParams.set("pageToken", pageToken);
      }

      console.log(`Fetching page ${pageCount} for sync token...`);
      const tokenResponse = await googleRequest(auth, tokenUrl);
      const tokenData = await tokenResponse.json();

      pageToken = tokenData.nextPageToken;
      if (!pageToken) {
        newSyncToken = tokenData.nextSyncToken;
        console.log(`Got sync token after ${pageCount} pages:`, newSyncToken);
      }

      if (pageCount >= maxPages) {
        console.warn("Reached max page limit, calendar might be too large");
        break;
      }
    } while (pageToken);
  }

  // Add IDs to new events
  eventsToAdd.forEach((event: any) => {
    event[ID] = event.id;
  });

  console.log("=== SYNC SUMMARY ===");
  console.log(`Events to add: ${eventsToAdd.length}`);
  console.log(`Events to delete: ${eventsToDelete.length}`);
  console.log(`New sync token: ${newSyncToken}`);
  console.log("===================");

  return {
    newSyncToken,
    newEvents: eventsToAdd.length > 0 ? eventsToAdd : undefined,
    deletedEventIds: eventsToDelete.length > 0 ? eventsToDelete : undefined,
  };
}

const CalendarSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    summary: { type: "string" },
  },
} as const satisfies JSONSchema;
type Calendar = Schema<typeof CalendarSchema>;

const getCalendars = handler(
  {},
  {
    type: "object",
    properties: {
      auth: { ...AuthSchema, asCell: true },
      calendars: {
        type: "array",
        items: CalendarSchema,
        default: [],
        asCell: true,
      },
    },
    required: ["auth", "calendars"],
  },
  (_event, state) => {
    const auth = state.auth.get();
    if (!auth.token) {
      console.warn("No auth token available");
      return;
    }

    googleRequest(
      state.auth,
      new URL(`https://www.googleapis.com/calendar/v3/users/me/calendarList`),
    )
      .then((res) => res.json())
      .then((data) => {
        if (data.items && Array.isArray(data.items)) {
          const calendarList = data.items.map((item: any) => ({
            id: item.id,
            summary: item.summary,
          }));
          state.calendars.set(calendarList);
        }
      })
      .catch((error) => {
        console.error("Error fetching calendars:", error);
      });
  },
);
const clearEvents = handler(
  {},
  {
    type: "object",
    properties: {
      events: {
        type: "array",
        items: CalendarEventSchema,
        default: [],
        asCell: true,
      },
    },
    required: ["events"],
  },
  (_event, state) => {
    state.events.set([]);
  },
);

export default recipe(
  GcalImporterInputs,
  ResultSchema,
  ({ settings, auth }) => {
    const events = cell<CalendarEvent[]>([]);
    const calendars = cell<Calendar[]>([]);

    derive(events, (events) => {
      console.log("events", events.length);
    });

    return {
      [NAME]: str`GCal Importer ${
        derive(auth, (auth) => auth?.user?.email || "unauthorized")
      }`,
      [UI]: (
        <div style="display: flex; gap: 10px; flex-direction: column; padding: 25px;">
          <h2 style="font-size: 20px; font-weight: bold;">
            {auth?.user?.email}
          </h2>
          <h2 style="font-size: 20px; font-weight: bold;">
            Imported event count: {derive(events, (events) => events.length)}
          </h2>

          <h2>
            syncToken:{" "}
            {ifElse(settings.syncToken, settings.syncToken, "Not yet obtained")}
          </h2>

          <common-hstack gap="sm">
            <common-vstack gap="sm">
              <div>
                <label>Import Limit</label>
                <common-input
                  customStyle="border: 1px solid black; padding: 15px 10px; border-radius: 25px; min-width: 650px;"
                  value={settings.limit}
                  placeholder="count of events to import"
                  oncommon-input={updateLimit({ limit: settings.limit })}
                />
              </div>

              <div>
                <label>
                  Calendars
                  <common-button
                    onClick={getCalendars({ auth, calendars })}
                  >
                    Fetch Calendar List
                  </common-button>
                </label>
                <table>
                  <thead>
                    <tr>
                      <th style="padding: 10px;">ID</th>
                      <th style="padding: 10px;">Summary</th>
                    </tr>
                  </thead>
                  <tbody>
                    {calendars.map((c) => (
                      <tr>
                        <td style="border: 1px solid black; padding: 10px;">
                          {c.id}
                        </td>
                        <td style="border: 1px solid black; padding: 10px;">
                          {c.summary}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div>
                <label>Calendar ID</label>
                <common-input
                  customStyle="border: 1px solid black; padding: 15px 10px; border-radius: 25px; min-width: 650px;"
                  value={settings.calendarId}
                  placeholder="Calendar ID (e.g. primary)"
                  oncommon-input={updateCalendarId({
                    calendarId: settings.calendarId,
                  })}
                />
              </div>
              <common-button
                onClick={calendarUpdater({
                  events,
                  auth,
                  settings,
                })}
              >
                Fetch Events
              </common-button>
              <common-button
                onClick={clearEvents({ events })}
              >
                Clear Events
              </common-button>
            </common-vstack>
          </common-hstack>
          <common-google-oauth
            $auth={auth}
            scopes={[
              "email",
              "profile",
              "https://www.googleapis.com/auth/calendar.readonly",
            ]}
          />
          <div>
            <table>
              <thead>
                <tr>
                  <th style="padding: 10px;">START</th>
                  <th style="padding: 10px;">END</th>
                  <th style="padding: 10px;">SUMMARY</th>
                  <th style="padding: 10px;">LOCATION</th>
                  <th style="padding: 10px;">TYPE</th>
                  <th style="padding: 10px;">HANGOUTLINK</th>
                  <th style="padding: 10px;">ATTENDEES</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr>
                    <td style="border: 1px solid black; padding: 10px;">
                      &nbsp;{event.start}&nbsp;
                    </td>
                    <td style="border: 1px solid black; padding: 10px;">
                      &nbsp;{event.end}&nbsp;
                    </td>
                    <td style="border: 1px solid black; padding: 10px;">
                      &nbsp;{event.summary}&nbsp;
                    </td>
                    <td style="border: 1px solid black; padding: 10px;">
                      &nbsp;{event.location}&nbsp;
                    </td>
                    <td style="border: 1px solid black; padding: 10px;">
                      &nbsp;{event.eventType}&nbsp;
                    </td>
                    <td style="border: 1px solid black; padding: 10px;">
                      &nbsp;{event.hangoutLink}&nbsp;
                    </td>
                    <td style="border: 1px solid black; padding: 10px;">
                      &nbsp;{derive(
                        event,
                        (event) =>
                          event?.attendees?.map((a) => a.email).join(", "),
                      )}&nbsp;
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ),
      events,
      auth,
      settings,
      bgUpdater: calendarUpdater({ events, auth, settings }),
    };
  },
);
