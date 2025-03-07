import { h } from "@commontools/html";
import { cell, derive, handler, NAME, recipe, UI } from "@commontools/builder";
import { z } from "zod";

// Define a CalendarEvent type
const CalendarEvent = z.object({
    id: z.string(),
    summary: z.string().optional(),
    description: z.string().optional(),
    start: z.string(),
    end: z.string(),
    location: z.string().optional(),
    eventType: z.string().optional(),
});
type CalendarEvent = z.infer<typeof CalendarEvent>;

const Auth = z.object({
    token: z.string(),
    tokenType: z.string(),
    scope: z.array(z.string()),
    expiresIn: z.number(),
    expiresAt: z.number(),
    refreshToken: z.string(),
    user: z.object({
        email: z.string(),
        name: z.string(),
        picture: z.string(),
    }),
});
type Auth = z.infer<typeof Auth>;

// Recipe settings now include calendarId and limit
const Recipe = z
    .object({
        settings: z.object({
            calendarId: z
                .string()
                .default("primary")
                .describe("Calendar ID to fetch events from"),
            limit: z
                .number()
                .default(250)
                .describe("number of events to import"),
        }),
    })
    .describe("fake calendar");

// Updated result schema for calendar events
const ResultSchema = {
    type: "object",
    properties: {
        events: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    summary: { type: "string" },
                    description: { type: "string" },
                    start: { type: "string" },
                    end: { type: "string" },
                    location: { type: "string" },
                    eventType: { type: "string" },
                },
            },
        },
        googleUpdater: { asCell: true, type: "action" },
        auth: {
            type: "object",
            properties: {
                token: { type: "string" },
                tokenType: { type: "string" },
                scope: { type: "array", items: { type: "string" } },
                expiresIn: { type: "number" },
                expiresAt: { type: "number" },
                refreshToken: { type: "string" },
            },
        },
    },
};

// Handler to update the limit for events to import
const updateLimit = handler<{ detail: { value: string } }, { limit: number }>(
    ({ detail }, state) => {
        state.limit = parseInt(detail?.value ?? "10") || 0;
    },
);

// Handler to update the calendar ID
const updateCalendarId = handler<
    { detail: { value: string } },
    { calendarId: string }
>(({ detail }, state) => {
    state.calendarId = detail?.value ?? "primary";
});

// The updater now fetches calendar events using Fetch
const calendarUpdater = handler<
    NonNullable<unknown>,
    { events: CalendarEvent[]; auth: Auth; settings: { calendarId: string; limit: number } }
>((_event, state) => {
    console.log("calendarUpdater!");

    if (!state.auth.token) {
        console.log("no token");
        return;
    }
    if (state.auth.expiresAt && state.auth.expiresAt < Date.now()) {
        console.log("token expired at ", state.auth.expiresAt);
        return;
    }

    // Get existing event IDs for lookup
    const existingEventIds = new Set((state.events || []).map((event) => event.id));
    console.log("existing event ids", existingEventIds);

    fetchCalendar(
        state.auth.token,
        state.settings.limit,
        state.settings.calendarId,
        existingEventIds,
    ).then((result) => {
        // Filter out any duplicates by ID
        const newEvents = result.items.filter((event) => !existingEventIds.has(event.id));
        if (newEvents.length > 0) {
            console.log(`Adding ${newEvents.length} new events`);
            state.events.push(...newEvents);
        } else {
            console.log("No new events found");
        }
    });
});

// Helper function to fetch calendar events using the Google Calendar API
export async function fetchCalendar(
    accessToken: string,
    maxResults: number = 250,
    calendarId: string = "primary",
    existingEventIds: Set<string>,
) {
    // Get current date in ISO format for timeMin parameter
    const now = new Date().toISOString();

    const listResponse = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
            calendarId,
        )}/events?maxResults=${maxResults}&timeMin=${encodeURIComponent(now)}&singleEvents=true&orderBy=startTime`,
        {
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
        },
    );

    const listData = await listResponse.json();

    if (!listData.items || !Array.isArray(listData.items)) {
        return { items: [] };
    }

    const events = listData.items
        .filter((event: { id: string }) => !existingEventIds.has(event.id))
        .map((event: any) => ({
            id: event.id,
            summary: event.summary || "",
            description: event.description || "",
            start: event.start
                ? event.start.dateTime || event.start.date || ""
                : "",
            end: event.end ? event.end.dateTime || event.end.date || "" : "",
            location: event.location || "",
            eventType: event.eventType || "",
        }));

    return { items: events };
}

// Export the recipe, wiring up state cells, UI and the updater
export default recipe(Recipe, ResultSchema, ({ settings }) => {
    const auth = cell<Auth>({
        token: "",
        tokenType: "",
        scope: [],
        expiresIn: 0,
        expiresAt: 0,
        refreshToken: "",
        user: {
            email: "",
            name: "",
            picture: "",
        },
    });

    const events = cell<CalendarEvent[]>([]);

    derive(events, (events) => {
        console.log("events", events.length);
    });

    return {
        [NAME]: "calendar importer",
        [UI]: (
            <div>
                <h1>Calendar Importer</h1>
                <common-hstack>
                    <label>Import Limit</label>
                    <common-input
                        value={settings.limit}
                        placeholder="count of events to import"
                        oncommon-input={updateLimit({ limit: settings.limit })}
                    />
                </common-hstack>
                <common-hstack>
                    <label>Calendar ID</label>
                    <common-input
                        value={settings.calendarId}
                        placeholder="Calendar ID (e.g. primary)"
                        oncommon-input={updateCalendarId({ calendarId: settings.calendarId })}
                    />
                </common-hstack>
                <common-google-oauth $authCell={auth} auth={auth} />
                <div>
                    <table>
                        <thead>
                            <tr>
                                <th>Start</th>
                                <th>End</th>
                                <th>Summary</th>
                                <th>Location</th>
                                <th>Type</th>
                            </tr>
                        </thead>
                        <tbody>
                            {events.map((event) => (
                                <tr>
                                    <td>&nbsp;{event.start}&nbsp;</td>
                                    <td>&nbsp;{event.end}&nbsp;</td>
                                    <td>&nbsp;{event.summary}&nbsp;</td>
                                    <td>&nbsp;{event.location}&nbsp;</td>
                                    <td>&nbsp;{event.eventType}&nbsp;</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        ),
        events,
        auth,
        googleUpdater: calendarUpdater({ events, auth, settings }),
    };
});