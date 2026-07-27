// Pins CT-1910 (pending-read basis over-advance), the known deviation
// recorded against INV-1 in docs/specs/memory-v2/09-invariants.md: the
// staleness scan for a pending read starts at the highest dependency's
// resolution seq, so overlapping FOREIGN writes landing between the reader's
// confirmed basis and that seq are never scanned. The TLA+ model finds the
// same class mechanically (docs/specs/memory-v2/tla/PendingStacks_Current.cfg
// violates ReadCoherence); the engine-level repro here is the one verified in
// the PR #4606 review thread (2026-07-24), transcribed to the post-#4606
// array-localSeq wire shape.
//
// The first test asserts the CURRENT, UNSOUND behavior — the incoherent
// commit is accepted and its stale observation lands durably. When the
// CT-1910 repair lands (scan from the reader's confirmed basis, excluding
// only the session's own resolved stack), that accept MUST flip to a
// ConflictError: update this test to assertThrows in the same change, along
// with the naive model's basis (test/naive-admission.ts) and INV-1's
// known-deviations entry.
//
// The second test is the counterfactual that isolates the basis as the sole
// escape hatch: the identical observation declared as a confirmed read at
// the reader's true basis IS rejected as stale, so the engine sees the
// overlap — only the over-advanced pending-read basis skips the interval
// containing it.

import { assertEquals, assertThrows } from "@std/assert";
import { toFileUrl } from "@std/path";
import {
  applyCommit,
  close,
  ConflictError,
  type Engine,
  open,
  read,
} from "../v2/engine.ts";
import { type EntityDocument, toDocumentPath } from "../v2.ts";

const createEngine = async (): Promise<{ engine: Engine; path: string }> => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path) });
  return { engine, path };
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

const toEntityDocument = (
  value: unknown,
): EntityDocument => ({ value } as EntityDocument);

// The shared schedule. Seq numbers are the engine's accepted-commit seqs:
//
//   seq 1  session:1  localSeq 1  set   A = {x: 1}
//   seq 2  FOREIGN                patch A.x = 2        <- the write the
//   seq 3  session:1  localSeq 2  patch A.y = 9 (blind)   reader must see
//
// The reader (session:1, localSeq 3) observed x = 1 through its pending
// stack. Its true confirmed basis is seq 0; the foreign x = 2 landed at
// seq 2. Any coherent admission must scan an interval containing seq 2.
const seedSchedule = (engine: Engine): void => {
  applyCommit(engine, {
    sessionId: "session:1",
    invocation: invocationFor(1),
    authorization,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "entity:A",
        value: toEntityDocument({ x: 1 }),
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
        id: "entity:A",
        patches: [{ op: "replace", path: "/value/x", value: 2 }],
      }],
    },
  });
  applyCommit(engine, {
    sessionId: "session:1",
    invocation: invocationFor(2),
    authorization,
    commit: {
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "patch",
        id: "entity:A",
        patches: [{ op: "add", path: "/value/y", value: 9 }],
      }],
    },
  });
};

Deno.test("memory v2 engine: CT-1910 — pending-read staleness scan misses a foreign write between the reader's confirmed basis and its resolution basis", async () => {
  const { engine, path } = await createEngine();
  try {
    seedSchedule(engine);

    // Reader: full-stack dependency declaration per #4606 — the array names
    // every pending layer the view sat on, including the doc's top-of-stack
    // layer (localSeq 2, resolved at seq 3). Basis = resolve(max) = 3, so
    // the staleness scan covers (3, head] and can never reach the foreign
    // x = 2 at seq 2. No dependency-recording shape fixes this: the scan
    // interval is wrong, not the dependency set (tla/README.md).
    applyCommit(engine, {
      sessionId: "session:1",
      invocation: invocationFor(3),
      authorization,
      commit: {
        localSeq: 3,
        reads: {
          confirmed: [],
          pending: [{
            id: "entity:A",
            path: toDocumentPath(["value", "x"]),
            localSeq: [1, 2],
          }],
        },
        operations: [{
          op: "set",
          id: "entity:derived",
          value: toEntityDocument({ observedX: 1 }),
        }],
      },
    });

    // Durable history says x has been 2 since seq 2 …
    assertEquals(
      (read(engine, { id: "entity:A" })?.value as { x: number }).x,
      2,
    );
    // … yet the accepted commit durably recorded an observation of x = 1:
    // observed ⊂ durable, the INV-1 "missed write" direction. This accept is
    // the bug. After the CT-1910 repair, applyCommit above must throw
    // ConflictError ("stale pending read") and entity:derived must not exist.
    assertEquals(
      (read(engine, { id: "entity:derived" })?.value as { observedX: number })
        .observedX,
      1,
    );
  } finally {
    close(engine);
    await Deno.remove(path).catch(() => {});
  }
});

Deno.test("memory v2 engine: CT-1910 counterfactual — the same observation at its true confirmed basis is rejected as stale", async () => {
  const { engine, path } = await createEngine();
  try {
    seedSchedule(engine);

    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:1",
          invocation: invocationFor(3),
          authorization,
          commit: {
            localSeq: 3,
            reads: {
              confirmed: [{
                id: "entity:A",
                path: toDocumentPath(["value", "x"]),
                seq: 1,
              }],
              pending: [],
            },
            operations: [{
              op: "set",
              id: "entity:derived",
              value: toEntityDocument({ observedX: 1 }),
            }],
          },
        }),
      ConflictError,
      "stale confirmed read",
    );

    assertEquals(read(engine, { id: "entity:derived" }), null);
  } finally {
    close(engine);
    await Deno.remove(path).catch(() => {});
  }
});
