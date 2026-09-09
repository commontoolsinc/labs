import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createFrameLog, frameLogFromEnvironment } from "./frame-log.ts";

describe("frame log", () => {
  const collect = () => {
    const lines: Record<string, unknown>[] = [];
    const log = createFrameLog((line) => lines.push(JSON.parse(line)));
    return { lines, log };
  };

  it("records a watch mutation's roots with each distinct selector written once", () => {
    const { lines, log } = collect();
    const selector = { path: [], schema: { type: "string" } };
    log.logOutgoing({
      type: "session.watch.add",
      requestId: "req:1",
      watches: [
        {
          id: "w1",
          kind: "graph",
          query: { roots: [{ id: "of:a", scope: "space", selector }] },
        },
        {
          id: "w2",
          kind: "graph",
          query: { roots: [{ id: "of:b", scope: "space", selector }] },
        },
      ],
    }, 120);
    const selectors = lines.filter((line) => line.dir === "selector");
    expect(selectors.length).toBe(1);
    const frame = lines.find((line) => line.dir === "out")!;
    expect(frame.type).toBe("session.watch.add");
    expect(frame.bytes).toBe(120);
    const watches = frame.watches as { roots: { selector: string }[] }[];
    expect(watches[0].roots[0].selector).toBe(selectors[0].hash);
    expect(watches[1].roots[0].selector).toBe(selectors[0].hash);
  });

  it("summarizes a commit's read set, counting reads that assert absence", () => {
    const { lines, log } = collect();
    log.logOutgoing({
      type: "transact",
      requestId: "req:2",
      commit: {
        localSeq: 3,
        operations: [{ id: "of:a", scope: "space", op: "set", value: {} }],
        reads: {
          confirmed: [
            { id: "of:a", path: ["value"], seq: 5 },
            { id: "of:b", path: ["value", "x"], seq: 0 },
            { id: "computed:c", path: ["value"], seq: 0 },
          ],
          pending: [],
        },
      },
    }, 400);
    const commit = lines[0].commit as Record<string, unknown>;
    expect(commit.confirmedReads).toBe(3);
    expect(commit.confirmedReadsAtSeqZero).toBe(2);
    expect(commit.confirmedReadIdsAtSeqZero).toEqual(["of:b", "computed:c"]);
    const reads = commit.reads as Record<string, unknown>;
    expect(reads.distinctDocs).toBe(3);
    expect(reads.byKind).toEqual({ of: 2, computed: 1 });
    expect(reads.byDepth).toEqual({ "1": 2, "2": 1 });
  });

  it("lists the documents a response delivered with their size and keys", () => {
    const { lines, log } = collect();
    log.logIncoming({
      type: "response",
      requestId: "req:1",
      ok: {
        serverSeq: 9,
        sync: {
          type: "sync",
          fromSeq: 0,
          toSeq: 9,
          upserts: [
            { id: "of:a", seq: 4, doc: { value: { title: "t", body: "b" } } },
            { id: "of:s", seq: 4, doc: { value: "plain" } },
          ],
          removes: [],
        },
      },
    }, 900);
    const frame = lines[0];
    expect(frame.dir).toBe("in");
    expect(frame.serverSeq).toBe(9);
    const sync = frame.sync as { upserts: Record<string, unknown>[] };
    expect(sync.upserts[0].keys).toEqual(["title", "body"]);
    expect(sync.upserts[1].keys).toBe("string");
    expect(sync.upserts[0].bytes).toBeGreaterThan(0);
  });

  it("records a pushed effect under its effect type", () => {
    const { lines, log } = collect();
    log.logIncoming({
      type: "session/effect",
      space: "did:key:x",
      sessionId: "s",
      effect: { type: "sync", fromSeq: 1, toSeq: 2, upserts: [], removes: [] },
    }, 50);
    expect(lines[0].effectType).toBe("sync");
    expect((lines[0].sync as { upserts: unknown[] }).upserts).toEqual([]);
  });
});

describe("frame log against what the wire actually carries", () => {
  const collect = () => {
    const lines: Record<string, unknown>[] = [];
    const log = createFrameLog((line) => lines.push(JSON.parse(line)));
    return { lines, log };
  };

  it("records each commit operation's kind under op", () => {
    const { lines, log } = collect();
    log.logOutgoing({
      type: "transact",
      requestId: "req:3",
      commit: {
        localSeq: 1,
        operations: [
          { op: "set", id: "of:a", scope: "space", value: { value: 1 } },
          { op: "delete", id: "of:b", scope: "space" },
        ],
        reads: { confirmed: [], pending: [] },
      },
    }, 10);
    const ops = (lines[0].commit as { operations: { op: string }[] })
      .operations;
    expect(ops.map((entry) => entry.op)).toEqual(["set", "delete"]);
  });

  it("never lets a value JSON cannot write stop the frame", () => {
    const { lines, log } = collect();
    log.logOutgoing({
      type: "transact",
      requestId: "req:4",
      commit: {
        localSeq: 1,
        operations: [{ op: "set", id: "of:a", value: { value: 1n } }],
        reads: { confirmed: [], pending: [] },
      },
    }, 10);
    const ops = (lines[0].commit as { operations: { bytes?: number }[] })
      .operations;
    expect(ops[0].bytes).toBeUndefined();
    log.logIncoming({
      type: "response",
      requestId: "req:4",
      ok: {
        sync: {
          type: "sync",
          fromSeq: 0,
          toSeq: 1,
          upserts: [{ id: "of:a", seq: 1, doc: { value: { n: 2n } } }],
          removes: [],
        },
      },
    }, 10);
    const upserts = (lines[1].sync as { upserts: { bytes?: number }[] })
      .upserts;
    expect(upserts[0].bytes).toBeUndefined();
    expect(lines.length).toBe(2);
  });

  it("sizes a document in UTF-8 bytes, not UTF-16 units", () => {
    const { lines, log } = collect();
    log.logIncoming({
      type: "response",
      requestId: "req:5",
      ok: {
        sync: {
          type: "sync",
          fromSeq: 0,
          toSeq: 1,
          upserts: [{ id: "of:a", seq: 1, doc: { value: "é" } }],
          removes: [],
        },
      },
    }, 10);
    const upserts = (lines[0].sync as { upserts: { bytes: number }[] })
      .upserts;
    // `{"value":"é"}` is 13 UTF-16 units and 14 UTF-8 bytes.
    expect(upserts[0].bytes).toBe(14);
  });

  it("summarizes the entities a graph.query response returns", () => {
    const { lines, log } = collect();
    log.logIncoming({
      type: "response",
      requestId: "req:6",
      ok: {
        serverSeq: 3,
        entities: [
          { branch: "", id: "of:a", seq: 3, document: { value: { x: 1 } } },
          { branch: "", id: "of:gone", seq: 0, document: null },
        ],
      },
    }, 10);
    const entities = lines[0].entities as Record<string, unknown>[];
    expect(entities[0].keys).toEqual(["x"]);
    expect(entities[0].bytes).toBeGreaterThan(0);
    expect(entities[1].absent).toBe(true);
  });

  it("carries a response's error", () => {
    const { lines, log } = collect();
    log.logIncoming({
      type: "response",
      requestId: "req:7",
      error: { name: "ConflictError", message: "stale" },
    }, 10);
    expect((lines[0].error as { name: string }).name).toBe("ConflictError");
  });

  it("reports a summary it could not build without dropping the frame", () => {
    const { lines, log } = collect();
    const hostile = {
      type: "transact",
      requestId: "req:8",
      get commit(): never {
        throw new Error("no commit for you");
      },
    };
    log.logOutgoing(hostile, 10);
    expect(lines[0].dir).toBe("error");
    expect(lines[0].message).toBe("no commit for you");
  });
});

describe("frame log from the environment", () => {
  it("is absent when the variable is unset or empty", () => {
    expect(frameLogFromEnvironment(() => undefined, () => {})).toBeUndefined();
    expect(frameLogFromEnvironment(() => "", () => {})).toBeUndefined();
  });

  it("is absent when the environment cannot be read", () => {
    expect(
      frameLogFromEnvironment(() => {
        throw new Error("no env permission");
      }, () => {}),
    ).toBeUndefined();
  });

  it("appends lines to the named file", () => {
    const written: { path: string; line: string }[] = [];
    const log = frameLogFromEnvironment(
      (name: string) =>
        name === "CF_MEMORY_FRAME_LOG" ? "/tmp/frames.jsonl" : undefined,
      (path: string, line: string) => written.push({ path, line }),
    );
    log!.logOutgoing({ type: "session.ack", requestId: "req:9" }, 5);
    expect(written.length).toBe(1);
    expect(written[0].path).toBe("/tmp/frames.jsonl");
    expect(JSON.parse(written[0].line).type).toBe("session.ack");
  });
});
