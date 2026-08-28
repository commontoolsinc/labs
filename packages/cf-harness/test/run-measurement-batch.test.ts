import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";

import {
  ConsoleClient,
  indexChangeOf,
  type IndexPreflight,
  type IndexSnapshot,
  parseMeasurementSuite,
  preflightPosture,
  readAncestry,
  readServerMeta,
  readSseFrames,
  renderBatchReport,
  runTask,
} from "../scripts/run-measurement-batch.ts";
import { main } from "../scripts/run-measurement-batch.ts";

const FIXTURE_ROOT = fromFileUrl(
  new URL("./support/measure-runs/runs", import.meta.url),
);

const TOKEN = "cf_harness_console_token=fixture-token";

const sseBody = (frames: readonly string[], keepOpen: boolean): BodyInit => {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(": connected\n\n"));
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      if (!keepOpen) controller.close();
    },
  });
};

const chatFrame = (
  sequence: number,
  sessionId: string,
  event: Record<string, unknown>,
): string =>
  `event: chat\nid: ${sequence}\ndata: ${
    JSON.stringify({
      type: "cf-harness.chat.event",
      protocolVersion: 1,
      sessionId,
      sequence,
      emittedAt: "2026-08-28T21:00:00.000Z",
      event,
    })
  }\n\n`;

interface FakeConsoleOptions {
  /**
   * The event streams the server hands out, in the order they are asked for.
   * The last one is repeated once the list runs out.
   */
  streams: readonly { frames: readonly string[]; keepOpen: boolean }[];
  runId?: string;
  artifactRoot?: string;
  patterns?: readonly Record<string, unknown>[];

  /** What `/api/index/call` answers, and with what status. */
  indexAnswer?: { status: number; body: unknown };

  /** What `/api/meta` answers, standing in for the fabric server. */
  meta?: unknown;
}

interface FakeConsole {
  url: string;
  taskTexts: readonly string[];
  eventRequests: readonly string[];
  close: () => Promise<void>;
}

const startFakeConsole = (options: FakeConsoleOptions): FakeConsole => {
  const taskTexts: string[] = [];
  const eventRequests: string[] = [];
  let streamIndex = 0;
  const server = Deno.serve({
    port: 0,
    onListen: () => {},
  }, async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return new Response("<!doctype html>", {
        headers: {
          "set-cookie": `${TOKEN}; SameSite=Strict; HttpOnly; Path=/`,
        },
      });
    }
    // The fabric server is a different host from the console and gates
    // nothing on the console's token, so this answers before the gate.
    if (url.pathname === "/api/meta") {
      return Response.json(options.meta ?? META);
    }
    if (request.headers.get("cookie") !== TOKEN) {
      return new Response("forbidden", { status: 403 });
    }
    if (url.pathname === "/api/task") {
      const body = await request.json() as { text: string };
      taskTexts.push(body.text);
      return Response.json({
        sessionId: "session-1",
        turnId: "turn-1",
      });
    }
    if (url.pathname === "/api/events") {
      eventRequests.push(url.searchParams.get("afterSequence") ?? "");
      const stream = options.streams[
        Math.min(streamIndex++, options.streams.length - 1)
      ];
      return new Response(sseBody(stream.frames, stream.keepOpen), {
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (url.pathname === "/api/status") {
      return Response.json({
        sessions: [{
          sessionId: url.searchParams.get("sessionId"),
          status: "idle",
          ...(options.runId !== undefined
            ? { harnessRunId: options.runId }
            : {}),
          ...(options.artifactRoot !== undefined
            ? { artifactRoot: options.artifactRoot }
            : {}),
        }],
      });
    }
    if (url.pathname === "/api/index/call") {
      const answer = options.indexAnswer;
      if (answer !== undefined) {
        return Response.json(answer.body, { status: answer.status });
      }
      const { fn } = await request.json() as { fn: string };
      return Response.json(
        fn === "searchPatterns"
          ? { results: [], candidates: 30 }
          : { patterns: options.patterns ?? [] },
      );
    }
    return new Response("not found", { status: 404 });
  });
  return {
    url: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
    taskTexts,
    eventRequests,
    close: () => server.shutdown(),
  };
};

const completedStream = (sequence = 7) => ({
  frames: [
    chatFrame(sequence - 1, "session-1", {
      kind: "turn_started",
      turn: { turnId: "turn-1" },
    }),
    chatFrame(sequence, "session-1", {
      kind: "turn_completed",
      turnId: "turn-1",
      finalText: "Your reading list is at /reading-list.",
    }),
  ],
  keepOpen: true,
});

const patternOf = (
  patternId: string,
  score: number,
): Record<string, unknown> => ({
  patternId,
  description: `${patternId} does a thing.`,
  score,
  events: { published: 1 },
});

const META = {
  gitSha: "7baa03f462e5a1e4b5e477bd2162c880c5e5bc4a",
  cfc: { enforcementMode: "enforce-explicit", flowLabels: "off" },
  experimentalFlags: { serverExecution: true },
};

const POSTURE = {
  kind: "read" as const,
  meta: META,
  ancestry: { kind: "ancestor" as const, base: "main" },
};

const metaFetch = (
  body: unknown,
  status = 200,
): typeof globalThis.fetch =>
  ((_input, _init) =>
    Promise.resolve(
      Response.json(body, { status }),
    )) as typeof globalThis.fetch;

/** A stand-in `git`, keyed by the subcommand the reading issues. */
const gitRun = (
  known: boolean,
  ancestor: boolean,
) =>
(args: readonly string[]) =>
  Promise.resolve(
    args[0] === "cat-file"
      ? { success: known, code: known ? 0 : 1 }
      : { success: ancestor, code: ancestor ? 0 : 1 },
  );

describe("run-measurement-batch", () => {
  describe("parseMeasurementSuite()", () => {
    it("returns the suite for a well-formed file", () => {
      expect(parseMeasurementSuite({
        label: "tonight",
        notes: "against the seeded index",
        tasks: [{ id: "books", text: "Track the books I am reading." }],
      })).toEqual({
        label: "tonight",
        notes: "against the seeded index",
        tasks: [{ id: "books", text: "Track the books I am reading." }],
      });
    });

    it("throws for a suite carrying no tasks", () => {
      expect(() => parseMeasurementSuite({ label: "empty", tasks: [] }))
        .toThrow("at least one task");
    });

    it("throws for a suite carrying no label", () => {
      expect(() => parseMeasurementSuite({ tasks: [{ id: "a", text: "b" }] }))
        .toThrow("non-empty label");
    });

    it("throws for a task carrying no text", () => {
      expect(() => parseMeasurementSuite({ label: "l", tasks: [{ id: "a" }] }))
        .toThrow("task a carries no text");
    });

    it("returns the seeded pattern identifiers a suite names", () => {
      expect(
        parseMeasurementSuite({
          label: "l",
          tasks: [{ id: "a", text: "one" }],
          seededPatternIds: ["seed-1", "seed-2"],
        }).seededPatternIds,
      ).toEqual(["seed-1", "seed-2"]);
    });

    it("throws for seeded pattern identifiers that are not strings", () => {
      expect(() =>
        parseMeasurementSuite({
          label: "l",
          tasks: [{ id: "a", text: "one" }],
          seededPatternIds: [1],
        })
      ).toThrow("must be a list of strings");
    });

    it("throws for two tasks sharing an id", () => {
      expect(() =>
        parseMeasurementSuite({
          label: "l",
          tasks: [{ id: "a", text: "one" }, { id: "a", text: "two" }],
        })
      ).toThrow("two tasks share the id a");
    });
  });

  describe("readSseFrames()", () => {
    const streamOf = (text: string): ReadableStream<Uint8Array> => {
      const encoder = new TextEncoder();
      return new ReadableStream<Uint8Array>({
        start(controller) {
          // One byte at a time, so a frame split across reads is exercised.
          for (const byte of encoder.encode(text)) {
            controller.enqueue(new Uint8Array([byte]));
          }
          controller.close();
        },
      });
    };

    it("returns each frame's event name, data and sequence", async () => {
      const frames = [];
      for await (
        const frame of readSseFrames(
          streamOf(': connected\n\nevent: chat\nid: 4\ndata: {"a":1}\n\n'),
        )
      ) {
        frames.push(frame);
      }
      expect(frames).toEqual([{ event: "chat", data: '{"a":1}', id: 4 }]);
    });

    it("returns no frame for a comment-only stream", async () => {
      const frames = [];
      for await (const frame of readSseFrames(streamOf(": connected\n\n"))) {
        frames.push(frame);
      }
      expect(frames).toEqual([]);
    });
  });

  describe("indexChangeOf()", () => {
    const before: IndexSnapshot = {
      kind: "read",
      patterns: [patternOf("kept", 1), patternOf("gone", 2)] as never,
    };
    const after: IndexSnapshot = {
      kind: "read",
      patterns: [patternOf("kept", 5), patternOf("fresh", 0)] as never,
    };

    it("returns the patterns added, removed and rescored between two readings", () => {
      const change = indexChangeOf(before, after);
      expect(change?.added.map((pattern) => pattern.patternId)).toEqual([
        "fresh",
      ]);
      expect(change?.removed.map((pattern) => pattern.patternId)).toEqual([
        "gone",
      ]);
      expect(change?.rescored).toEqual([
        { patternId: "kept", before: 1, after: 5 },
      ]);
    });

    it("returns `undefined` when either reading was not taken", () => {
      const unread: IndexSnapshot = { kind: "unread", reason: "no index" };
      expect(indexChangeOf(unread, after)).toBeUndefined();
      expect(indexChangeOf(before, unread)).toBeUndefined();
    });
  });

  describe("ConsoleClient", () => {
    describe("open()", () => {
      it("throws for a server that hands out no token cookie", async () => {
        const server = Deno.serve(
          { port: 0, onListen: () => {} },
          () => new Response("no cookie here"),
        );
        try {
          await expect(
            ConsoleClient.open(
              `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
            ),
          ).rejects.toThrow("handed out no cf_harness_console_token cookie");
        } finally {
          await server.shutdown();
        }
      });
    });

    describe("awaitTurn()", () => {
      it("returns the terminal event the console published for the turn", async () => {
        const console_ = startFakeConsole({ streams: [completedStream()] });
        try {
          const client = await ConsoleClient.open(console_.url);
          const started = await client.startTask("Track my books.");
          expect(await client.awaitTurn(started)).toEqual({
            kind: "turn_completed",
            detail: "Your reading list is at /reading-list.",
          });
        } finally {
          await console_.close();
        }
      });

      it("resumes from the newest sequence it read when the stream is reopened", async () => {
        const console_ = startFakeConsole({
          streams: [
            // A stream the server closes having delivered only a liveness
            // tick: progress, so the client reconnects rather than giving up.
            { frames: ["event: ping\ndata: 1\n\n"], keepOpen: false },
            completedStream(11),
          ],
        });
        try {
          const client = await ConsoleClient.open(console_.url);
          const started = await client.startTask("Track my books.");
          expect((await client.awaitTurn(started)).kind).toBe("turn_completed");
          expect(console_.eventRequests).toEqual(["0", "0"]);
          const second = await client.startTask("Track my films.");
          await client.awaitTurn(second);
          expect(console_.eventRequests[2]).toBe("11");
        } finally {
          await console_.close();
        }
      });

      it("returns an unwitnessed outcome for a stream the console closes having said nothing", async () => {
        const console_ = startFakeConsole({
          streams: [{ frames: [], keepOpen: false }],
        });
        try {
          const client = await ConsoleClient.open(console_.url);
          const started = await client.startTask("Track my books.");
          expect(await client.awaitTurn(started)).toEqual({
            kind: "unwitnessed",
            reason:
              "the console closed the event stream without delivering a frame",
          });
        } finally {
          await console_.close();
        }
      });

      it("reads past an event belonging to another session", async () => {
        const console_ = startFakeConsole({
          streams: [{
            frames: [
              chatFrame(3, "someone-else", {
                kind: "turn_completed",
                turnId: "turn-9",
              }),
              ...completedStream(9).frames,
            ],
            keepOpen: true,
          }],
        });
        try {
          const client = await ConsoleClient.open(console_.url);
          const started = await client.startTask("Track my books.");
          expect((await client.awaitTurn(started)).kind).toBe("turn_completed");
        } finally {
          await console_.close();
        }
      });
    });
  });

  describe("readServerMeta()", () => {
    it("returns the commit, the CFC block and the experimental flags the server reported", async () => {
      expect(await readServerMeta("http://server", metaFetch(META)))
        .toEqual(META);
    });

    it("returns an error naming the status for a server that refused the read", async () => {
      expect(await readServerMeta("http://server", metaFetch({}, 503)))
        .toEqual({ error: "/api/meta answered 503" });
    });

    it("returns an error for a server that could not be reached", async () => {
      const failing = (() =>
        Promise.reject(
          new Error("connection refused"),
        )) as typeof globalThis.fetch;
      const meta = await readServerMeta("http://server", failing);
      expect("error" in meta && meta.error).toContain("connection refused");
    });
  });

  describe("readAncestry()", () => {
    it("returns `ancestor` for a commit on the branch", async () => {
      expect(await readAncestry("abc", "main", gitRun(true, true)))
        .toEqual({ kind: "ancestor", base: "main" });
    });

    it("returns `diverged` for a commit the branch does not contain", async () => {
      expect(await readAncestry("abc", "main", gitRun(true, false)))
        .toEqual({ kind: "diverged", base: "main" });
    });

    it("returns `unchecked` for a commit this clone does not hold, which is not the same as one off the branch", async () => {
      const reading = await readAncestry("abc", "main", gitRun(false, false));
      expect(reading.kind).toBe("unchecked");
      expect(reading.kind === "unchecked" ? reading.reason : "").toContain(
        "does not hold abc",
      );
    });

    it("returns `unchecked` for a server that reported no commit", async () => {
      expect(await readAncestry(undefined, "main", gitRun(true, true)))
        .toEqual({
          kind: "unchecked",
          reason: "the server reported no gitSha",
        });
    });
  });

  describe("preflightPosture()", () => {
    it("returns the reading, and does not refuse, for a server on a commit off the branch", async () => {
      const posture = await preflightPosture(
        "http://server",
        "main",
        undefined,
        metaFetch(META),
        gitRun(true, false),
      );
      expect(posture.kind).toBe("read");
      expect(posture.kind === "read" ? posture.ancestry : undefined).toEqual({
        kind: "diverged",
        base: "main",
      });
    });

    it("returns a reading for a server whose CFC dials are off, which is the production-server preset rather than a fault", async () => {
      const posture = await preflightPosture(
        "http://server",
        "main",
        undefined,
        metaFetch(META),
        gitRun(true, true),
      );
      expect(posture.kind).toBe("read");
      expect(posture.kind === "read" ? posture.meta.cfc : undefined).toEqual(
        META.cfc,
      );
    });

    it("returns a refusal for a commit the batch was told to expect and did not find", async () => {
      const posture = await preflightPosture(
        "http://server",
        "main",
        "0000000",
        metaFetch(META),
        gitRun(true, true),
      );
      expect(posture.kind).toBe("refused");
      expect(posture.kind === "refused" ? posture.reason : "").toContain(
        "told to expect the fabric server on 0000000",
      );
    });

    it("returns the reading for a commit the batch expected and found", async () => {
      expect(
        (await preflightPosture(
          "http://server",
          "main",
          META.gitSha,
          metaFetch(META),
          gitRun(true, true),
        )).kind,
      ).toBe("read");
    });

    it("returns a refusal for a server that could not be read", async () => {
      const posture = await preflightPosture(
        "http://server",
        "main",
        undefined,
        metaFetch({}, 500),
        gitRun(true, true),
      );
      expect(posture.kind).toBe("refused");
    });
  });

  describe("preflightIndex()", () => {
    it("returns the result and candidate counts for an index that answered", async () => {
      const console_ = startFakeConsole({ streams: [completedStream()] });
      try {
        const client = await ConsoleClient.open(console_.url);
        expect(await client.preflightIndex("pattern")).toEqual({
          kind: "answered",
          results: 0,
          candidates: 30,
        });
      } finally {
        await console_.close();
      }
    });

    it("returns a refusal naming the status for an index that refused the identity", async () => {
      const console_ = startFakeConsole({
        streams: [completedStream()],
        indexAnswer: {
          status: 403,
          body: { error: "DID is not allowlisted" },
        },
      });
      try {
        const client = await ConsoleClient.open(console_.url);
        const preflight = await client.preflightIndex("pattern");
        expect(preflight.kind).toBe("refused");
        expect(
          preflight.kind === "refused" ? preflight.reason : "",
        ).toContain("403");
        expect(
          preflight.kind === "refused" ? preflight.reason : "",
        ).toContain("DID is not allowlisted");
      } finally {
        await console_.close();
      }
    });

    it("returns a refusal for an answer carrying no results array, which is not a count of nothing", async () => {
      const console_ = startFakeConsole({
        streams: [completedStream()],
        indexAnswer: { status: 200, body: { ok: true } },
      });
      try {
        const client = await ConsoleClient.open(console_.url);
        const preflight = await client.preflightIndex("pattern");
        expect(preflight.kind).toBe("refused");
        expect(preflight.kind === "refused" ? preflight.reason : "").toContain(
          "no results array",
        );
      } finally {
        await console_.close();
      }
    });

    it("returns an answer for an index that answered with nothing, which is a state to measure", async () => {
      const console_ = startFakeConsole({
        streams: [completedStream()],
        indexAnswer: { status: 200, body: { results: [] } },
      });
      try {
        const client = await ConsoleClient.open(console_.url);
        expect(await client.preflightIndex("pattern")).toEqual({
          kind: "answered",
          results: 0,
        });
      } finally {
        await console_.close();
      }
    });
  });

  describe("runTask()", () => {
    it("measures the run family the console named for the session", async () => {
      const console_ = startFakeConsole({
        streams: [completedStream()],
        runId: "fixture-run",
        artifactRoot: FIXTURE_ROOT,
      });
      try {
        const client = await ConsoleClient.open(console_.url);
        const result = await runTask(
          client,
          { id: "books", text: "Track the books I am reading." },
          () => {},
        );
        expect(console_.taskTexts).toEqual(["Track the books I am reading."]);
        expect(result.runId).toBe("fixture-run");
        expect(result.measurement?.runs.map((run) => run.runId)).toEqual([
          "fixture-run",
          "fixture-run.subagent.1",
        ]);
        expect(result.measurement?.totals.searches).toBe(5);
        expect(result.measurement?.totals.searchesRefused).toBe(1);
        expect(result.configuration.skillsRoot).toBe("/repo/skills");
        expect(result.configuration.skillsFound).toBe(2);
      } finally {
        await console_.close();
      }
    });

    it("records why a session's run could not be measured rather than reporting no calls", async () => {
      const console_ = startFakeConsole({ streams: [completedStream()] });
      try {
        const client = await ConsoleClient.open(console_.url);
        const result = await runTask(
          client,
          { id: "books", text: "Track the books I am reading." },
          () => {},
        );
        expect(result.measurement).toBeUndefined();
        expect(result.measurementUnread).toBe(
          "the console named no run and artifact root for this session",
        );
        expect(result.configuration.skillsUnread).toBe(
          "the console named no run, so no skill registry could be read",
        );
      } finally {
        await console_.close();
      }
    });
  });

  describe("main()", () => {
    /**
     * Runs the command against a stand-in console, in a temporary directory
     * holding the suite it is given and receiving the report it writes.
     * `/api/meta` is served by the same stand-in, so the whole command runs
     * without a fabric server, a model, or an index.
     */
    const runMain = async (
      options: FakeConsoleOptions,
      suite: unknown,
      extraArgs: readonly string[] = [],
    ): Promise<{ code: number; logs: string[]; dir: string }> => {
      const console_ = startFakeConsole(options);
      const dir = await Deno.makeTempDir();
      try {
        const suitePath = `${dir}/suite.json`;
        await Deno.writeTextFile(suitePath, JSON.stringify(suite));
        const logs: string[] = [];
        const code = await main([
          suitePath,
          `--console=${console_.url}`,
          `--fabric-api-url=${console_.url}`,
          `--out=${dir}/out`,
          ...extraArgs,
        ], (line) => logs.push(line));
        return { code, logs, dir };
      } finally {
        await console_.close();
      }
    };

    const ONE_TASK = {
      label: "one task",
      tasks: [{ id: "books", text: "Track the books I am reading." }],
    };

    it("returns 0 and writes both reports for a batch whose tasks all completed", async () => {
      const { code, dir, logs } = await runMain({
        streams: [completedStream()],
        runId: "fixture-run",
        artifactRoot: FIXTURE_ROOT,
      }, ONE_TASK);
      try {
        expect(code).toBe(0);
        const report = await Deno.readTextFile(`${dir}/out/report.md`);
        expect(report).toContain("# Pattern index measurement — one task");
        expect(report).toContain("Track the books I am reading.");
        expect(report).toContain("## What composed what");
        const json = JSON.parse(
          await Deno.readTextFile(`${dir}/out/report.json`),
        );
        expect(json.results).toHaveLength(1);
        expect(json.results[0].outcome.kind).toBe("turn_completed");
        expect(logs.some((line) => line.startsWith("fabric server at"))).toBe(
          true,
        );
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("returns 3 and runs no task when the index does not answer the pre-flight", async () => {
      const { code, dir, logs } = await runMain({
        streams: [completedStream()],
        indexAnswer: { status: 403, body: { error: "DID is not allowlisted" } },
      }, ONE_TASK);
      try {
        expect(code).toBe(3);
        const report = await Deno.readTextFile(`${dir}/out/report.md`);
        expect(report).toContain(
          "**The index did not answer, and the batch refused to start.**",
        );
        expect(report).toContain("Nothing below ran.");
        expect(
          logs.some((line) => line.includes("the index did not answer")),
        ).toBe(true);
        const json = JSON.parse(
          await Deno.readTextFile(`${dir}/out/report.json`),
        );
        expect(json.results).toHaveLength(0);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("returns 4 and does not ask the index when the server is not the expected commit", async () => {
      const { code, dir } = await runMain(
        { streams: [completedStream()] },
        ONE_TASK,
        ["--expect-git-sha=0000000"],
      );
      try {
        expect(code).toBe(4);
        const report = await Deno.readTextFile(`${dir}/out/report.md`);
        expect(report).toContain(
          "**The fabric server was not the one this batch was told to expect",
        );
        // Pin the reason, not just the header: a `/api/meta` this stand-in
        // refused outright would print the same header and mean something
        // else entirely.
        expect(report).toContain(
          `told to expect the fabric server on 0000000, and it reports ${META.gitSha}`,
        );
        expect(report).toContain(
          "the commit pre-flight refused first, so the index was not asked",
        );
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("returns 1 for a batch whose task did not complete", async () => {
      const { code, dir } = await runMain({
        streams: [{ frames: [], keepOpen: false }],
        runId: "fixture-run",
        artifactRoot: FIXTURE_ROOT,
      }, ONE_TASK);
      try {
        expect(code).toBe(1);
        expect(await Deno.readTextFile(`${dir}/out/report.md`)).toContain(
          "**unwitnessed**",
        );
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("returns 2 and names its usage when given no suite", async () => {
      const logs: string[] = [];
      expect(await main([], (line) => logs.push(line))).toBe(2);
      expect(logs[0]).toContain("usage: measure-batch <suite.json>");
    });

    it("marks a composed pattern as seeded when the suite named it", async () => {
      const { dir } = await runMain({
        streams: [completedStream()],
        runId: "fixture-run",
        artifactRoot: FIXTURE_ROOT,
      }, { ...ONE_TASK, seededPatternIds: ["pub-rating"] });
      try {
        expect(await Deno.readTextFile(`${dir}/out/report.md`)).toContain(
          "`pub-rating` **(seeded)**",
        );
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  });

  describe("renderBatchReport()", () => {
    const reportOf = async (): Promise<string> => {
      const console_ = startFakeConsole({
        streams: [completedStream()],
        runId: "fixture-run",
        artifactRoot: FIXTURE_ROOT,
      });
      try {
        const client = await ConsoleClient.open(console_.url);
        const result = await runTask(
          client,
          { id: "books", text: "Track the books I am reading." },
          () => {},
        );
        return renderBatchReport({
          suite: {
            label: "fixture batch",
            tasks: [result.task],
          },
          consoleUrl: console_.url,
          indexUrl: "https://index.example",
          preflight: { kind: "answered", results: 3, candidates: 30 },
          posture: POSTURE,
          startedAt: "2026-08-28T21:00:00.000Z",
          endedAt: "2026-08-28T23:00:00.000Z",
          indexBefore: {
            kind: "read",
            patterns: [patternOf("kept", 1)] as never,
          },
          indexAfter: {
            kind: "read",
            patterns: [patternOf("kept", 1), patternOf("fresh", 0)] as never,
          },
          results: [result],
        });
      } finally {
        await console_.close();
      }
    };

    it("quotes each task's text exactly as the session was given it", async () => {
      expect(await reportOf()).toContain("Track the books I am reading.");
    });

    it("names which task imported which published pattern", async () => {
      const report = await reportOf();
      expect(report).toContain("## What composed what");
      expect(report).toContain(
        "- **books** — 2 composing, 0 bare re-export, importing `pub-rating`, `pub-reading-shelf`",
      );
      expect(report).toContain("That is 1 of 1 tasks.");
      expect(report).toContain(
        "The suite named no seeded patterns, so nothing here separates",
      );
    });

    it("marks a composed pattern as seeded or pre-existing when the suite named the seeds", async () => {
      const console_ = startFakeConsole({
        streams: [completedStream()],
        runId: "fixture-run",
        artifactRoot: FIXTURE_ROOT,
      });
      try {
        const client = await ConsoleClient.open(console_.url);
        const result = await runTask(
          client,
          { id: "books", text: "Track the books I am reading." },
          () => {},
        );
        const report = renderBatchReport({
          suite: {
            label: "l",
            tasks: [result.task],
            seededPatternIds: ["pub-rating"],
          },
          consoleUrl: console_.url,
          indexUrl: null,
          startedAt: "2026-08-28T21:00:00.000Z",
          endedAt: "2026-08-28T21:00:01.000Z",
          preflight: { kind: "answered", results: 1 },
          posture: POSTURE,
          indexBefore: { kind: "read", patterns: [] as never },
          indexAfter: { kind: "read", patterns: [] as never },
          results: [result],
        });
        expect(report).toContain(
          "`pub-rating` **(seeded)**, `pub-reading-shelf` (pre-existing)",
        );
      } finally {
        await console_.close();
      }
    });

    it("says plainly that no task composed when none did", () => {
      const report = renderBatchReport({
        suite: { label: "l", tasks: [{ id: "a", text: "do a thing" }] },
        consoleUrl: "http://127.0.0.1:1",
        indexUrl: null,
        startedAt: "2026-08-28T21:00:00.000Z",
        endedAt: "2026-08-28T21:00:01.000Z",
        preflight: { kind: "answered", results: 1 },
        posture: POSTURE,
        indexBefore: { kind: "read", patterns: [] as never },
        indexAfter: { kind: "read", patterns: [] as never },
        results: [],
      });
      expect(report).toContain("No task imported a published pattern.");
    });

    it("names what the batch added to the index", async () => {
      expect(await reportOf()).toContain("`fresh` (score 0)");
    });

    it("states that it does not show whether what a run built works", async () => {
      const report = await reportOf();
      expect(report).toContain(
        "It **does not say whether what a run built works.**",
      );
    });

    it("names the discoverability flag as not recorded when the index answer carries none", async () => {
      expect(await reportOf()).toContain(
        "NOT RECORDED — this index answer carries no discoverability flag",
      );
    });

    it("counts how much of the index is offered in search when the index says", () => {
      const report = renderBatchReport({
        suite: { label: "l", tasks: [{ id: "a", text: "do a thing" }] },
        consoleUrl: "http://127.0.0.1:1",
        indexUrl: null,
        startedAt: "2026-08-28T21:00:00.000Z",
        endedAt: "2026-08-28T21:00:01.000Z",
        preflight: { kind: "answered", results: 1 },
        posture: POSTURE,
        indexBefore: {
          kind: "read",
          patterns: [
            { ...patternOf("shown", 1), discoverable: true },
            { ...patternOf("withheld", 0), discoverable: false },
          ] as never,
          nonDiscoverableCount: 4,
        },
        indexAfter: { kind: "read", patterns: [] as never },
        results: [],
      });
      expect(report).toContain(
        "Read from each entry's `discoverable` field: 1 of 2 listed entries are offered in search results, 1 are listed and withheld, and 0 carry no flag either way. The index holds 4 further entries it did not list, recorded and withheld from search.",
      );
    });

    it("names the skills tree the runs scanned and how many skills it held", async () => {
      expect(await reportOf()).toContain(
        "- Skills root: /repo/skills (2 skills)",
      );
    });

    it("says the batch refused to start when the index did not answer the pre-flight", () => {
      const refused: IndexPreflight = {
        kind: "refused",
        reason: "/api/index/call answered 403: DID is not allowlisted",
      };
      const report = renderBatchReport({
        suite: { label: "l", tasks: [{ id: "a", text: "do a thing" }] },
        consoleUrl: "http://127.0.0.1:1",
        indexUrl: null,
        startedAt: "2026-08-28T21:00:00.000Z",
        endedAt: "2026-08-28T21:00:01.000Z",
        preflight: refused,
        posture: POSTURE,
        indexBefore: {
          kind: "unread",
          reason: "the pre-flight search was refused",
        },
        indexAfter: {
          kind: "unread",
          reason: "the pre-flight search was refused",
        },
        results: [],
      });
      expect(report).toContain(
        "**The index did not answer, and the batch refused to start.**",
      );
      expect(report).toContain("403: DID is not allowlisted");
      expect(report).toContain("Nothing below ran.");
    });

    it("says a run answered with nothing was answered rather than refused", async () => {
      expect(await reportOf()).toContain(
        "The index answered a search before the first task: 3 results over 30 candidates examined.",
      );
    });

    it("carries the per-call lines and totals the measurement produced", async () => {
      const report = await reportOf();
      expect(report).toContain("run_pattern by id pub-reading-shelf -> ok");
      expect(report).toContain("composes pub-rating,pub-reading-shelf");
      expect(report).toContain("2 with hits + 1 empty + 1 refused");
    });

    it("says a run was not measured rather than reporting it as a run with no calls", () => {
      const report = renderBatchReport({
        suite: { label: "l", tasks: [{ id: "a", text: "do a thing" }] },
        consoleUrl: "http://127.0.0.1:1",
        indexUrl: null,
        startedAt: "2026-08-28T21:00:00.000Z",
        endedAt: "2026-08-28T21:00:01.000Z",
        preflight: { kind: "answered", results: 1 },
        posture: POSTURE,
        indexBefore: { kind: "unread", reason: "no index configured" },
        indexAfter: { kind: "unread", reason: "no index configured" },
        results: [{
          task: { id: "a", text: "do a thing" },
          sessionId: "s",
          turnId: "t",
          outcome: { kind: "unwitnessed", reason: "the stream went away" },
          configuration: {},
          measurementUnread: "the console named no run",
        }],
      });
      expect(report).toContain("NOT MEASURED — the console named no run");
      expect(report).toContain(
        "- Skills root: NOT RECORDED; 1 of 1 runs scanned none",
      );
      expect(report).toContain(
        "Tasks: 1, of which 1 were not measured.",
      );
      expect(report).toContain("- Model: NOT RECORDED");
      expect(report).toContain("NOT READ — no index configured");
      expect(report).toContain(
        "one end of the comparison was never taken",
      );
    });
  });
});
