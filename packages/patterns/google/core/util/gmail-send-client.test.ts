import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  getPatternEnvironment,
  setTestPatternEnvironment,
} from "../../../tools/test-support/commonfabric.ts";
import {
  type AuthCell,
  createReadOnlyAuthCell,
  GmailSendClient,
} from "./gmail-send-client.ts";

type TestAuth = NonNullable<ReturnType<AuthCell["get"]>>;

type FetchCall = {
  url: string;
  init?: RequestInit;
  body?: unknown;
};

const originalFetch = globalThis.fetch;

function auth(overrides: Partial<TestAuth> = {}): TestAuth {
  return {
    token: "access-token",
    tokenType: "Bearer",
    scope: ["https://www.googleapis.com/auth/gmail.modify"],
    expiresIn: 3600,
    expiresAt: 4_102_444_800_000,
    refreshToken: "refresh-token",
    user: {
      email: "sender@example.com",
      name: "Sender",
      picture: "https://example.com/avatar.png",
    },
    ...overrides,
  };
}

function mutableAuthCell(initial: TestAuth | undefined): AuthCell {
  let current = initial;
  return {
    get: () => current,
    update: (values) => {
      current = current ? { ...current, ...values } : undefined;
    },
  };
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function jsonBody(init: RequestInit | undefined): unknown {
  if (init?.body === undefined || init.body === null) {
    return undefined;
  }
  assert(typeof init.body === "string");
  return JSON.parse(init.body);
}

function decodeBase64Url(value: string): string {
  const base64 = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function installFetch(
  handler: (call: FetchCall, index: number) => Response | Promise<Response>,
): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const call = {
      url: requestUrl(input),
      init,
      body: jsonBody(init),
    };
    calls.push(call);
    return await handler(call, calls.length - 1);
  }) as typeof fetch;
  return calls;
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

Deno.test({
  name: "createReadOnlyAuthCell copies auth data and accepts in-memory updates",
  fn() {
    const scopes = ["gmail.readonly"];
    const cell = createReadOnlyAuthCell(auth({ scope: scopes }));

    scopes.push("mutated-after-wrapper");
    assertEquals(cell.get()?.scope, ["gmail.readonly"]);

    cell.update({
      token: "updated-token",
      scope: ["gmail.send"],
    });

    assertEquals(cell.get()?.token, "updated-token");
    assertEquals(cell.get()?.scope, ["gmail.send"]);
  },
});

Deno.test({
  name: "GmailSendClient sends a MIME email through Gmail",
  async fn() {
    const calls = installFetch((call) => {
      assertEquals(
        call.url,
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      );
      assertEquals(call.init?.method, "POST");
      assertEquals(
        (call.init?.headers as Record<string, string>).Authorization,
        "Bearer access-token",
      );
      assertEquals(
        (call.init?.headers as Record<string, string>)["Content-Type"],
        "application/json",
      );

      const body = call.body as { raw: string; threadId: string };
      assertEquals(body.threadId, "thread-1");

      const message = decodeBase64Url(body.raw);
      assert(message.includes("To: recipient@example.com"));
      assert(message.includes("Cc: cc@example.com"));
      assert(message.includes("Bcc: bcc@example.com"));
      assert(message.includes("Subject: =?UTF-8?B?"));
      assert(message.includes("In-Reply-To: <message-1@example.com>"));
      assert(message.includes("References: <message-1@example.com>"));
      assert(message.endsWith("\r\n\r\nHello cafe with accents: cafe"));

      return Response.json({
        id: "sent-message",
        threadId: "thread-1",
        labelIds: ["SENT"],
      });
    });

    try {
      const client = new GmailSendClient(mutableAuthCell(auth()));
      const result = await client.sendEmail({
        to: "recipient@example.com",
        cc: "cc@example.com",
        bcc: "bcc@example.com",
        subject: "Hello café",
        body: "Hello cafe with accents: cafe",
        replyToMessageId: "<message-1@example.com>",
        replyToThreadId: "thread-1",
      });

      assertEquals(result, {
        id: "sent-message",
        threadId: "thread-1",
        labelIds: ["SENT"],
      });
      assertEquals(calls.length, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
});

Deno.test({
  name: "GmailSendClient refreshes auth and retries label operations",
  async fn() {
    const environmentMock = mockPatternEnvironment(
      new URL("https://api.example.test/app/"),
    );
    const cell = mutableAuthCell(auth({
      token: "expired-token",
      refreshToken: "refresh-token-1",
    }));
    const calls = installFetch((call, index) => {
      if (index === 0) {
        assertEquals(
          call.url,
          "https://gmail.googleapis.com/gmail/v1/users/me/messages/msg%2Fone%20two/modify",
        );
        assertEquals(
          (call.init?.headers as Record<string, string>).Authorization,
          "Bearer expired-token",
        );
        assertEquals(call.body, {
          addLabelIds: ["Label_1"],
          removeLabelIds: ["UNREAD"],
        });
        return new Response("", { status: 401 });
      }

      if (index === 1) {
        assertEquals(
          call.url,
          "https://api.example.test/api/integrations/google-oauth/refresh",
        );
        assertEquals(call.init?.method, "POST");
        assertEquals(call.body, { refreshToken: "refresh-token-1" });
        return Response.json({
          tokenInfo: {
            token: "fresh-token",
            tokenType: "Bearer",
            scope: ["https://www.googleapis.com/auth/gmail.modify"],
            expiresIn: 7200,
            expiresAt: 4_102_448_400_000,
            refreshToken: "refresh-token-2",
          },
        });
      }

      if (index === 2) {
        assertEquals(
          call.url,
          "https://gmail.googleapis.com/gmail/v1/users/me/messages/msg%2Fone%20two/modify",
        );
        assertEquals(
          (call.init?.headers as Record<string, string>).Authorization,
          "Bearer fresh-token",
        );
        return Response.json({
          id: "msg/one two",
          threadId: "thread-2",
        });
      }

      if (index === 3) {
        assertEquals(
          call.url,
          "https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify",
        );
        assertEquals(call.body, {
          ids: ["msg-a", "msg-b"],
          addLabelIds: ["STARRED"],
          removeLabelIds: [],
        });
        return new Response(null, { status: 204 });
      }

      assertEquals(
        call.url,
        "https://gmail.googleapis.com/gmail/v1/users/me/labels",
      );
      assertEquals(
        (call.init?.headers as Record<string, string>).Authorization,
        "Bearer fresh-token",
      );
      return Response.json({
        labels: [
          {
            id: "INBOX",
            name: "Inbox",
            type: "system",
            messageListVisibility: "show",
            labelListVisibility: "labelShow",
          },
          {
            id: "Label_1",
            name: "Project",
            type: "user",
          },
        ],
      });
    });

    try {
      const client = GmailSendClient(cell);

      const modified = await client.modifyLabels("msg/one two", {
        addLabelIds: ["Label_1"],
        removeLabelIds: ["UNREAD"],
      });
      assertEquals(modified, {
        id: "msg/one two",
        threadId: "thread-2",
        labelIds: [],
      });
      assertEquals(cell.get()?.token, "fresh-token");
      assertEquals(cell.get()?.refreshToken, "refresh-token-2");
      assertEquals(cell.get()?.user.email, "sender@example.com");

      await client.batchModifyLabels([], { addLabelIds: ["STARRED"] });
      assertEquals(calls.length, 3);

      await client.batchModifyLabels(["msg-a", "msg-b"], {
        addLabelIds: ["STARRED"],
      });

      const labels = await client.listLabels();
      assertEquals(labels, [
        {
          id: "INBOX",
          name: "Inbox",
          type: "system",
          messageListVisibility: "show",
          labelListVisibility: "labelShow",
        },
        {
          id: "Label_1",
          name: "Project",
          type: "user",
          messageListVisibility: undefined,
          labelListVisibility: undefined,
        },
      ]);
      assertEquals(calls.length, 5);
    } finally {
      globalThis.fetch = originalFetch;
      environmentMock.restore();
    }
  },
});

Deno.test({
  name: "GmailSendClient reports local validation and API failures",
  async fn() {
    const emptyClient = GmailSendClient(mutableAuthCell(undefined));

    await assertRejects(
      () =>
        emptyClient.sendEmail({
          to: "recipient@example.com",
          subject: "Missing token",
          body: "Body",
        }),
      Error,
      "No authorization token",
    );
    await assertRejects(
      () => emptyClient.modifyLabels("msg", {}),
      Error,
      "No authorization token",
    );
    await assertRejects(
      () => emptyClient.batchModifyLabels(["msg"], {}),
      Error,
      "No authorization token",
    );
    await assertRejects(
      () => emptyClient.listLabels(),
      Error,
      "No authorization token",
    );

    const client = GmailSendClient(mutableAuthCell(auth()));
    await assertRejects(
      () => client.batchModifyLabels(Array.from({ length: 1001 }, String), {}),
      Error,
      "Cannot batch modify more than 1000 messages",
    );

    installFetch(() =>
      Response.json(
        { error: { message: "denied by test" } },
        { status: 403, statusText: "Forbidden" },
      )
    );

    try {
      await assertRejects(
        () =>
          client.sendEmail({
            to: "recipient@example.com",
            subject: "Denied",
            body: "Body",
          }),
        Error,
        "Gmail API error: 403 denied by test",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
});

Deno.test({
  name: "GmailSendClient stops retrying after repeated auth failures",
  async fn() {
    const environmentMock = mockPatternEnvironment(
      new URL("https://api.example.test/app/"),
    );
    const cell = mutableAuthCell(auth({ token: "stale-token-0" }));
    const calls = installFetch((call, index) => {
      if (call.url.includes("/api/integrations/google-oauth/refresh")) {
        return Response.json({
          tokenInfo: {
            token: `stale-token-${index}`,
            tokenType: "Bearer",
            scope: ["https://www.googleapis.com/auth/gmail.modify"],
            expiresIn: 7200,
            expiresAt: 4_102_448_400_000 + index,
            refreshToken: "refresh-token",
          },
        });
      }

      assertEquals(
        call.url,
        "https://gmail.googleapis.com/gmail/v1/users/me/labels",
      );
      return new Response("", { status: 401 });
    });

    try {
      const client = GmailSendClient(cell);
      await assertRejects(
        () => client.listLabels(),
        Error,
        "Authentication failed after 3 attempts",
      );
      assertEquals(calls.map((call) => call.url), [
        "https://gmail.googleapis.com/gmail/v1/users/me/labels",
        "https://api.example.test/api/integrations/google-oauth/refresh",
        "https://gmail.googleapis.com/gmail/v1/users/me/labels",
        "https://api.example.test/api/integrations/google-oauth/refresh",
        "https://gmail.googleapis.com/gmail/v1/users/me/labels",
      ]);
      assertEquals(cell.get()?.token, "stale-token-3");
    } finally {
      globalThis.fetch = originalFetch;
      environmentMock.restore();
    }
  },
});

Deno.test({
  name: "GmailSendClient refreshes auth while sending and emits debug logs",
  async fn() {
    const environmentMock = mockPatternEnvironment(
      new URL("https://api.example.test/app/"),
    );
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = ((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    }) as typeof console.log;

    const cell = mutableAuthCell(auth({
      token: "expired-send-token",
      refreshToken: "send-refresh-token",
    }));
    const calls = installFetch((call, index) => {
      if (index === 0) {
        assertEquals(
          call.url,
          "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        );
        assertEquals(
          (call.init?.headers as Record<string, string>).Authorization,
          "Bearer expired-send-token",
        );

        const body = call.body as { raw: string; threadId?: string };
        assertEquals(body.threadId, undefined);
        const message = decodeBase64Url(body.raw);
        assert(message.includes("Subject: Plain subject"));
        assert(message.includes("\r\n\r\nBody"));
        return new Response("", { status: 401 });
      }

      if (index === 1) {
        assertEquals(
          call.url,
          "https://api.example.test/api/integrations/google-oauth/refresh",
        );
        assertEquals(call.body, { refreshToken: "send-refresh-token" });
        return Response.json({
          tokenInfo: {
            token: "fresh-send-token",
            tokenType: "Bearer",
            scope: ["https://www.googleapis.com/auth/gmail.send"],
            expiresIn: 7200,
            expiresAt: 4_102_448_400_000,
            refreshToken: "send-refresh-token-2",
          },
        });
      }

      if (index === 2) {
        assertEquals(
          call.url,
          "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        );
        assertEquals(
          (call.init?.headers as Record<string, string>).Authorization,
          "Bearer fresh-send-token",
        );
        return Response.json({
          id: "sent-after-refresh",
          threadId: "thread-after-refresh",
        });
      }

      throw new Error(`Unexpected fetch call ${index}: ${call.url}`);
    });

    try {
      const client = GmailSendClient(cell, { debugMode: true });
      const result = await client.sendEmail({
        to: "recipient@example.com",
        subject: "Plain subject",
        body: "Body",
      });

      assertEquals(result, {
        id: "sent-after-refresh",
        threadId: "thread-after-refresh",
        labelIds: [],
      });
      assertEquals(cell.get()?.token, "fresh-send-token");
      assertEquals(cell.get()?.user.email, "sender@example.com");
      assertEquals(calls.length, 3);
      assert(logs.some((entry) => entry.includes("[GmailSendClient]")));
    } finally {
      globalThis.fetch = originalFetch;
      console.log = originalLog;
      environmentMock.restore();
    }
  },
});

Deno.test({
  name: "GmailSendClient reports API failures for label endpoints",
  async fn() {
    const client = GmailSendClient(mutableAuthCell(auth()));
    let mode: "modify" | "batch" | "labels" = "modify";
    const calls = installFetch((call) => {
      if (mode === "modify") {
        assertEquals(
          call.url,
          "https://gmail.googleapis.com/gmail/v1/users/me/messages/msg/modify",
        );
        assertEquals(call.body, {
          addLabelIds: [],
          removeLabelIds: [],
        });
        return new Response("not json", {
          status: 500,
          statusText: "Modify Failed",
        });
      }

      if (mode === "batch") {
        assertEquals(
          call.url,
          "https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify",
        );
        assertEquals(call.body, {
          ids: ["msg"],
          addLabelIds: [],
          removeLabelIds: ["INBOX"],
        });
        return new Response("not json", {
          status: 503,
          statusText: "Batch Failed",
        });
      }

      assertEquals(
        call.url,
        "https://gmail.googleapis.com/gmail/v1/users/me/labels",
      );
      return new Response("not json", {
        status: 502,
        statusText: "Labels Failed",
      });
    });

    try {
      await assertRejects(
        () => client.modifyLabels("msg", {}),
        Error,
        "Gmail API error: 500 Modify Failed",
      );

      mode = "batch";
      await assertRejects(
        () => client.batchModifyLabels(["msg"], { removeLabelIds: ["INBOX"] }),
        Error,
        "Gmail API error: 503 Batch Failed",
      );

      mode = "labels";
      await assertRejects(
        () => client.listLabels(),
        Error,
        "Gmail API error: 502 Labels Failed",
      );

      assertEquals(calls.length, 3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
});

Deno.test({
  name: "GmailSendClient covers refresh failure paths",
  async fn() {
    const environmentMock = mockPatternEnvironment(
      new URL("https://api.example.test/app/"),
    );

    const batchCell = mutableAuthCell(auth({
      token: "expired-batch-token",
      refreshToken: "batch-refresh-token",
    }));
    const batchCalls = installFetch((call, index) => {
      if (index === 0) {
        assertEquals(
          call.url,
          "https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify",
        );
        assertEquals(
          (call.init?.headers as Record<string, string>).Authorization,
          "Bearer expired-batch-token",
        );
        return new Response("", { status: 401 });
      }

      if (index === 1) {
        assertEquals(
          call.url,
          "https://api.example.test/api/integrations/google-oauth/refresh",
        );
        return Response.json({
          tokenInfo: {
            token: "fresh-batch-token",
            tokenType: "Bearer",
            scope: ["https://www.googleapis.com/auth/gmail.modify"],
            expiresIn: 7200,
            expiresAt: 4_102_448_400_000,
            refreshToken: "batch-refresh-token-2",
          },
        });
      }

      if (index === 2) {
        assertEquals(
          call.url,
          "https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify",
        );
        assertEquals(
          (call.init?.headers as Record<string, string>).Authorization,
          "Bearer fresh-batch-token",
        );
        return new Response(null, { status: 204 });
      }

      throw new Error(`Unexpected fetch call ${index}: ${call.url}`);
    });

    try {
      await GmailSendClient(batchCell).batchModifyLabels(["msg"], {});
      assertEquals(batchCell.get()?.token, "fresh-batch-token");
      assertEquals(batchCalls.length, 3);

      installFetch(() => new Response("", { status: 401 }));
      const retryLimitClient = GmailSendClient(mutableAuthCell(auth()));
      await assertRejects(
        () =>
          retryLimitClient.sendEmail({
            to: "recipient@example.com",
            subject: "Retry limit",
            body: "Body",
          }, 2),
        Error,
        "Authentication failed after 3 attempts",
      );
      await assertRejects(
        () => retryLimitClient.modifyLabels("msg", {}, 2),
        Error,
        "Authentication failed after 3 attempts",
      );
      await assertRejects(
        () => retryLimitClient.batchModifyLabels(["msg"], {}, 2),
        Error,
        "Authentication failed after 3 attempts",
      );

      const withoutRefreshToken = auth({ refreshToken: "" });
      installFetch(() => new Response("", { status: 401 }));
      await assertRejects(
        () =>
          GmailSendClient(mutableAuthCell(withoutRefreshToken)).listLabels(),
        Error,
        "No refresh token available",
      );

      installFetch((_call, index) =>
        index === 0
          ? new Response("", { status: 401 })
          : new Response("", { status: 500 })
      );
      await assertRejects(
        () =>
          GmailSendClient(mutableAuthCell(auth())).sendEmail({
            to: "recipient@example.com",
            subject: "Refresh fails",
            body: "Body",
          }),
        Error,
        "Token refresh failed",
      );

      installFetch((_call, index) =>
        index === 0 ? new Response("", { status: 401 }) : Response.json({})
      );
      await assertRejects(
        () => GmailSendClient(mutableAuthCell(auth())).modifyLabels("msg", {}),
        Error,
        "Invalid refresh response",
      );
    } finally {
      globalThis.fetch = originalFetch;
      environmentMock.restore();
    }
  },
});
