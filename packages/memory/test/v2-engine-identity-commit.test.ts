import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";

import {
  applyCommit,
  close,
  ConflictError,
  type Engine,
  open,
} from "../v2/engine.ts";

const setOp = (id: string, value: unknown) =>
  ({ op: "set", id, value: { value } }) as never;

const patchOp = (id: string, patches: unknown[]) =>
  ({ op: "patch", id, patches }) as never;

const commit = (localSeq: number, extra: Record<string, unknown>) =>
  ({
    localSeq,
    reads: { confirmed: [], pending: [] },
    operations: [],
    ...extra,
  }) as never;

const headSeqOf = (engine: Engine, id: string): number | undefined =>
  engine.database.prepare(`SELECT seq FROM head WHERE id = ?`).get<
    { seq: number }
  >(id)?.seq;

describe("applyCommit() with an identity commit", () => {
  let path: string;
  let engine: Engine;

  beforeEach(async () => {
    path = await Deno.makeTempFile({ suffix: ".sqlite" });
    engine = await open({ url: toFileUrl(path) });
  });
  afterEach(async () => {
    close(engine);
    await Deno.remove(path);
  });

  // Session a installs the document, session b rewrites it, and session a
  // still holds the install as its basis. Returns the install's seq.
  function installThenRewrite(): number {
    const install = applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, { operations: [setOp("of:doc", { n: 1 })] }),
    });
    applyCommit(engine, {
      sessionId: "s:b",
      commit: commit(1, { operations: [setOp("of:doc", { n: 2 })] }),
    });
    return install.seq;
  }

  it("accepts a set of the stored content over a stale confirmed read, eliding the operation", () => {
    const installSeq = installThenRewrite();
    const headBefore = headSeqOf(engine, "of:doc");

    const verdict = applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(2, {
        reads: {
          confirmed: [{ id: "of:doc", path: [], seq: installSeq }],
          pending: [],
        },
        operations: [setOp("of:doc", { n: 2 })],
      }),
    });

    expect(verdict.elidedOpIndexes).toEqual([0]);
    expect(verdict.revisions).toEqual([]);
    expect(verdict.seq).toBeGreaterThan(headBefore!);
    expect(headSeqOf(engine, "of:doc")).toBe(headBefore);
  });

  it("refuses a set of different content over the same stale read", () => {
    const installSeq = installThenRewrite();

    expect(() =>
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(2, {
          reads: {
            confirmed: [{ id: "of:doc", path: [], seq: installSeq }],
            pending: [],
          },
          operations: [setOp("of:doc", { n: 3 })],
        }),
      })
    ).toThrow(ConflictError);
  });

  it("refuses a commit whose other operation writes, even with one identical set", () => {
    const installSeq = installThenRewrite();

    expect(() =>
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(2, {
          reads: {
            confirmed: [{ id: "of:doc", path: [], seq: installSeq }],
            pending: [],
          },
          operations: [
            setOp("of:doc", { n: 2 }),
            setOp("of:other", { m: 1 }),
          ],
        }),
      })
    ).toThrow(ConflictError);
  });

  it("refuses an identical set that depends on an unresolved pending layer", () => {
    installThenRewrite();

    expect(() =>
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(2, {
          reads: {
            confirmed: [],
            pending: [{ id: "of:doc", path: [], localSeq: [7], basisSeq: 0 }],
          },
          operations: [setOp("of:doc", { n: 2 })],
        }),
      })
    ).toThrow("pending dependency not resolved");
  });

  it("accepts an identical set whose pending read sits on a superseded own layer", () => {
    const installSeq = installThenRewrite();

    // Session a read the document through its own install layer, which
    // session b's rewrite has since superseded; the write it derived from
    // that view matches what is stored now, so it lands as a no-op.
    const verdict = applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(2, {
        reads: {
          confirmed: [],
          pending: [{
            id: "of:doc",
            path: [],
            localSeq: [1],
            basisSeq: installSeq - 1,
          }],
        },
        operations: [setOp("of:doc", { n: 2 })],
      }),
    });

    expect(verdict.elidedOpIndexes).toEqual([0]);
    expect(verdict.revisions).toEqual([]);
  });

  it("accepts a patch that replays from the read's basis to the stored document", () => {
    const installSeq = installThenRewrite();
    const headBefore = headSeqOf(engine, "of:doc");

    // Session a derived `n: 2` from what it read and patches it in; session
    // b already landed the same value.
    const verdict = applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(2, {
        reads: {
          confirmed: [{ id: "of:doc", path: [], seq: installSeq }],
          pending: [],
        },
        operations: [patchOp("of:doc", [
          { op: "replace", path: "/value/n", value: 2 },
        ])],
      }),
    });

    expect(verdict.elidedOpIndexes).toEqual([0]);
    expect(verdict.revisions).toEqual([]);
    expect(headSeqOf(engine, "of:doc")).toBe(headBefore);
  });

  it("refuses a patch whose replay from the basis differs from the stored document", () => {
    const installSeq = installThenRewrite();

    expect(() =>
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(2, {
          reads: {
            confirmed: [{ id: "of:doc", path: [], seq: installSeq }],
            pending: [],
          },
          operations: [patchOp("of:doc", [
            { op: "replace", path: "/value/n", value: 3 },
          ])],
        }),
      })
    ).toThrow(ConflictError);
  });

  it("refuses a patch that reaches the stored document but is not idempotent on it", () => {
    // Session a installs a one-element list and reads it; session b appends
    // `x`; session a's splice from its basis produces the stored list, but
    // replayed on the stored list it would append `x` a second time.
    const install = applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, { operations: [setOp("of:list", ["a"])] }),
    });
    applyCommit(engine, {
      sessionId: "s:b",
      commit: commit(1, {
        operations: [patchOp("of:list", [
          { op: "splice", path: "/value", index: 1, remove: 0, add: ["x"] },
        ])],
      }),
    });

    expect(() =>
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(2, {
          reads: {
            confirmed: [{ id: "of:list", path: [], seq: install.seq }],
            pending: [],
          },
          operations: [patchOp("of:list", [
            { op: "splice", path: "/value", index: 1, remove: 0, add: ["x"] },
          ])],
        }),
      })
    ).toThrow(ConflictError);
  });

  it("judges a patch on a document the commit did not read by its effect on the stored one", () => {
    const installSeq = installThenRewrite();
    applyCommit(engine, {
      sessionId: "s:b",
      commit: commit(2, { operations: [setOp("of:other", { m: 1 })] }),
    });

    // The stale read is on `of:doc`; the patch on `of:other`, which the
    // commit never read, replays on the stored document alone, and is
    // idempotent there.
    const verdict = applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(2, {
        reads: {
          confirmed: [{ id: "of:doc", path: [], seq: installSeq }],
          pending: [],
        },
        operations: [
          setOp("of:doc", { n: 2 }),
          patchOp("of:other", [{ op: "replace", path: "/value/m", value: 1 }]),
        ],
      }),
    });
    expect(verdict.elidedOpIndexes).toEqual([0, 1]);

    expect(() =>
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(3, {
          reads: {
            confirmed: [{ id: "of:doc", path: [], seq: installSeq }],
            pending: [],
          },
          operations: [
            setOp("of:doc", { n: 2 }),
            patchOp("of:other", [{
              op: "replace",
              path: "/value/m",
              value: 5,
            }]),
          ],
        }),
      })
    ).toThrow(ConflictError);
  });

  it("accepts a patch built against an absent document that the space now holds identically", () => {
    // Two sessions each install the same derived value into a document
    // neither had seen; the first lands, the second read the document as
    // absent at seq 0 and patches the same content in.
    applyCommit(engine, {
      sessionId: "s:b",
      commit: commit(1, {
        operations: [patchOp("of:fresh", [
          { op: "add", path: "/value", value: { n: 7 } },
        ])],
      }),
    });

    const verdict = applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, {
        reads: {
          confirmed: [{ id: "of:fresh", path: [], seq: 0 }],
          pending: [],
        },
        operations: [patchOp("of:fresh", [
          { op: "add", path: "/value", value: { n: 7 } },
        ])],
      }),
    });

    expect(verdict.elidedOpIndexes).toEqual([0]);
    expect(verdict.revisions).toEqual([]);
  });

  it("replays a document's operations in order, so a create-then-patch of stored content is an identity", () => {
    // Session b creates the document with its final content in one set.
    // Session a, which read it as absent, creates it with a set and then
    // patches the value in; only the sequence lands on what is stored.
    applyCommit(engine, {
      sessionId: "s:b",
      commit: commit(1, {
        operations: [{
          op: "set",
          id: "of:built",
          value: { result: "r", value: { n: 3 } },
        } as never],
      }),
    });

    const verdict = applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, {
        reads: {
          confirmed: [{ id: "of:built", path: [], seq: 0 }],
          pending: [],
        },
        operations: [
          { op: "set", id: "of:built", value: { result: "r" } } as never,
          patchOp("of:built", [{ op: "add", path: "/value", value: { n: 3 } }]),
        ],
      }),
    });

    expect(verdict.elidedOpIndexes).toEqual([0, 1]);
    expect(verdict.revisions).toEqual([]);
  });

  it("writes a patch that no staleness check refuses as an ordinary revision", () => {
    installThenRewrite();

    // Without a stale read there is nothing to escape from, so an
    // idempotent patch still records its revision like any other write.
    const verdict = applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(2, {
        operations: [patchOp("of:doc", [
          { op: "replace", path: "/value/n", value: 2 },
        ])],
      }),
    });
    expect(verdict.elidedOpIndexes).toBeUndefined();
    expect(verdict.revisions.map((revision) => revision.id)).toEqual([
      "of:doc",
    ]);
  });

  it("writes a first set of an absent document as an ordinary revision", () => {
    const verdict = applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, { operations: [setOp("of:fresh", { n: 1 })] }),
    });

    expect(verdict.elidedOpIndexes).toBeUndefined();
    expect(verdict.revisions.map((revision) => revision.id)).toEqual([
      "of:fresh",
    ]);
  });
});
