import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";

import {
  ConsoleClient,
  indexChangeOf,
  type IndexSnapshot,
  parseMeasurementSuite,
  readSseFrames,
  renderBatchReport,
  runTask,
} from "../scripts/run-measurement-batch.ts";

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
      return Response.json({ patterns: options.patterns ?? [] });
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
      } finally {
        await console_.close();
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
        indexBefore: {
          kind: "read",
          patterns: [
            {
              ...patternOf("shown", 1),
              discoverable: true,
              discoverabilityField: "discoverable",
            },
            {
              ...patternOf("withheld", 0),
              discoverable: false,
              discoverabilityField: "discoverable",
            },
          ] as never,
        },
        indexAfter: { kind: "read", patterns: [] as never },
        results: [],
      });
      expect(report).toContain(
        "Read from each entry's `discoverable` field: 1 of 2 entries are offered in search results, 1 are recorded and withheld, and 0 carry no flag either way.",
      );
    });

    it("names the skills root as not recorded rather than leaving it out", async () => {
      expect(await reportOf()).toContain(
        "- Skills root: NOT RECORDED — the console exposes it over no route",
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
