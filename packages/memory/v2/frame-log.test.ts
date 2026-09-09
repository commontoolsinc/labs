import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createFrameLog } from "./frame-log.ts";

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
