// CT-1910: server-inferred pending dependencies — the localSeq-less pending
// read shape, judged by the commit's verdict watermark against the engine's
// per-session retention of rejected commits.
//
// The rule under test (03-commit-model.md §3.6.3): reject commit N iff some
// same-session commit L with verdictsThrough < L < N.localSeq touched a
// document N reads through its pending overlay and was REJECTED. L at or
// below the watermark was dropped by the client's cascade before N's
// composite was built; L above it is a premise the client had not yet
// learned was false. The naive rule without the watermark ("reject if ANY
// prior toucher was rejected") dooms every retry forever — the livelock the
// watermark exists to break, pinned here in both directions.
//
// Staleness for the inferred shape is the declared-`basisSeq` scan,
// unchanged; its own soundness pins live in
// v2-pending-read-basis-overadvance.test.ts.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import {
  applyCommit,
  close,
  ConflictError,
  type Engine,
  open,
  ProtocolError,
  read,
} from "../v2/engine.ts";
import {
  type ClientCommit,
  commitPreconditionValueHash,
  type EntityDocument,
  toDocumentPath,
} from "../v2.ts";

const withEngine = async (
  fn: (engine: Engine) => void | Promise<void>,
): Promise<void> => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path) });
  try {
    await fn(engine);
  } finally {
    close(engine);
    await Deno.remove(path).catch(() => {});
  }
};

const invocationFor = (
  localSeq: number,
  extra: Record<string, unknown> = {},
) => ({
  iss: "did:key:alice",
  aud: "did:key:service",
  cmd: "/memory/transact",
  sub: "did:key:space",
  args: { localSeq, ...extra },
});

const authorization = {
  signature: "sig:alice",
  access: { "proof:1": {} },
};

const toEntityDocument = (value: unknown): EntityDocument =>
  ({ value }) as EntityDocument;

const SESSION = "session:1";

const commitFor = (
  engine: Engine,
  sessionId: string,
  commit: ClientCommit,
) =>
  applyCommit(engine, {
    sessionId,
    invocation: invocationFor(commit.localSeq, { session: sessionId }),
    authorization,
    commit,
  });

const setOp = (id: string, value: unknown) => ({
  op: "set" as const,
  id,
  value: toEntityDocument(value),
});

/** An accepted own write of `id` at the next localSeq. */
const acceptSet = (
  engine: Engine,
  localSeq: number,
  id: string,
  value: unknown,
  sessionId = SESSION,
): void => {
  commitFor(engine, sessionId, {
    localSeq,
    reads: { confirmed: [], pending: [] },
    operations: [setOp(id, value)],
  });
};

/** A REJECTED own commit at `localSeq` writing `id`: its confirmed read of
 * `entity:stale-anchor` claims seq 0 after an accepted write moved that
 * document — a plain conflict rejection with a retained doc footprint. */
const rejectSetViaStaleRead = (
  engine: Engine,
  localSeq: number,
  id: string,
): void => {
  expect(() =>
    commitFor(engine, SESSION, {
      localSeq,
      reads: {
        confirmed: [{
          id: "entity:stale-anchor",
          path: toDocumentPath(["value", "x"]),
          seq: 0,
        }],
        pending: [],
      },
      operations: [setOp(id, { rejected: localSeq })],
    })
  ).toThrow(ConflictError);
};

const inferredRead = (id: string, basisSeq: number) => ({
  id,
  path: toDocumentPath(["value"]),
  basisSeq,
});

describe("v2 engine inferred pending dependencies", () => {
  it("accepts an inferred-shape read with no rejected history, excluding own predecessors from the basis scan", async () => {
    await withEngine((engine) => {
      acceptSet(engine, 1, "entity:A", { x: 1 });
      // basisSeq 0 puts the session's own seq-1 write inside the scan
      // interval; the predecessor exclusion is what admits this.
      commitFor(engine, SESSION, {
        localSeq: 2,
        verdictsThrough: 1,
        reads: { confirmed: [], pending: [inferredRead("entity:A", 0)] },
        operations: [setOp("entity:derived", { observed: 1 })],
      });
      expect(read(engine, { id: "entity:derived" })?.value).toEqual({
        observed: 1,
      });
    });
  });

  it("rejects a composite built over a rejection the watermark shows unprocessed", async () => {
    await withEngine((engine) => {
      acceptSet(engine, 1, "entity:stale-anchor", { x: 1 });
      rejectSetViaStaleRead(engine, 2, "entity:B");
      // W = 1 < L = 2: the client attests it had NOT processed localSeq 2's
      // rejection when it built this composite over entity:B.
      expect(() =>
        commitFor(engine, SESSION, {
          localSeq: 3,
          verdictsThrough: 1,
          reads: { confirmed: [], pending: [inferredRead("entity:B", 0)] },
          operations: [setOp("entity:derived", { observed: "phantom" })],
        })
      ).toThrow("rejected pending dependency inferred");
      expect(read(engine, { id: "entity:derived" })).toBeNull();
    });
  });

  it("accepts the re-derived retry attesting the rejection was processed", async () => {
    await withEngine((engine) => {
      acceptSet(engine, 1, "entity:stale-anchor", { x: 1 });
      rejectSetViaStaleRead(engine, 2, "entity:B");
      expect(() =>
        commitFor(engine, SESSION, {
          localSeq: 3,
          verdictsThrough: 1,
          reads: { confirmed: [], pending: [inferredRead("entity:B", 0)] },
          operations: [setOp("entity:C", { observed: "phantom" })],
        })
      ).toThrow(ConflictError);
      // The retry carries W = 2 ≥ L: the rejected layer was dropped and the
      // composite re-derived, so the same read shape lands. This is the
      // no-livelock pin — the naive "any prior rejection dooms" rule would
      // reject this retry and every one after it.
      commitFor(engine, SESSION, {
        localSeq: 4,
        verdictsThrough: 2,
        reads: { confirmed: [], pending: [inferredRead("entity:B", 0)] },
        operations: [setOp("entity:derived", { observed: "re-derived" })],
      });
      expect(read(engine, { id: "entity:derived" })?.value).toEqual({
        observed: "re-derived",
      });
    });
  });

  it("leaves an inferred reader of an untouched document undoomed", async () => {
    await withEngine((engine) => {
      acceptSet(engine, 1, "entity:stale-anchor", { x: 1 });
      rejectSetViaStaleRead(engine, 2, "entity:B");
      // Same unprocessed-rejection window as above, but the read is of a
      // document the rejected commit never wrote.
      commitFor(engine, SESSION, {
        localSeq: 3,
        verdictsThrough: 1,
        reads: {
          confirmed: [],
          pending: [inferredRead("entity:stale-anchor", 0)],
        },
        operations: [setOp("entity:derived", { observed: 1 })],
      });
      expect(read(engine, { id: "entity:derived" })?.value).toEqual({
        observed: 1,
      });
    });
  });

  it("retains rejection kinds a catch-up marker never covers", async () => {
    await withEngine((engine) => {
      acceptSet(engine, 1, "entity:stale-anchor", { x: 1 });
      // A ProtocolError rejection (malformed watermark), not a conflict:
      // the server stages no catch-up marker for these, which is exactly
      // why the watermark cannot be derived from marker coverage.
      expect(() =>
        commitFor(engine, SESSION, {
          localSeq: 2,
          verdictsThrough: -1,
          reads: { confirmed: [], pending: [] },
          operations: [setOp("entity:B", { rejected: true })],
        })
      ).toThrow(ProtocolError);
      expect(() =>
        commitFor(engine, SESSION, {
          localSeq: 3,
          verdictsThrough: 1,
          reads: { confirmed: [], pending: [inferredRead("entity:B", 0)] },
          operations: [setOp("entity:derived", { observed: "phantom" })],
        })
      ).toThrow("rejected pending dependency inferred");
    });
  });

  it("prunes retention once the session attests a watermark past it", async () => {
    await withEngine((engine) => {
      acceptSet(engine, 1, "entity:stale-anchor", { x: 1 });
      rejectSetViaStaleRead(engine, 2, "entity:B");
      // An ordinary commit whose watermark passes the rejection retires its
      // retention: every future commit's rule ignores L ≤ W by definition.
      commitFor(engine, SESSION, {
        localSeq: 3,
        verdictsThrough: 2,
        reads: { confirmed: [], pending: [] },
        operations: [setOp("entity:C", { x: 1 })],
      });
      // A later commit attesting a STALE watermark (below the pruned entry)
      // is not doomed by it: watermarks are per-session monotonic truth, so
      // the pruned rejection stays retired.
      commitFor(engine, SESSION, {
        localSeq: 4,
        verdictsThrough: 1,
        reads: { confirmed: [], pending: [inferredRead("entity:B", 0)] },
        operations: [setOp("entity:derived", { observed: "pruned" })],
      });
      expect(read(engine, { id: "entity:derived" })?.value).toEqual({
        observed: "pruned",
      });
    });
  });

  it("reconciles retention when a lost-verdict re-send lands on revalidation", async () => {
    await withEngine((engine) => {
      acceptSet(engine, 1, "entity:pin", { v: 1 });
      // localSeq 2 pins a value entity:pin does not hold yet; the rejection
      // retains entity:B.
      const resend: ClientCommit = {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        preconditions: [{
          kind: "entity-value-hash",
          id: "entity:pin",
          valueHash: commitPreconditionValueHash({ v: 2 }),
        }],
        operations: [setOp("entity:B", { attempt: true })],
      };
      expect(() => commitFor(engine, SESSION, resend)).toThrow(ConflictError);
      acceptSet(engine, 3, "entity:pin", { v: 2 });
      // The verdict was lost; the client replays localSeq 2 unchanged. The
      // pinned value now matches, so revalidation ACCEPTS it — and the
      // retention entry must retire with that acceptance.
      commitFor(engine, SESSION, resend);
      // A reader attesting a watermark BELOW the re-sent commit is not
      // doomed: localSeq 2 is decided-accepted, not a dropped layer.
      commitFor(engine, SESSION, {
        localSeq: 4,
        verdictsThrough: 1,
        reads: { confirmed: [], pending: [inferredRead("entity:B", 0)] },
        operations: [setOp("entity:derived", { observed: "landed" })],
      });
      expect(read(engine, { id: "entity:derived" })?.value).toEqual({
        observed: "landed",
      });
    });
  });

  it("still scans staleness from the declared basis on the inferred shape", async () => {
    await withEngine((engine) => {
      acceptSet(engine, 1, "entity:A", { x: 1 });
      acceptSet(engine, 1, "entity:A", { x: 2 }, "session:other");
      // The foreign x = 2 landed inside (0, head]; own-predecessor
      // exclusion does not cover it.
      expect(() =>
        commitFor(engine, SESSION, {
          localSeq: 2,
          verdictsThrough: 1,
          reads: { confirmed: [], pending: [inferredRead("entity:A", 0)] },
          operations: [setOp("entity:derived", { observed: 1 })],
        })
      ).toThrow("stale pending read");
    });
  });

  it("rejects the inferred shape without a basis, a watermark, or in-order submission", async () => {
    await withEngine((engine) => {
      acceptSet(engine, 1, "entity:A", { x: 1 });
      expect(() =>
        commitFor(engine, SESSION, {
          localSeq: 2,
          verdictsThrough: 1,
          reads: {
            confirmed: [],
            pending: [{ id: "entity:A", path: toDocumentPath(["value"]) }],
          },
          operations: [setOp("entity:derived", { observed: 1 })],
        })
      ).toThrow("omits both localSeq and basisSeq");
      expect(() =>
        commitFor(engine, SESSION, {
          localSeq: 2,
          reads: { confirmed: [], pending: [inferredRead("entity:A", 0)] },
          operations: [setOp("entity:derived", { observed: 1 })],
        })
      ).toThrow("no verdictsThrough");
      expect(() =>
        commitFor(engine, SESSION, {
          localSeq: 2,
          verdictsThrough: 2,
          reads: { confirmed: [], pending: [inferredRead("entity:A", 0)] },
          operations: [setOp("entity:derived", { observed: 1 })],
        })
      ).toThrow("at or past itself");
      // localSeq 3 decided while 2 was never seen: an inferred-shape commit
      // arriving at 2 afterwards violates the in-order submission premise
      // inference rests on.
      acceptSet(engine, 3, "entity:C", { x: 1 });
      expect(() =>
        commitFor(engine, SESSION, {
          localSeq: 2,
          verdictsThrough: 1,
          reads: { confirmed: [], pending: [inferredRead("entity:A", 0)] },
          operations: [setOp("entity:derived", { observed: 1 })],
        })
      ).toThrow("out of submission order");
    });
  });

  it("dooms conservatively when retention overflowed past the attested watermark", async () => {
    await withEngine((engine) => {
      acceptSet(engine, 1, "entity:stale-anchor", { x: 1 });
      // 1025 rejections overflow the 1024-entry retention cap, folding the
      // oldest into the floor. A watermark below the floor cannot prove the
      // discarded interval clean, so the read dooms even though its
      // document was never touched by the DISCARDED entry's survivors.
      for (let localSeq = 2; localSeq <= 1026; localSeq++) {
        rejectSetViaStaleRead(engine, localSeq, `entity:reject-${localSeq}`);
      }
      expect(() =>
        commitFor(engine, SESSION, {
          localSeq: 1027,
          verdictsThrough: 1,
          reads: {
            confirmed: [],
            pending: [inferredRead("entity:untouched", 0)],
          },
          operations: [setOp("entity:derived", { observed: 1 })],
        })
      ).toThrow("retention overflowed");
      // A watermark at or past the floor restores precision. (The doomed
      // first attempt above was itself retained, pushing the floor one
      // further, and its own localSeq re-enters revalidation as a
      // lost-verdict re-send.)
      commitFor(engine, SESSION, {
        localSeq: 1027,
        verdictsThrough: 10,
        reads: {
          confirmed: [],
          pending: [inferredRead("entity:untouched", 0)],
        },
        operations: [setOp("entity:derived", { observed: 1 })],
      });
      expect(read(engine, { id: "entity:derived" })?.value).toEqual({
        observed: 1,
      });
    });
  });
});
