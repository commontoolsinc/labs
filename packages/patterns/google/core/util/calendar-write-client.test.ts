import { assertEquals, assertRejects } from "@std/assert";
import type { Writable } from "commonfabric";
import { setTestPatternEnvironment } from "../../../tools/test-support/commonfabric.ts";
import {
  type Auth,
  CalendarWriteClient,
  createCalendarWriteClient,
} from "./calendar-write-client.ts";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];
type FetchResponder = (
  input: FetchInput,
  init: FetchInit,
) => Response | Promise<Response>;

interface CapturedRequest {
  url: string;
  init: FetchInit;
}

interface TestAuthCell {
  cell: Writable<Auth>;
  getCurrent(): Auth;
}

function authCell(initial: Auth): TestAuthCell {
  let current = initial;
  return {
    cell: {
      get: () => current,
      update: (next: Auth) => {
        current = next;
      },
    } as unknown as Writable<Auth>,
    getCurrent: () => current,
  };
}

function testAuth(overrides: Partial<Auth> = {}): Auth {
  return {
    token: "access-token",
    tokenType: "Bearer",
    scope: ["https://www.googleapis.com/auth/calendar.events"],
    expiresIn: 3600,
    expiresAt: 1,
    refreshToken: "refresh-token",
    user: {
      email: "ada@example.com",
      name: "Ada Lovelace",
      picture: "",
    },
    ...overrides,
  };
}

function response(body: unknown, status = 200, statusText = "OK"): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}

function emptyResponse(status = 204, statusText = "No Content"): Response {
  return new Response(null, { status, statusText });
}

function requestBody(request: CapturedRequest): unknown {
  return JSON.parse(String(request.init?.body));
}

function mockFetch(responders: FetchResponder[]): {
  requests: CapturedRequest[];
  restore(): void;
} {
  const originalFetch = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  let index = 0;

  globalThis.fetch = ((input, init) => {
    const responder = responders[index++];
    if (!responder) {
      throw new Error(`Unexpected fetch call ${index}`);
    }

    requests.push({
      url: input instanceof Request ? input.url : String(input),
      init,
    });
    return Promise.resolve(responder(input, init));
  }) as typeof fetch;

  return {
    requests,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

Deno.test("CalendarWriteClient constructor creates calendar events", async () => {
  const fetchMock = mockFetch([
    () =>
      response({
        id: "event-1",
        status: "confirmed",
        htmlLink: "https://calendar.example/event-1",
      }),
  ]);

  try {
    const { cell } = authCell(testAuth());
    const client = new CalendarWriteClient(cell, { debugMode: false });
    const result = await client.createEvent({
      calendarId: "primary",
      summary: "Team Meeting",
      start: "2026-01-15T10:00:00.000Z",
      end: "2026-01-15T11:00:00.000Z",
      description: "Discuss roadmap",
      location: "Room 1",
      attendees: ["grace@example.com"],
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=2"],
      sendUpdates: "all",
    });

    assertEquals(result.id, "event-1");
    assertEquals(fetchMock.requests.length, 1);
    assertEquals(
      fetchMock.requests[0].url,
      "https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all",
    );
    assertEquals(fetchMock.requests[0].init?.method, "POST");
    assertEquals(fetchMock.requests[0].init?.headers, {
      Authorization: "Bearer access-token",
      "Content-Type": "application/json",
    });
    assertEquals(requestBody(fetchMock.requests[0]), {
      summary: "Team Meeting",
      start: {
        dateTime: "2026-01-15T10:00:00.000Z",
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      end: {
        dateTime: "2026-01-15T11:00:00.000Z",
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      description: "Discuss roadmap",
      location: "Room 1",
      attendees: [{ email: "grace@example.com" }],
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=2"],
    });
  } finally {
    fetchMock.restore();
  }
});

Deno.test("createCalendarWriteClient updates, deletes, and RSVPs", async () => {
  const fetchMock = mockFetch([
    () =>
      response({
        id: "event-2",
        status: "confirmed",
        htmlLink: "https://calendar.example/event-2",
      }),
    () => emptyResponse(),
    () =>
      response({
        id: "event-3",
        status: "confirmed",
        htmlLink: "https://calendar.example/event-3",
        attendees: [
          { email: "ada@example.com", responseStatus: "needsAction" },
          { email: "grace@example.com", responseStatus: "accepted" },
        ],
      }),
    () =>
      response({
        id: "event-3",
        status: "confirmed",
        htmlLink: "https://calendar.example/event-3",
      }),
  ]);

  try {
    const { cell } = authCell(testAuth());
    const client = createCalendarWriteClient(cell);

    const updated = await client.updateEvent(
      "primary",
      "event-2",
      {
        summary: "Updated Meeting",
        start: "2026-02-01T09:00:00.000Z",
        end: "2026-02-01T10:00:00.000Z",
        attendees: ["ada@example.com"],
      },
      "none",
    );
    await client.deleteEvent("primary", "event-2", "externalOnly");
    const rsvp = await client.rsvpToEvent("primary", "event-3", "tentative");

    assertEquals(updated.id, "event-2");
    assertEquals(rsvp.id, "event-3");
    assertEquals(fetchMock.requests.map((request) => request.init?.method), [
      "PATCH",
      "DELETE",
      undefined,
      "PATCH",
    ]);
    assertEquals(
      fetchMock.requests[0].url,
      "https://www.googleapis.com/calendar/v3/calendars/primary/events/event-2?sendUpdates=none",
    );
    assertEquals(requestBody(fetchMock.requests[0]), {
      summary: "Updated Meeting",
      start: {
        dateTime: "2026-02-01T09:00:00.000Z",
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      end: {
        dateTime: "2026-02-01T10:00:00.000Z",
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      attendees: [{ email: "ada@example.com" }],
    });
    assertEquals(
      fetchMock.requests[1].url,
      "https://www.googleapis.com/calendar/v3/calendars/primary/events/event-2?sendUpdates=externalOnly",
    );
    assertEquals(requestBody(fetchMock.requests[3]), {
      attendees: [
        { email: "ada@example.com", responseStatus: "tentative" },
        { email: "grace@example.com", responseStatus: "accepted" },
      ],
    });
  } finally {
    fetchMock.restore();
  }
});

Deno.test("CalendarWriteClient refreshes and retries expired auth", async () => {
  setTestPatternEnvironment({
    apiUrl: new URL("https://toolshed.example/app/"),
  });

  const fetchMock = mockFetch([
    () => response({ error: { message: "Expired" } }, 401, "Unauthorized"),
    () =>
      response({
        tokenInfo: {
          token: "new-token",
          tokenType: "Bearer",
          scope: ["https://www.googleapis.com/auth/calendar.events"],
          expiresIn: 3600,
          expiresAt: 2,
          refreshToken: "new-refresh-token",
        },
      }),
    () =>
      response({
        id: "event-4",
        status: "confirmed",
        htmlLink: "https://calendar.example/event-4",
      }),
  ]);

  try {
    const auth = authCell(testAuth());
    const client = new CalendarWriteClient(auth.cell);
    const created = await client.createEvent({
      calendarId: "primary",
      summary: "Retried Meeting",
      start: "2026-03-01T09:00:00.000Z",
      end: "2026-03-01T10:00:00.000Z",
    });

    assertEquals(created.id, "event-4");
    assertEquals(
      fetchMock.requests[1].url,
      "https://toolshed.example/api/integrations/google-oauth/refresh",
    );
    assertEquals(requestBody(fetchMock.requests[1]), {
      refreshToken: "refresh-token",
    });
    assertEquals(fetchMock.requests[2].init?.headers, {
      Authorization: "Bearer new-token",
      "Content-Type": "application/json",
    });
    assertEquals(auth.getCurrent().user.email, "ada@example.com");
    assertEquals(auth.getCurrent().token, "new-token");
  } finally {
    fetchMock.restore();
    setTestPatternEnvironment({
      apiUrl: new URL("https://commonfabric.test/"),
    });
  }
});

Deno.test("CalendarWriteClient reports batch progress and failures", async () => {
  const fetchMock = mockFetch([
    () =>
      response({
        id: "event-5",
        status: "confirmed",
        htmlLink: "https://calendar.example/event-5",
      }),
    () => response({ error: { message: "quota exceeded" } }, 429, "Limited"),
    () =>
      response({
        id: "event-6",
        status: "confirmed",
        htmlLink: "https://calendar.example/event-6",
      }),
  ]);
  const progress: Array<{
    total: number;
    processed: number;
    succeeded: number;
    failed: number;
    percentComplete: number;
    currentEvent?: string;
  }> = [];

  try {
    const { cell } = authCell(testAuth());
    const client = new CalendarWriteClient(cell);
    const result = await client.createBatchEvents({
      calendarId: "primary",
      batchSize: 2,
      batchDelayMs: 0,
      events: [
        {
          clientId: "a",
          summary: "First",
          start: "2026-04-01T09:00:00.000Z",
          end: "2026-04-01T10:00:00.000Z",
        },
        {
          clientId: "b",
          summary: "Second",
          start: "2026-04-02T09:00:00.000Z",
          end: "2026-04-02T10:00:00.000Z",
        },
        {
          clientId: "c",
          summary: "Third",
          start: "2026-04-03T09:00:00.000Z",
          end: "2026-04-03T10:00:00.000Z",
        },
      ],
      onProgress: (event) => progress.push(event),
    });

    assertEquals(result.total, 3);
    assertEquals(result.succeeded, 2);
    assertEquals(result.failed, 1);
    assertEquals(result.results[0].success, true);
    assertEquals(result.results[1].success, false);
    assertEquals(result.results[2].success, true);
    assertEquals(progress.at(0), {
      total: 3,
      processed: 0,
      succeeded: 0,
      failed: 0,
      percentComplete: 0,
    });
    assertEquals(progress.at(-1), {
      total: 3,
      processed: 3,
      succeeded: 2,
      failed: 1,
      percentComplete: 100,
    });
  } finally {
    fetchMock.restore();
  }
});

Deno.test("CalendarWriteClient surfaces auth and RSVP errors", async () => {
  await assertRejects(
    () =>
      new CalendarWriteClient(authCell(testAuth({ token: "" })).cell)
        .deleteEvent("primary", "event-6"),
    Error,
    "No authorization token",
  );

  const fetchMock = mockFetch([
    () =>
      response({
        id: "event-7",
        status: "confirmed",
        htmlLink: "https://calendar.example/event-7",
        attendees: [{ email: "grace@example.com" }],
      }),
  ]);

  try {
    await assertRejects(
      () =>
        new CalendarWriteClient(authCell(testAuth()).cell)
          .rsvpToEvent("primary", "event-7", "accepted"),
      Error,
      "You are not listed as an attendee",
    );
  } finally {
    fetchMock.restore();
  }
});
