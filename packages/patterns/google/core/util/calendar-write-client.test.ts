import { assertEquals, assertRejects } from "@std/assert";
import type { Writable } from "commonfabric";
import {
  getPatternEnvironment,
  setTestPatternEnvironment,
} from "../../../tools/test-support/commonfabric.ts";
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
    } as Writable<Auth>,
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

function mockConsoleLog(): { calls: unknown[][]; restore(): void } {
  const originalLog = console.log;
  const calls: unknown[][] = [];
  console.log = (...args: unknown[]) => {
    calls.push(args);
  };

  return {
    calls,
    restore: () => {
      console.log = originalLog;
    },
  };
}

function mockMissingSesGlobals(): { restore(): void } {
  const intlDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Intl");
  const timeoutDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "setTimeout",
  );

  Object.defineProperty(globalThis, "Intl", {
    configurable: true,
    value: undefined,
    writable: true,
  });
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    value: undefined,
    writable: true,
  });

  return {
    restore: () => {
      if (intlDescriptor) {
        Object.defineProperty(globalThis, "Intl", intlDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "Intl");
      }
      if (timeoutDescriptor) {
        Object.defineProperty(globalThis, "setTimeout", timeoutDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "setTimeout");
      }
    },
  };
}

function mockPatternEnvironment(apiUrl: URL): { restore(): void } {
  const originalPatternEnvironment = getPatternEnvironment();
  const originalLocation = Object.getOwnPropertyDescriptor(
    globalThis,
    "location",
  );
  setTestPatternEnvironment({ apiUrl });
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href: apiUrl.href } as Location,
  });

  return {
    restore: () => {
      setTestPatternEnvironment(originalPatternEnvironment);
      if (originalLocation) {
        Object.defineProperty(globalThis, "location", originalLocation);
      } else {
        Reflect.deleteProperty(globalThis, "location");
      }
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
  const consoleMock = mockConsoleLog();

  try {
    const { cell } = authCell(testAuth());
    const client = new CalendarWriteClient(cell, { debugMode: true });
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
    assertEquals(consoleMock.calls.length, 2);
    assertEquals(consoleMock.calls[0][0], "[CalendarWriteClient]");
    assertEquals(consoleMock.calls[1].at(-1), "event-1");
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
      },
      end: {
        dateTime: "2026-01-15T11:00:00.000Z",
      },
      description: "Discuss roadmap",
      location: "Room 1",
      attendees: [{ email: "grace@example.com" }],
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=2"],
    });
  } finally {
    consoleMock.restore();
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
        description: "Updated agenda",
        location: "Room 2",
        start: "2026-02-01T09:00:00.000Z",
        end: "2026-02-01T10:00:00.000Z",
        attendees: ["ada@example.com"],
        isAllDay: true,
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
      description: "Updated agenda",
      location: "Room 2",
      start: {
        date: "2026-02-01",
      },
      end: {
        date: "2026-02-01",
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
  const environmentMock = mockPatternEnvironment(
    new URL("https://toolshed.example/app/"),
  );
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
    environmentMock.restore();
  }
});

Deno.test("CalendarWriteClient tolerates SES globals without Intl or timers", async () => {
  const environmentMock = mockPatternEnvironment(
    new URL("https://toolshed.example/app/"),
  );
  const sesGlobals = mockMissingSesGlobals();
  const fetchMock = mockFetch([
    () => response({ error: { message: "Expired" } }, 401, "Unauthorized"),
    () =>
      response({
        tokenInfo: {
          token: "ses-token",
          tokenType: "Bearer",
          scope: ["https://www.googleapis.com/auth/calendar.events"],
          expiresIn: 3600,
          expiresAt: 6,
          refreshToken: "ses-refresh-token",
        },
      }),
    () =>
      response({
        id: "event-ses",
        status: "confirmed",
        htmlLink: "https://calendar.example/event-ses",
      }),
    () =>
      response({
        id: "batch-1",
        status: "confirmed",
        htmlLink: "https://calendar.example/batch-1",
      }),
    () =>
      response({
        id: "batch-2",
        status: "confirmed",
        htmlLink: "https://calendar.example/batch-2",
      }),
  ]);

  try {
    const client = new CalendarWriteClient(authCell(testAuth()).cell);
    const created = await client.createEvent({
      calendarId: "primary",
      summary: "SES Meeting",
      start: "2026-03-02T09:00:00.000Z",
      end: "2026-03-02T10:00:00.000Z",
    });
    const batch = await client.createBatchEvents({
      calendarId: "primary",
      batchDelayMs: 25,
      batchSize: 1,
      events: [
        {
          clientId: "a",
          summary: "First SES Batch",
          start: "2026-03-03T09:00:00.000Z",
          end: "2026-03-03T10:00:00.000Z",
        },
        {
          clientId: "b",
          summary: "Second SES Batch",
          start: "2026-03-04T09:00:00.000Z",
          end: "2026-03-04T10:00:00.000Z",
        },
      ],
    });

    assertEquals(created.id, "event-ses");
    assertEquals(batch.succeeded, 2);
    assertEquals(requestBody(fetchMock.requests[2]), {
      summary: "SES Meeting",
      start: { dateTime: "2026-03-02T09:00:00.000Z" },
      end: { dateTime: "2026-03-02T10:00:00.000Z" },
    });
    assertEquals(fetchMock.requests.length, 5);
  } finally {
    fetchMock.restore();
    sesGlobals.restore();
    environmentMock.restore();
  }
});

Deno.test("CalendarWriteClient surfaces create and refresh failures", async () => {
  await assertRejects(
    () =>
      new CalendarWriteClient(authCell(testAuth({ token: "" })).cell)
        .createEvent({
          calendarId: "primary",
          summary: "No Token",
          start: "2026-03-01T09:00:00.000Z",
          end: "2026-03-01T10:00:00.000Z",
        }),
    Error,
    "No authorization token",
  );

  const exhaustedFetch = mockFetch([
    () => response({ error: { message: "Expired" } }, 401, "Unauthorized"),
  ]);
  try {
    await assertRejects(
      () =>
        new CalendarWriteClient(authCell(testAuth()).cell).createEvent({
          calendarId: "primary",
          summary: "Exhausted",
          start: "2026-03-01T09:00:00.000Z",
          end: "2026-03-01T10:00:00.000Z",
        }, 2),
      Error,
      "Authentication failed after 3 attempts",
    );
  } finally {
    exhaustedFetch.restore();
  }

  const missingRefreshFetch = mockFetch([
    () => response({ error: { message: "Expired" } }, 401, "Unauthorized"),
  ]);
  try {
    await assertRejects(
      () =>
        new CalendarWriteClient(
          authCell(testAuth({ refreshToken: "" })).cell,
        ).createEvent({
          calendarId: "primary",
          summary: "Missing Refresh",
          start: "2026-03-01T09:00:00.000Z",
          end: "2026-03-01T10:00:00.000Z",
        }),
      Error,
      "No refresh token available",
    );
  } finally {
    missingRefreshFetch.restore();
  }

  const refreshFailureFetch = mockFetch([
    () => response({ error: { message: "Expired" } }, 401, "Unauthorized"),
    () => response({ error: "revoked" }, 400, "Bad Request"),
  ]);
  try {
    await assertRejects(
      () =>
        new CalendarWriteClient(authCell(testAuth()).cell).createEvent({
          calendarId: "primary",
          summary: "Refresh Failed",
          start: "2026-03-01T09:00:00.000Z",
          end: "2026-03-01T10:00:00.000Z",
        }),
      Error,
      "Token refresh failed",
    );
  } finally {
    refreshFailureFetch.restore();
  }

  const invalidRefreshFetch = mockFetch([
    () => response({ error: { message: "Expired" } }, 401, "Unauthorized"),
    () => response({ ok: true }),
  ]);
  try {
    await assertRejects(
      () =>
        new CalendarWriteClient(authCell(testAuth()).cell).createEvent({
          calendarId: "primary",
          summary: "Invalid Refresh",
          start: "2026-03-01T09:00:00.000Z",
          end: "2026-03-01T10:00:00.000Z",
        }),
      Error,
      "Invalid refresh response",
    );
  } finally {
    invalidRefreshFetch.restore();
  }
});

Deno.test("CalendarWriteClient covers update retry and error paths", async () => {
  await assertRejects(
    () =>
      new CalendarWriteClient(authCell(testAuth({ token: "" })).cell)
        .updateEvent("primary", "event-8", { summary: "No Token" }),
    Error,
    "No authorization token",
  );

  const retryFetch = mockFetch([
    () => response({ error: { message: "Expired" } }, 401, "Unauthorized"),
    () =>
      response({
        tokenInfo: {
          token: "retry-token",
          tokenType: "Bearer",
          scope: ["https://www.googleapis.com/auth/calendar.events"],
          expiresIn: 3600,
          expiresAt: 3,
          refreshToken: "retry-refresh-token",
        },
      }),
    () =>
      response({
        id: "event-8",
        status: "confirmed",
        htmlLink: "https://calendar.example/event-8",
      }),
  ]);
  try {
    const auth = authCell(testAuth());
    const client = new CalendarWriteClient(auth.cell);
    const updated = await client.updateEvent("primary", "event-8", {
      summary: "Retry Update",
    });

    assertEquals(updated.id, "event-8");
    assertEquals(retryFetch.requests[2].init?.headers, {
      Authorization: "Bearer retry-token",
      "Content-Type": "application/json",
    });
  } finally {
    retryFetch.restore();
  }

  const exhaustedFetch = mockFetch([
    () => response({ error: { message: "Expired" } }, 401, "Unauthorized"),
  ]);
  try {
    await assertRejects(
      () =>
        new CalendarWriteClient(authCell(testAuth()).cell)
          .updateEvent(
            "primary",
            "event-8",
            { summary: "Still Expired" },
            "all",
            2,
          ),
      Error,
      "Authentication failed after 3 attempts",
    );
  } finally {
    exhaustedFetch.restore();
  }

  const errorFetch = mockFetch([
    () =>
      response(
        { error: { message: "calendar not found" } },
        404,
        "Not Found",
      ),
  ]);
  try {
    await assertRejects(
      () =>
        new CalendarWriteClient(authCell(testAuth()).cell)
          .updateEvent("missing", "event-8", { summary: "Nope" }),
      Error,
      "Calendar API error: 404 calendar not found",
    );
  } finally {
    errorFetch.restore();
  }
});

Deno.test("CalendarWriteClient covers delete retry and error paths", async () => {
  const retryFetch = mockFetch([
    () => response({ error: { message: "Expired" } }, 401, "Unauthorized"),
    () =>
      response({
        tokenInfo: {
          token: "delete-token",
          tokenType: "Bearer",
          scope: ["https://www.googleapis.com/auth/calendar.events"],
          expiresIn: 3600,
          expiresAt: 4,
          refreshToken: "delete-refresh-token",
        },
      }),
    () => emptyResponse(),
  ]);
  try {
    const client = new CalendarWriteClient(authCell(testAuth()).cell);
    await client.deleteEvent("primary", "event-9");

    assertEquals(retryFetch.requests[2].init?.headers, {
      Authorization: "Bearer delete-token",
    });
  } finally {
    retryFetch.restore();
  }

  const exhaustedFetch = mockFetch([
    () => response({ error: { message: "Expired" } }, 401, "Unauthorized"),
  ]);
  try {
    await assertRejects(
      () =>
        new CalendarWriteClient(authCell(testAuth()).cell)
          .deleteEvent("primary", "event-9", "all", 2),
      Error,
      "Authentication failed after 3 attempts",
    );
  } finally {
    exhaustedFetch.restore();
  }

  const errorFetch = mockFetch([
    () => response({ error: { message: "locked" } }, 409, "Conflict"),
  ]);
  try {
    await assertRejects(
      () =>
        new CalendarWriteClient(authCell(testAuth()).cell)
          .deleteEvent("primary", "event-9"),
      Error,
      "Calendar API error: 409 locked",
    );
  } finally {
    errorFetch.restore();
  }
});

Deno.test("CalendarWriteClient covers RSVP retry and error paths", async () => {
  await assertRejects(
    () =>
      new CalendarWriteClient(authCell(testAuth({ token: "" })).cell)
        .rsvpToEvent("primary", "event-10", "accepted"),
    Error,
    "No authorization token",
  );

  await assertRejects(
    () =>
      new CalendarWriteClient(
        authCell(testAuth({ user: { email: "", name: "", picture: "" } }))
          .cell,
      ).rsvpToEvent("primary", "event-10", "accepted"),
    Error,
    "No user email available",
  );

  const retryFetch = mockFetch([
    () => response({ error: { message: "Expired" } }, 401, "Unauthorized"),
    () =>
      response({
        tokenInfo: {
          token: "rsvp-token",
          tokenType: "Bearer",
          scope: ["https://www.googleapis.com/auth/calendar.events"],
          expiresIn: 3600,
          expiresAt: 5,
          refreshToken: "rsvp-refresh-token",
        },
      }),
    () =>
      response({
        id: "event-10",
        status: "confirmed",
        htmlLink: "https://calendar.example/event-10",
        attendees: [{ email: "ada@example.com" }],
      }),
    () =>
      response({
        id: "event-10",
        status: "confirmed",
        htmlLink: "https://calendar.example/event-10",
      }),
  ]);
  try {
    const client = new CalendarWriteClient(authCell(testAuth()).cell);
    const rsvp = await client.rsvpToEvent("primary", "event-10", "accepted");

    assertEquals(rsvp.id, "event-10");
    assertEquals(retryFetch.requests[2].init?.headers, {
      Authorization: "Bearer rsvp-token",
    });
  } finally {
    retryFetch.restore();
  }

  const exhaustedFetch = mockFetch([
    () => response({ error: { message: "Expired" } }, 401, "Unauthorized"),
  ]);
  try {
    await assertRejects(
      () =>
        new CalendarWriteClient(authCell(testAuth()).cell)
          .rsvpToEvent("primary", "event-10", "accepted", 2),
      Error,
      "Authentication failed after 3 attempts",
    );
  } finally {
    exhaustedFetch.restore();
  }

  const getErrorFetch = mockFetch([
    () => response({ error: { message: "gone" } }, 410, "Gone"),
  ]);
  try {
    await assertRejects(
      () =>
        new CalendarWriteClient(authCell(testAuth()).cell)
          .rsvpToEvent("primary", "event-10", "accepted"),
      Error,
      "Failed to fetch event: 410 gone",
    );
  } finally {
    getErrorFetch.restore();
  }

  const patchErrorFetch = mockFetch([
    () =>
      response({
        id: "event-10",
        status: "confirmed",
        htmlLink: "https://calendar.example/event-10",
        attendees: [{ email: "ada@example.com" }],
      }),
    () => response({ error: { message: "cannot RSVP" } }, 403, "Forbidden"),
  ]);
  try {
    await assertRejects(
      () =>
        new CalendarWriteClient(authCell(testAuth()).cell)
          .rsvpToEvent("primary", "event-10", "accepted"),
      Error,
      "Calendar API error: 403 cannot RSVP",
    );
  } finally {
    patchErrorFetch.restore();
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
