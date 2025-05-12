import { h } from "@commontools/html";
import {
  cell,
  derive,
  handler,
  ID,
  JSONSchema,
  NAME,
  recipe,
  Schema,
  str,
  UI,
} from "@commontools/builder";
import { Cell } from "@commontools/runner";

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
} as const satisfies JSONSchema;
type CalendarEvent = Schema<typeof CalendarEventSchema>;

const AuthSchema = {
  type: "object",
  properties: {
    token: { type: "string", default: "" },
    tokenType: { type: "string", default: "" },
    scope: { type: "array", items: { type: "string" }, default: [] },
    expiresIn: { type: "number", default: 0 },
    expiresAt: { type: "number", default: 0 },
    refreshToken: { type: "string", default: "" },
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
      },
      required: ["calendarId", "limit"],
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

  const refresh_response = await fetch(
    "/api/integrations/google-oauth/refresh",
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  ).then((res) => res.json());

  return refresh_response.tokenInfo as Auth;
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
      settings: GcalImporterInputs.properties.settings,
    },
    required: ["events", "auth", "settings"],
  } as const satisfies JSONSchema,
  (_event, state) => {
    console.log("calendarUpdater!");

    if (!state.auth.get().token) {
      console.warn("no token found in auth cell");
      return;
    }

    return fetchCalendar(
      state.auth,
      state.settings.limit,
      state.settings.calendarId,
      state,
    );
  },
);

export async function fetchCalendar(
  auth: Cell<Auth>,
  maxResults: number = 250,
  calendarId: string = "primary",
  state: {
    events: Cell<CalendarEvent[]>;
  },
) {
  let cur = auth.get();

  if (cur.expiresAt && Date.now() > cur.expiresAt) {
    const resp = await refreshAuthToken(auth);
    auth.update(resp);
    console.log("refresh_data", resp);
  }

  cur = auth.get();

  if (!cur.token) {
    console.warn("no token");
    return;
  }

  // Get existing event IDs for lookup
  const existingEventIds = new Set(
    state.events.get().map((event) => event.id),
  );
  console.log("existing event ids", existingEventIds);

  // Get current date in ISO format for timeMin parameter
  const now = new Date().toISOString();

  const listResponse = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${
      encodeURIComponent(
        calendarId.trim(),
      )
    }/events?maxResults=${maxResults}&timeMin=${
      encodeURIComponent(now)
    }&singleEvents=true&orderBy=startTime`,
    {
      headers: {
        Authorization: `Bearer ${cur.token}`,
      },
    },
  );

  const listData = await listResponse.json();

  if (!listData.items || !Array.isArray(listData.items)) {
    console.log("No events found in response");
    return { items: [] };
  }

  // Filter out events we already have
  const newEvents = listData.items
    .filter((event: { id: string }) => !existingEventIds.has(event.id))
    .map((event: any) => ({
      id: event.id,
      summary: event.summary || "",
      description: event.description || "",
      start: event.start ? event.start.dateTime || event.start.date || "" : "",
      end: event.end ? event.end.dateTime || event.end.date || "" : "",
      location: event.location || "",
      eventType: event.eventType || "",
      hangoutLink: event.hangoutLink || "",
      attendees: event.attendees || [],
    }));

  if (newEvents.length > 0) {
    console.log(`Adding ${newEvents.length} new events`);

    // Use event ID to generate our ID
    newEvents.forEach((event: any) => {
      event[ID] = event.id;
    });

    state.events.push(...newEvents);
  } else {
    console.log("No new events found");
  }
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

    fetch(
      `https://www.googleapis.com/calendar/v3/users/me/calendarList`,
      {
        headers: { Authorization: `Bearer ${auth.token}` },
      },
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
          <common-google-oauth $auth={auth} />
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
                        (event) => event?.attendees?.map((a) => a.email).join(", "),
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
      bgUpdater: calendarUpdater({ events, auth, settings }),
    };
  },
);
