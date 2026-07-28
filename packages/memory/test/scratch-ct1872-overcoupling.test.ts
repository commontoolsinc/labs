// SCRATCH — not for commit. Demonstrates the CONSERVATIVE over-coupling of
// full-stack dependency recording (PR #4606): T1 rejected, T1.5 applied, and
// a T2 that semantically depended only on T1.5 is nevertheless rejected,
// because the client claims an existence dependency on EVERY lower pending
// layer of the doc (no overlap filtering).
//
// Doc D confirmed base: { items: ["seed"], title: "t0" }        (seq 1)
// Foreign write:        title = "t-foreign"                     (seq 2)
// T1  (localSeq 10): patch add /value/config  — REJECTED (stale read on title)
// T1.5(localSeq 11): blind patch append to /value/items — APPLIED (seq 3)
// T2  (localSeq 12): read ["value","items"] through the stack, write E.
//
// Case "today": T2 carries {full read @11} + {resolutionOnly @10}
//   → rejected: "pending dependency not resolved: 10" (false doom — one
//     scheduler re-run in production).
// Case "overlap-filtered": T1's footprint (/value/config) does not overlap
//   T2's read path (/value/items) as ancestor/descendant/set, so the
//   refinement would omit the @10 existence dep
//   → accepted, and T2's observation matches durable state exactly.
import { assertEquals, assertThrows } from "@std/assert";
import { toFileUrl } from "@std/path";
import { applyCommit, close, ConflictError, open, read } from "../v2/engine.ts";
import {
  type ClientCommit,
  type EntityDocument,
  toDocumentPath,
} from "../v2.ts";

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

const doc = (value: unknown): EntityDocument => ({ value } as EntityDocument);

const setup = async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path) });

  // Confirmed base (seq 1): D = { items: ["seed"], title: "t0" }.
  applyCommit(engine, {
    sessionId: "session:seed",
    invocation: invocationFor(1, { actor: "seed" }),
    authorization,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "entity:D",
        value: doc({ items: ["seed"], title: "t0" }),
      }],
    },
  });

  // Foreign write (seq 2): bumps title so T1's confirmed read goes stale.
  applyCommit(engine, {
    sessionId: "session:other",
    invocation: invocationFor(1, { actor: "other" }),
    authorization,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "patch",
        id: "entity:D",
        patches: [{ op: "replace", path: "/value/title", value: "t-foreign" }],
      }],
    },
  });

  // T1 (localSeq 10): reads title at stale seq 1, writes /value/config.
  // REJECTED — stale confirmed read. (Stand-in for the multi-doc rollback:
  // any rejection discards T1's writes; the reason is irrelevant to T2.)
  assertThrows(
    () =>
      applyCommit(engine, {
        sessionId: "session:1",
        invocation: invocationFor(10),
        authorization,
        commit: {
          localSeq: 10,
          reads: {
            confirmed: [{
              id: "entity:D",
              path: toDocumentPath(["value", "title"]),
              seq: 1,
            }],
            pending: [],
          },
          operations: [{
            op: "patch",
            id: "entity:D",
            patches: [{ op: "add", path: "/value/config", value: { on: 1 } }],
          }],
        },
      }),
    ConflictError,
    "stale confirmed read",
  );

  // T1.5 (localSeq 11): blind append to /value/items, zero reads → APPLIED.
  const t15 = applyCommit(engine, {
    sessionId: "session:1",
    invocation: invocationFor(11),
    authorization,
    commit: {
      localSeq: 11,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "patch",
        id: "entity:D",
        patches: [{ op: "add", path: "/value/items/-", value: "B" }],
      }],
    },
  });
  assertEquals(t15.seq, 3);
  return { engine, path };
};

const t2Commit = (withExistenceDep: boolean): ClientCommit => {
  const pending: ClientCommit["reads"]["pending"] = [{
    id: "entity:D",
    path: toDocumentPath(["value", "items"]),
    localSeq: withExistenceDep ? [10, 11] : 11,
  }];
  return {
    localSeq: 12,
    reads: { confirmed: [], pending },
    operations: [{
      op: "set",
      id: "entity:E",
      value: doc({ observedItems: ["seed", "B"] }),
    }],
  };
};

Deno.test("today's wire shape: T2 is doomed by the over-claimed dep on rejected T1", async () => {
  const { engine, path } = await setup();
  try {
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:1",
          invocation: invocationFor(12),
          authorization,
          commit: t2Commit(true),
        }),
      ConflictError,
      "pending dependency not resolved: 10",
    );
  } finally {
    close(engine);
    await Deno.remove(path).catch(() => {});
  }
});

// ---- Variant: T1 writes the READ PATH itself (the 1c corruption case) ----
// Base: D = { items: [] }. T1 (localSeq 10) replaces items with ["A"] —
// REJECTED. T1.5 (localSeq 11) blind-appends "B" — APPLIED over the base
// WITHOUT T1, so durable items = ["B"]. T2 observed ["A","B"] through the
// stack. Pre-PR it names only T1.5 → ACCEPTED with a value that never
// existed durably. PR shape adds resolutionOnly@10 → correctly rejected.
const setupReadPathVariant = async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path) });
  applyCommit(engine, {
    sessionId: "session:seed",
    invocation: invocationFor(1, { actor: "seed" }),
    authorization,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "entity:D",
        value: doc({ items: [], title: "t0" }),
      }],
    },
  });
  applyCommit(engine, {
    sessionId: "session:other",
    invocation: invocationFor(1, { actor: "other" }),
    authorization,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "patch",
        id: "entity:D",
        patches: [{ op: "replace", path: "/value/title", value: "t-foreign" }],
      }],
    },
  });
  // T1: stale read on title → REJECTED; its items=["A"] write is discarded.
  assertThrows(
    () =>
      applyCommit(engine, {
        sessionId: "session:1",
        invocation: invocationFor(10),
        authorization,
        commit: {
          localSeq: 10,
          reads: {
            confirmed: [{
              id: "entity:D",
              path: toDocumentPath(["value", "title"]),
              seq: 1,
            }],
            pending: [],
          },
          operations: [{
            op: "patch",
            id: "entity:D",
            patches: [{ op: "replace", path: "/value/items", value: ["A"] }],
          }],
        },
      }),
    ConflictError,
    "stale confirmed read",
  );
  // T1.5: blind append, zero reads → APPLIED onto the T1-less base.
  applyCommit(engine, {
    sessionId: "session:1",
    invocation: invocationFor(11),
    authorization,
    commit: {
      localSeq: 11,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "patch",
        id: "entity:D",
        patches: [{ op: "add", path: "/value/items/-", value: "B" }],
      }],
    },
  });
  return { engine, path };
};

const t2ObservedAB = (withExistenceDep: boolean): ClientCommit => {
  const pending: ClientCommit["reads"]["pending"] = [{
    id: "entity:D",
    path: toDocumentPath(["value", "items"]),
    localSeq: withExistenceDep ? [10, 11] : 11,
  }];
  return {
    localSeq: 12,
    reads: { confirmed: [], pending },
    operations: [{
      op: "set",
      id: "entity:E",
      value: doc({ observedItems: ["A", "B"] }),
    }],
  };
};

Deno.test("1c corruption: pre-PR shape ACCEPTS T2's phantom ['A','B'] while durable is ['B']", async () => {
  const { engine, path } = await setupReadPathVariant();
  try {
    const accepted = applyCommit(engine, {
      sessionId: "session:1",
      invocation: invocationFor(12),
      authorization,
      commit: t2ObservedAB(false),
    });
    assertEquals(accepted.seq, 4);
    const durable = read(engine, { id: "entity:D" });
    assertEquals(
      (durable as { value?: { items?: unknown } } | null)?.value?.items,
      ["B"],
    );
  } finally {
    close(engine);
    await Deno.remove(path).catch(() => {});
  }
});

Deno.test("1c fix: PR shape rejects the phantom read via the unresolved T1 dep", async () => {
  const { engine, path } = await setupReadPathVariant();
  try {
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:1",
          invocation: invocationFor(12),
          authorization,
          commit: t2ObservedAB(true),
        }),
      ConflictError,
      "pending dependency not resolved: 10",
    );
  } finally {
    close(engine);
    await Deno.remove(path).catch(() => {});
  }
});

Deno.test("overlap-filtered shape: the same T2 is accepted and consistent", async () => {
  const { engine, path } = await setup();
  try {
    const accepted = applyCommit(engine, {
      sessionId: "session:1",
      invocation: invocationFor(12),
      authorization,
      commit: t2Commit(false),
    });
    assertEquals(accepted.seq, 4);
    // T2's observation equals the durable composite: confirmed base +
    // T1.5's append, no trace of T1.
    const durable = read(engine, { id: "entity:D" });
    assertEquals(
      (durable as { value?: { items?: unknown } } | null)?.value?.items,
      ["seed", "B"],
    );
  } finally {
    close(engine);
    await Deno.remove(path).catch(() => {});
  }
});
