/**
 * Engine tests for the computed-cell ack-and-drop conflict policy
 * (docs/specs/computed-cell-identity.md): a commit whose semantic operations
 * ALL target computed-kind entities (`fid2:computed:` ids) is acknowledged as
 * committed but its operations dropped when its reads are stale, instead of
 * being rejected. The dropped commit still consumes its localSeq and — via
 * its zero-revision commit row — satisfies replay dedupe, dependent pending
 * reads, and origin-committed preconditions. Mixed and untagged commits keep
 * strict conflict semantics.
 */

import { assertEquals, assertExists, assertThrows } from "@std/assert";
import { toFileUrl } from "@std/path";
import {
  applyCommit,
  close,
  ConflictError,
  type Engine,
  open,
} from "../v2/engine.ts";
import { type EntityDocument, toDocumentPath } from "../v2.ts";
import type { FabricValue } from "@commonfabric/api";

const toEntityDocument = (value: FabricValue): EntityDocument => ({ value });

const createEngine = async (): Promise<{ engine: Engine; path: string }> => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path) });
  return { engine, path };
};

const INPUT_ID = "of:fid1:input";
const COMPUTED_ID = "of:fid2:computed:out";
const OTHER_COMPUTED_ID = "of:fid2:computed:other";
const STATE_ID = "of:fid1:state";

const revisionCount = (engine: Engine, id: string): number =>
  (engine.database.prepare(
    `SELECT count(*) AS count FROM revision WHERE id = :id`,
  ).get({ id }) as { count: number }).count;

// seq 1: session:a writes the input. seq 2: session:b overwrites it — any
// read of the input at seq 1 is now stale.
const seedStaleInput = (engine: Engine): void => {
  applyCommit(engine, {
    sessionId: "session:a",
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: INPUT_ID,
        value: toEntityDocument({ count: 1 }),
      }],
    },
  });
  applyCommit(engine, {
    sessionId: "session:b",
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: INPUT_ID,
        value: toEntityDocument({ count: 2 }),
      }],
    },
  });
};

const staleComputedCommit = (localSeq: number) => ({
  sessionId: "session:a",
  commit: {
    localSeq,
    reads: {
      confirmed: [{
        id: INPUT_ID,
        path: toDocumentPath(["value", "count"]),
        seq: 1,
      }],
      pending: [],
    },
    operations: [{
      op: "set" as const,
      id: COMPUTED_ID,
      value: toEntityDocument({ doubled: 2 }),
    }],
  },
});

Deno.test("stale all-computed commit is acknowledged and dropped", async () => {
  const { engine, path } = await createEngine();
  try {
    seedStaleInput(engine);
    const applied = applyCommit(engine, staleComputedCommit(2));

    assertEquals(applied.droppedComputed, "stale-confirmed-read");
    assertEquals(applied.revisions, []);
    // A real commit row exists (localSeq consumed) but no revision was
    // written and the entity remains untouched.
    assertEquals(applied.seq, 3);
    assertEquals(revisionCount(engine, COMPUTED_ID), 0);

    // The engine stays writable past the dropped commit.
    const next = applyCommit(engine, {
      sessionId: "session:b",
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: STATE_ID,
          value: toEntityDocument({ ok: true }),
        }],
      },
    });
    assertEquals(next.seq, 4);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("replaying a dropped commit is idempotent and keeps the marker", async () => {
  const { engine, path } = await createEngine();
  try {
    seedStaleInput(engine);
    const first = applyCommit(engine, staleComputedCommit(2));
    const replayed = applyCommit(engine, staleComputedCommit(2));

    assertEquals(replayed.seq, first.seq);
    assertEquals(replayed.revisions, []);
    assertEquals(replayed.droppedComputed, "stale-confirmed-read");
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("dropped commit satisfies a dependent origin-committed precondition", async () => {
  const { engine, path } = await createEngine();
  try {
    seedStaleInput(engine);
    applyCommit(engine, staleComputedCommit(2));

    const dependent = applyCommit(engine, {
      sessionId: "session:a",
      commit: {
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        preconditions: [{ kind: "origin-committed", originLocalSeq: 2 }],
        operations: [{
          op: "set",
          id: STATE_ID,
          value: toEntityDocument({ ok: true }),
        }],
      },
    });
    assertEquals(dependent.droppedComputed, undefined);
    assertEquals(dependent.revisions.length, 1);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("dropped commit resolves a dependent pending read", async () => {
  const { engine, path } = await createEngine();
  try {
    seedStaleInput(engine);
    applyCommit(engine, staleComputedCommit(2));

    // Reads the dropped commit's output pending its resolution. The dropped
    // commit row resolves the localSeq; the computed entity has no revisions
    // after that seq, so the read is current and the commit applies.
    const dependent = applyCommit(engine, {
      sessionId: "session:a",
      commit: {
        localSeq: 3,
        reads: {
          confirmed: [],
          pending: [{
            id: COMPUTED_ID,
            path: toDocumentPath(["value"]),
            localSeq: 2,
          }],
        },
        operations: [{
          op: "set",
          id: OTHER_COMPUTED_ID,
          value: toEntityDocument({ derived: true }),
        }],
      },
    });
    assertEquals(dependent.droppedComputed, undefined);
    assertEquals(dependent.revisions.length, 1);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("all-computed commit with current reads applies normally", async () => {
  const { engine, path } = await createEngine();
  try {
    seedStaleInput(engine);
    const applied = applyCommit(engine, {
      sessionId: "session:a",
      commit: {
        localSeq: 2,
        reads: {
          confirmed: [{
            id: INPUT_ID,
            path: toDocumentPath(["value", "count"]),
            seq: 2,
          }],
          pending: [],
        },
        operations: [{
          op: "set",
          id: COMPUTED_ID,
          value: toEntityDocument({ doubled: 4 }),
        }],
      },
    });
    assertEquals(applied.droppedComputed, undefined);
    assertEquals(applied.revisions.length, 1);
    assertEquals(revisionCount(engine, COMPUTED_ID), 1);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("mixed commit keeps strict conflict semantics", async () => {
  const { engine, path } = await createEngine();
  try {
    seedStaleInput(engine);
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:a",
          commit: {
            localSeq: 2,
            reads: {
              confirmed: [{
                id: INPUT_ID,
                path: toDocumentPath(["value", "count"]),
                seq: 1,
              }],
              pending: [],
            },
            operations: [
              {
                op: "set",
                id: COMPUTED_ID,
                value: toEntityDocument({ doubled: 2 }),
              },
              {
                op: "set",
                id: STATE_ID,
                value: toEntityDocument({ ok: true }),
              },
            ],
          },
        }),
      ConflictError,
      "stale confirmed read",
    );
    assertEquals(revisionCount(engine, COMPUTED_ID), 0);
    assertEquals(revisionCount(engine, STATE_ID), 0);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("untagged commit keeps strict conflict semantics", async () => {
  const { engine, path } = await createEngine();
  try {
    seedStaleInput(engine);
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:a",
          commit: {
            localSeq: 2,
            reads: {
              confirmed: [{
                id: INPUT_ID,
                path: toDocumentPath(["value", "count"]),
                seq: 1,
              }],
              pending: [],
            },
            operations: [{
              op: "set",
              id: STATE_ID,
              value: toEntityDocument({ ok: true }),
            }],
          },
        }),
      ConflictError,
      "stale confirmed read",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("all-computed commit with a missing pending dependency is dropped", async () => {
  const { engine, path } = await createEngine();
  try {
    seedStaleInput(engine);
    const applied = applyCommit(engine, {
      sessionId: "session:a",
      commit: {
        localSeq: 2,
        reads: {
          confirmed: [],
          // localSeq 99 was never committed (e.g. a rejected mixed commit).
          pending: [{
            id: INPUT_ID,
            path: toDocumentPath(["value"]),
            localSeq: 99,
          }],
        },
        operations: [{
          op: "set",
          id: COMPUTED_ID,
          value: toEntityDocument({ doubled: 2 }),
        }],
      },
    });
    assertEquals(applied.droppedComputed, "pending-read-missing");
    assertEquals(applied.revisions, []);
    assertEquals(revisionCount(engine, COMPUTED_ID), 0);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("unknown kinds stay strict", async () => {
  const { engine, path } = await createEngine();
  try {
    seedStaleInput(engine);
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:a",
          commit: {
            localSeq: 2,
            reads: {
              confirmed: [{
                id: INPUT_ID,
                path: toDocumentPath(["value", "count"]),
                seq: 1,
              }],
              pending: [],
            },
            operations: [{
              op: "set",
              // A future kind this engine does not know must not relax.
              id: "of:fid2:future:mystery",
              value: toEntityDocument({ q: 1 }),
            }],
          },
        }),
      ConflictError,
      "stale confirmed read",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("head advances past a dropped commit", async () => {
  const { engine, path } = await createEngine();
  try {
    seedStaleInput(engine);
    const dropped = applyCommit(engine, staleComputedCommit(2));
    assertExists(dropped.droppedComputed);
    const head = (engine.database.prepare(
      `SELECT head_seq FROM branch WHERE name = ''`,
    ).get() as { head_seq: number } | undefined)?.head_seq;
    assertEquals(head, dropped.seq);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});
