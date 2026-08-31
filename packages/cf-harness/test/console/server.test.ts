import { beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join, resolve, toFileUrl } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import {
  ConsoleServer,
  createConsoleInteractiveServiceOptions,
  resolveConsoleConfig,
} from "../../console/server.ts";
import type { ConsoleSessionListing } from "../../console/sessions.ts";
import {
  createHarnessChatEventEnvelope,
  type HarnessChatEventEnvelope,
  type HarnessChatStructuredEvent,
} from "../../src/contracts/interactive-chat.ts";
import type { HarnessFetch } from "../../src/contracts/http-fetch.ts";
import { PatternIndexClient } from "../../src/pattern-index/client.ts";
import {
  HarnessInteractiveChatService,
  type HarnessInteractivePromptLoopFactory,
} from "../../src/interactive-chat-service.ts";
import type {
  HarnessPromptLoopResult,
  RunHarnessTranscriptOptions,
} from "../../src/prompt-loop.ts";

/**
 * A loop that answers the task it was given and nothing else. The console
 * server's routes are what these tests are about, so the turn behind them only
 * has to reach a terminal state.
 */
const answeringLoop: HarnessInteractivePromptLoopFactory = () => ({
  runTranscript: async (
    options: RunHarnessTranscriptOptions,
  ): Promise<HarnessPromptLoopResult> => {
    const answer = { role: "assistant" as const, content: "built it" };
    const transcript = [...options.transcript, answer];
    await options.onTranscriptEvent?.({ message: answer, transcript });
    return {
      model: "gpt-test",
      finalAssistantText: answer.content,
      transcript,
      modelTurns: 1,
      runState: {} as HarnessPromptLoopResult["runState"],
    };
  },
});

/**
 * A clock that advances a second per reading. Two turns started in the same
 * millisecond are ordered by turn id, which a real session's random ids make
 * arbitrary, so the tests that turn on which turn came first give the service
 * a clock that distinguishes them.
 */
const advancingClock = () => {
  let seconds = 0;
  return () => {
    seconds += 1;
    return `2026-01-01T00:00:${String(seconds).padStart(2, "0")}.000Z`;
  };
};

/** The identity the proxied index client signs with in these tests. */
const signer = await Identity.fromPassphrase("cf-harness console index proxy");

const config = () =>
  resolveConsoleConfig(
    [
      "--fabric-identity",
      "key.pkcs8",
      "--fabric-space",
      "console-test",
      "--session-db",
      "none",
    ],
    {},
    "/console",
  );

/** The same configuration, with an index for the proxy route to reach. */
const configWithIndex = () =>
  resolveConsoleConfig(
    [
      "--fabric-identity",
      "key.pkcs8",
      "--fabric-space",
      "console-test",
      "--session-db",
      "none",
      "--pattern-index-url",
      "https://index.test/api",
    ],
    {},
    "/console",
  );

const jsonRequest = (
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request =>
  new Request(`http://127.0.0.1:8100${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const getRequest = (
  path: string,
  headers: Record<string, string> = {},
): Request => new Request(`http://127.0.0.1:8100${path}`, { headers });

describe("console/server", () => {
  let server: ConsoleServer;
  /** The `Cookie` header the page carries, as loading the page hands it out. */
  let cookie: string;

  beforeEach(async () => {
    server = new ConsoleServer(
      config(),
      (onEvent) =>
        new HarnessInteractiveChatService({
          createPromptLoop: answeringLoop,
          now: advancingClock(),
          onEvent,
        }),
    );
    const page = await server.handle(getRequest("/"));
    await page.body?.cancel();
    cookie = page.headers.get("set-cookie")!.split(";")[0];
  });

  /** Starts a task and waits for the turn it started to finish. */
  const startTask = async (
    body: unknown,
  ): Promise<{ sessionId: string; turnId: string }> => {
    const response = await server.handle(
      jsonRequest("/api/task", body, { cookie }),
    );
    expect(response.status).toBe(200);
    const started = await response.json();
    await server.service.waitForTurn(started.sessionId, started.turnId);
    return started;
  };

  const listSessions = async (): Promise<ConsoleSessionListing> => {
    const response = await server.handle(
      getRequest("/api/sessions", { cookie }),
    );
    expect(response.status).toBe(200);
    return await response.json();
  };

  /** What the index client was asked for, as it composed the request. */
  interface IndexRequest {
    url: string;
    body: string;
  }

  /**
   * A second server, configured with an index, whose client answers from
   * `responses` rather than from a deployment. The client is handed in because
   * the real one reads a keyfile off disk to sign with; what the routes are
   * about is which requests reach it and which are refused before they do.
   */
  const indexServer = async (
    responses: readonly Response[],
  ): Promise<
    { server: ConsoleServer; cookie: string; requests: IndexRequest[] }
  > => {
    const requests: IndexRequest[] = [];
    let answered = 0;
    const fetchFn: HarnessFetch = (input, init) => {
      requests.push({
        url: String(input),
        body: typeof init?.body === "string" ? init.body : "",
      });
      const response = responses[answered] ?? Response.json({});
      answered += 1;
      return Promise.resolve(response);
    };
    const indexed = new ConsoleServer(
      configWithIndex(),
      (onEvent) =>
        new HarnessInteractiveChatService({
          createPromptLoop: answeringLoop,
          now: advancingClock(),
          onEvent,
        }),
      () =>
        Promise.resolve(
          new PatternIndexClient({
            baseUrl: "https://index.test/api",
            fetchFn,
            signer,
          }),
        ),
    );
    const page = await indexed.handle(getRequest("/"));
    await page.body?.cancel();
    return {
      server: indexed,
      cookie: page.headers.get("set-cookie")!.split(";")[0],
      requests,
    };
  };

  /**
   * A server whose cell-label snapshot the test releases by hand, and an
   * event stream already open on it. The snapshot is handed in because it
   * reads a space database this test has none of, and because when it settles
   * is the whole of what these tests are about.
   */
  const snapshotServer = async (
    recordCellLabels: (sessionId: string) => Promise<void>,
  ): Promise<{ server: ConsoleServer; stream: Response }> => {
    const held = new ConsoleServer(
      config(),
      (onEvent) =>
        new HarnessInteractiveChatService({
          createPromptLoop: answeringLoop,
          now: advancingClock(),
          onEvent,
        }),
      undefined,
      recordCellLabels,
    );
    const page = await held.handle(getRequest("/"));
    await page.body?.cancel();
    const streamCookie = page.headers.get("set-cookie")!.split(";")[0];
    return {
      server: held,
      stream: await held.handle(
        getRequest("/api/events?afterSequence=0", { cookie: streamCookie }),
      ),
    };
  };

  const envelope = (
    sequence: number,
    event: HarnessChatStructuredEvent,
  ): HarnessChatEventEnvelope =>
    createHarnessChatEventEnvelope({
      sessionId: "session-1",
      sequence,
      event,
    });

  describe("console prompt configuration", () => {
    it("reads the named prompt and disables child composition guidance", async () => {
      const directory = await Deno.makeTempDir({
        prefix: "cf-harness-console-prompt-",
      });
      try {
        await Deno.writeTextFile(
          join(directory, "system.txt"),
          "COMPOSE FIRST\n",
        );
        const resolved = resolveConsoleConfig(
          [
            "--fabric-identity",
            "key.pkcs8",
            "--fabric-space",
            "console-test",
            "--session-db",
            "none",
            "--system-prompt-file",
            "system.txt",
            "--no-child-composition-guidance",
          ],
          {},
          directory,
        );

        expect(resolved.systemPrompt).toBe("COMPOSE FIRST\n");
        expect(resolved.childCompositionGuidance).toBe(false);
        const serviceOptions = createConsoleInteractiveServiceOptions(
          resolved,
          {
            modelProvider: "openai-compatible-gateway",
            modelAuthSource: "none",
            gatewayAuthMode: "none",
          },
          () => {},
        );
        expect(serviceOptions.systemPrompt).toBe("COMPOSE FIRST\n");
        expect(
          serviceOptions.basePromptLoopOptions?.subagentCompositionGuidance,
        ).toBe(false);
      } finally {
        await Deno.remove(directory, { recursive: true });
      }
    });

    it("rejects a prompt file that cannot be read", () => {
      expect(() =>
        resolveConsoleConfig(
          [
            "--fabric-identity",
            "key.pkcs8",
            "--fabric-space",
            "console-test",
            "--session-db",
            "none",
            "--system-prompt-file",
            "missing.txt",
          ],
          {},
          "/console-prompt-test",
        )
      ).toThrow(
        "--system-prompt-file could not be read: /console-prompt-test/missing.txt",
      );
    });

    it("rejects a prompt file containing only whitespace", async () => {
      const directory = await Deno.makeTempDir({
        prefix: "cf-harness-console-prompt-",
      });
      try {
        const promptPath = join(directory, "empty.txt");
        await Deno.writeTextFile(promptPath, " \n\t");

        expect(() =>
          resolveConsoleConfig(
            [
              "--fabric-identity",
              "key.pkcs8",
              "--fabric-space",
              "console-test",
              "--session-db",
              "none",
              "--system-prompt-file",
              promptPath,
            ],
            {},
            directory,
          )
        ).toThrow(`--system-prompt-file is empty: ${promptPath}`);
      } finally {
        await Deno.remove(directory, { recursive: true });
      }
    });
  });

  describe("the cell-label snapshot a terminal event waits on", () => {
    it("writes a terminal event to a stream only once its snapshot has landed", async () => {
      let land: (() => void) | undefined;
      const snapshot = new Promise<void>((resolve) => {
        land = resolve;
      });
      const held = await snapshotServer(() => snapshot);
      const frames = frameReader(held.stream);
      try {
        held.server.broadcast(
          envelope(1, { kind: "assistant_completed", text: "built it" }),
        );
        // Reading that frame back is what says the stream has drained its
        // backfill: until it has, an envelope is buffered rather than written.
        expect(await frames.next()).toBe("chat:assistant_completed");

        held.server.broadcast(
          envelope(2, { kind: "turn_completed", turnId: "turn-1" }),
        );
        // A frame written while the terminal event is still waiting. A stream
        // delivers in the order it was written, so the terminal event arriving
        // after this one is what says it did not overtake its snapshot.
        held.server.ping();
        land!();

        expect(await frames.next()).toBe("ping");
        expect(await frames.next()).toBe("chat:turn_completed");
      } finally {
        await frames.cancel();
      }
    });

    it("writes a terminal event whose snapshot could not be taken", async () => {
      const held = await snapshotServer(() =>
        Promise.reject(new Error("no space database for console-test"))
      );
      const frames = frameReader(held.stream);
      try {
        held.server.broadcast(
          envelope(1, { kind: "assistant_completed", text: "built it" }),
        );
        expect(await frames.next()).toBe("chat:assistant_completed");

        held.server.broadcast(envelope(2, {
          kind: "turn_failed",
          turnId: "turn-1",
          error: { code: "internal_error", message: "the model gave up" },
        }));

        expect(await frames.next()).toBe("chat:turn_failed");
      } finally {
        await frames.cancel();
      }
    });

    it("loads the server module on a host with no FFI permission", async () => {
      // The console promises a machine without the SQLite native library can
      // serve its page, and a run whose cells there are none of takes no
      // snapshot. So evaluating this module must not open that library.
      const repoRoot = resolve(import.meta.dirname!, "..", "..", "..", "..");
      const wrapperDir = await Deno.makeTempDir({
        prefix: "cf-harness-console-import-",
      });
      try {
        const wrapper = join(wrapperDir, "import-console-server.ts");
        await Deno.writeTextFile(
          wrapper,
          `import ${
            JSON.stringify(
              toFileUrl(join(repoRoot, "packages/cf-harness/console/server.ts"))
                .href,
            )
          };\n`,
        );
        const output = await runDenoCommandWithTemporaryLock({
          root: repoRoot,
          args: (lock) => [
            "run",
            `--lock=${lock}`,
            // The entry sits outside the workspace, so it names the config
            // rather than finding one beside itself.
            `--config=${join(repoRoot, "deno.jsonc")}`,
            "--allow-env",
            wrapper,
          ],
        });
        if (!output.success) {
          console.error(new TextDecoder().decode(output.stderr));
        }
        expect(output.code).toBe(0);
      } finally {
        await Deno.remove(wrapperDir, { recursive: true });
      }
    });
  });

  describe("GET /api/sessions", () => {
    it("answers with no sessions before a task is started", async () => {
      expect(await listSessions()).toEqual({ sessions: [] });
    });

    it("describes a started session by the task it was given", async () => {
      const started = await startTask({ text: "track my books" });

      const listing = await listSessions();
      expect(listing.sessions).toHaveLength(1);
      expect(listing.sessions[0]).toMatchObject({
        sessionId: started.sessionId,
        status: "idle",
        reusable: true,
        turnCount: 1,
        firstTaskText: "track my books",
      });
    });

    it("orders the most recently touched session first", async () => {
      const first = await startTask({ text: "first task" });
      const second = await startTask({ text: "second task" });

      const listing = await listSessions();
      expect(listing.sessions.map((entry) => entry.sessionId)).toEqual([
        second.sessionId,
        first.sessionId,
      ]);
    });
  });

  describe("POST /api/task", () => {
    it("starts a follow-up turn in the session the request names", async () => {
      const started = await startTask({ text: "track my books" });

      const followUp = await startTask({
        text: "add a rating",
        sessionId: started.sessionId,
      });

      expect(followUp.sessionId).toBe(started.sessionId);
      expect(followUp.turnId).not.toBe(started.turnId);
      const listing = await listSessions();
      expect(listing.sessions).toHaveLength(1);
      expect(listing.sessions[0].turnCount).toBe(2);
      expect(listing.sessions[0].firstTaskText).toBe("track my books");
    });

    it("answers 404 for a session that does not exist", async () => {
      const response = await server.handle(jsonRequest("/api/task", {
        text: "track my books",
        sessionId: "session-nobody-started",
      }, { cookie }));

      expect(response.status).toBe(404);
      expect((await response.json()).code).toBe("session_not_found");
    });

    it("answers 400 for a sessionId that is not a string", async () => {
      const response = await server.handle(jsonRequest("/api/task", {
        text: "track my books",
        sessionId: 7,
      }, { cookie }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("sessionId must be a string");
    });
  });

  describe("GET /api/events", () => {
    it("replays a past session's whole history from sequence zero", async () => {
      const started = await startTask({ text: "track my books" });

      const response = await server.handle(getRequest(
        `/api/events?sessionId=${started.sessionId}&afterSequence=0`,
        { cookie },
      ));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      const kinds = await kindsUntil(response, "turn_completed");

      expect(kinds).toEqual([
        "session_started",
        "turn_started",
        "assistant_delta",
        "assistant_completed",
        "turn_completed",
      ]);
    });

    it("replays only the session the stream names", async () => {
      await startTask({ text: "first task" });
      const second = await startTask({ text: "second task" });

      const response = await server.handle(getRequest(
        `/api/events?sessionId=${second.sessionId}&afterSequence=0`,
        { cookie },
      ));
      const sessionIds = new Set(
        (await envelopesUntil(response, "turn_completed")).map((envelope) =>
          envelope.sessionId
        ),
      );

      expect([...sessionIds]).toEqual([second.sessionId]);
    });

    it("answers 400 for an afterSequence that is not a sequence", async () => {
      const response = await server.handle(
        getRequest("/api/events?afterSequence=later", { cookie }),
      );

      expect(response.status).toBe(400);
    });
  });

  describe("POST /api/index/call", () => {
    /** Posts one proxied read at a server that has an index. */
    const call = async (
      indexed: { server: ConsoleServer; cookie: string },
      body: unknown,
    ): Promise<Response> =>
      await indexed.server.handle(
        jsonRequest("/api/index/call", body, { cookie: indexed.cookie }),
      );

    it("answers a host-side failure generically, never with its message", async () => {
      // A factory that cannot build its client throws host-side — an
      // unreadable keyfile names the path the operator configured, which the
      // page must not read.
      const server = new ConsoleServer(
        config(),
        (onEvent) =>
          new HarnessInteractiveChatService({
            createPromptLoop: answeringLoop,
            now: advancingClock(),
            onEvent,
          }),
        () => Promise.reject(new Error("ENOENT: /Users/operator/.secret.key")),
      );
      const page = await server.handle(getRequest("/"));
      await page.body?.cancel();
      const cookie = page.headers.get("set-cookie")!.split(";")[0];
      const response = await server.handle(
        jsonRequest("/api/index/call", { fn: "listPatterns" }, { cookie }),
      );
      expect(response.status).toBe(502);
      const body = await response.json();
      expect(body.error).not.toContain(".secret.key");
      expect(body.error).toContain("see its log");
    });

    it("answers an allowlisted read with what the index returned", async () => {
      const listing = {
        patterns: [{
          patternId: "pat-1",
          description: "Totals an expense list",
          hashtags: ["expenses"],
          keywords: [],
          ownerDid: "did:key:zOwner",
          createdAt: "2026-08-01T00:00:00.000Z",
          events: { run_succeeded: 2 },
          score: 2,
        }],
        eventTypes: { run_succeeded: 1 },
      };
      const indexed = await indexServer([Response.json(listing)]);

      const response = await call(indexed, { fn: "listPatterns" });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(listing);
      expect(indexed.requests[0].url).toBe(
        "https://index.test/api/listPatterns",
      );
      expect(JSON.parse(indexed.requests[0].body)).toEqual({});
    });

    it("sends only the search fields the page supplied", async () => {
      const indexed = await indexServer([Response.json({ results: [] })]);

      await call(indexed, {
        fn: "searchPatterns",
        body: { tags: ["expenses"], text: "totals", limit: 5, mystery: true },
      });

      expect(indexed.requests[0].url).toBe(
        "https://index.test/api/searchPatterns",
      );
      expect(JSON.parse(indexed.requests[0].body)).toEqual({
        tags: ["expenses"],
        text: "totals",
        limit: 5,
      });
    });

    it("asks for a pattern without its source, whatever the page sent", async () => {
      const indexed = await indexServer([
        Response.json({
          patternId: "pat-1",
          ownerDid: "did:key:zOwner",
          createdAt: "2026-08-01T00:00:00.000Z",
          description: "Totals an expense list",
          hashtags: [],
          dependencies: [],
        }),
      ]);

      await call(indexed, {
        fn: "getPattern",
        body: { patternId: "pat-1", includeSource: true },
      });

      expect(JSON.parse(indexed.requests[0].body)).toEqual({
        patternId: "pat-1",
      });
    });

    it("answers 400 for getPattern with no pattern named", async () => {
      const indexed = await indexServer([]);

      const response = await call(indexed, { fn: "getPattern", body: {} });

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("patternId is required");
      expect(indexed.requests).toEqual([]);
    });

    it("answers 400 for a function outside the allowlist", async () => {
      const indexed = await indexServer([]);

      for (
        const fn of ["recordEvent", "publishPattern", "deletePattern", 7]
      ) {
        const response = await call(indexed, {
          fn,
          body: { patternId: "pat-1", eventType: "thumbs_up" },
        });
        expect(response.status).toBe(400);
        expect((await response.json()).error).toContain("fn must be one of");
      }
      expect(indexed.requests).toEqual([]);
    });

    it("answers 400 for a body that is not JSON", async () => {
      const indexed = await indexServer([]);

      const response = await indexed.server.handle(
        new Request("http://127.0.0.1:8100/api/index/call", {
          method: "POST",
          headers: {
            cookie: indexed.cookie,
            "content-type": "application/json",
          },
          body: "not json",
        }),
      );

      expect(response.status).toBe(400);
      expect(indexed.requests).toEqual([]);
    });

    it("passes through the status the index gave a request it faulted", async () => {
      const indexed = await indexServer([
        Response.json({ error: "unknown pattern" }, { status: 404 }),
      ]);

      const response = await call(indexed, {
        fn: "getPattern",
        body: { patternId: "missing" },
      });

      expect(response.status).toBe(404);
      // The message names the function and the status; the index's own body
      // stays behind, as it does everywhere else a failure is rendered.
      expect((await response.json()).error).toBe(
        "pattern index getPattern failed (404)",
      );
    });

    it("answers 502 when the index itself failed", async () => {
      const indexed = await indexServer([
        Response.json({ error: "datastore unavailable" }, { status: 503 }),
      ]);

      const response = await call(indexed, { fn: "listPatterns" });

      expect(response.status).toBe(502);
      expect((await response.json()).error).toContain("listPatterns");
    });

    it("answers 404 when the server was started without an index", async () => {
      const response = await server.handle(
        jsonRequest("/api/index/call", { fn: "listPatterns" }, { cookie }),
      );

      expect(response.status).toBe(404);
      expect((await response.json()).error).toContain(
        "started without a pattern index",
      );
    });
  });

  describe("the served page", () => {
    it("confines the page to this origin with a content security policy", async () => {
      const response = await server.handle(getRequest("/"));
      await response.body?.cancel();

      const policy = response.headers.get("content-security-policy") ?? "";
      expect(policy).toContain("default-src 'self'");
      expect(policy).toContain("object-src 'none'");
      expect(policy).toContain("frame-ancestors 'none'");
      // The run tree indents a row with a `style` attribute, which a policy
      // without this would refuse; a script has no such exception.
      expect(policy).toContain("style-src 'self' 'unsafe-inline'");
      expect(policy).not.toContain("script-src");
      expect(policy).not.toContain("default-src 'self' 'unsafe-inline'");
    });

    it("carries that policy on every path served from the built page", async () => {
      const response = await server.handle(getRequest("/scripts/index.js"));
      await response.body?.cancel();

      expect(response.headers.get("content-security-policy")).toContain(
        "default-src 'self'",
      );
    });

    it("does not answer an API route with a page policy", async () => {
      const response = await server.handle(
        getRequest("/api/sessions", { cookie }),
      );
      await response.json();

      expect(response.headers.get("content-security-policy")).toBeNull();
    });
  });

  describe("request authorization", () => {
    it("hands the page a strictly same-site token cookie", async () => {
      const response = await server.handle(getRequest("/"));
      await response.body?.cancel();

      const setCookie = response.headers.get("set-cookie") ?? "";
      expect(setCookie).toMatch(/^cf_harness_console_token=.+/);
      expect(setCookie).toContain("SameSite=Strict");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("Path=/");
    });

    it("answers an API request carrying that cookie", async () => {
      const response = await server.handle(
        getRequest("/api/sessions", { cookie }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ sessions: [] });
    });

    it("answers 403 for a page request naming another host", async () => {
      const response = await server.handle(
        getRequest("/", { host: "evil.test:8100" }),
      );
      await response.body?.cancel();

      expect(response.status).toBe(403);
    });

    it("answers 403 for an API request naming another host", async () => {
      const response = await server.handle(
        getRequest("/api/sessions", { cookie, host: "evil.test:8100" }),
      );

      expect(response.status).toBe(403);
    });

    it("answers 403 for an API request from another origin", async () => {
      const response = await server.handle(jsonRequest("/api/task", {
        text: "track my books",
      }, { cookie, origin: "http://evil.test" }));

      expect(response.status).toBe(403);
    });

    it("answers 403 for a first turn started without the cookie", async () => {
      const response = await server.handle(
        jsonRequest("/api/task", { text: "track my books" }),
      );

      expect(response.status).toBe(403);
      expect(await listSessions()).toEqual({ sessions: [] });
    });

    it("answers 403 for a follow-up turn started without the cookie", async () => {
      const started = await startTask({ text: "track my books" });

      const response = await server.handle(jsonRequest("/api/task", {
        text: "add a rating",
        sessionId: started.sessionId,
      }));

      expect(response.status).toBe(403);
      expect((await listSessions()).sessions[0].turnCount).toBe(1);
    });

    it("answers 403 for a session listing read without the cookie", async () => {
      const response = await server.handle(getRequest("/api/sessions"));

      expect(response.status).toBe(403);
    });

    it("answers 403 for an event stream opened without the cookie", async () => {
      const response = await server.handle(getRequest("/api/events"));
      await response.body?.cancel();

      expect(response.status).toBe(403);
      expect(response.headers.get("content-type")).not.toBe(
        "text/event-stream",
      );
    });

    it("answers 403 for an API request carrying another process's token", async () => {
      const response = await server.handle(
        getRequest("/api/sessions", {
          cookie:
            "cf_harness_console_token=00000000-0000-4000-8000-000000000000",
        }),
      );

      expect(response.status).toBe(403);
    });

    it("answers 403 for an index read made without the cookie", async () => {
      const indexed = await indexServer([]);
      const response = await indexed.server.handle(
        jsonRequest("/api/index/call", { fn: "listPatterns" }),
      );

      expect(response.status).toBe(403);
      expect(indexed.requests).toEqual([]);
    });

    it("answers 403 for an index read from another origin", async () => {
      const indexed = await indexServer([]);
      const response = await indexed.server.handle(
        jsonRequest("/api/index/call", { fn: "listPatterns" }, {
          cookie: indexed.cookie,
          origin: "http://evil.test",
        }),
      );

      expect(response.status).toBe(403);
      expect(indexed.requests).toEqual([]);
    });

    it("answers 415 for a task posted as a form submission", async () => {
      const response = await server.handle(
        new Request("http://127.0.0.1:8100/api/task", {
          method: "POST",
          headers: { cookie, "content-type": "text/plain;charset=UTF-8" },
          body: JSON.stringify({ text: "track my books" }),
        }),
      );

      expect(response.status).toBe(415);
    });
  });
});

interface StreamedEnvelope {
  sessionId: string;
  sequence: number;
  event: { kind: string };
}

/**
 * The envelopes a stream writes up to and including the one of `finalKind`.
 * The reader resolves on each chunk the server enqueues, so the read ends when
 * the replay reaches that event rather than after any span of time.
 */
const envelopesUntil = async (
  response: Response,
  finalKind: string,
): Promise<readonly StreamedEnvelope[]> => {
  const reader = response.body!.pipeThrough(new TextDecoderStream())
    .getReader();
  const envelopes: StreamedEnvelope[] = [];
  let buffered = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        return envelopes;
      }
      buffered += chunk.value;
      const frames = buffered.split("\n\n");
      buffered = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame.split("\n").find((line) =>
          line.startsWith("data: ")
        );
        if (data === undefined || !frame.startsWith("event: chat")) {
          continue;
        }
        const envelope: StreamedEnvelope = JSON.parse(data.slice(6));
        envelopes.push(envelope);
        if (envelope.event.kind === finalKind) {
          return envelopes;
        }
      }
    }
  } finally {
    await reader.cancel();
  }
};

/**
 * One SSE frame at a time, named `<event>` for a frame the server writes
 * itself and `chat:<kind>` for a chat envelope. Each read resolves on the
 * chunk the server enqueued, so it ends when a frame is written rather than
 * after any span of time.
 */
const frameReader = (response: Response): {
  next: () => Promise<string>;
  cancel: () => Promise<void>;
} => {
  const reader = response.body!.pipeThrough(new TextDecoderStream())
    .getReader();
  const named = (frame: string): string | undefined => {
    const lines = frame.split("\n");
    const event = lines.find((line) => line.startsWith("event: "))?.slice(7);
    if (event === undefined) {
      return undefined;
    }
    if (event !== "chat") {
      return event;
    }
    const data = lines.find((line) => line.startsWith("data: "))!.slice(6);
    return `chat:${(JSON.parse(data) as StreamedEnvelope).event.kind}`;
  };
  const read: string[] = [];
  let buffered = "";
  return {
    next: async (): Promise<string> => {
      while (read.length === 0) {
        const chunk = await reader.read();
        if (chunk.done) {
          throw new Error("the stream closed before it wrote another frame");
        }
        buffered += chunk.value;
        const frames = buffered.split("\n\n");
        buffered = frames.pop() ?? "";
        for (const frame of frames) {
          const name = named(frame);
          if (name !== undefined) {
            read.push(name);
          }
        }
      }
      return read.shift()!;
    },
    cancel: () => reader.cancel(),
  };
};

const kindsUntil = async (
  response: Response,
  finalKind: string,
): Promise<readonly string[]> =>
  (await envelopesUntil(response, finalKind)).map((envelope) =>
    envelope.event.kind
  );
