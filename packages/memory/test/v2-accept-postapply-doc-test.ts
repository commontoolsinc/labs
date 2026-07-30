// CT-1926: patch-op accept responses carry the document's post-commit state.
//
// The client's `confirmPending` promotes its confirmed mirror from this value
// instead of extrapolating its own patch onto a possibly-stale local base —
// the inline accept can outrun the batched fan-out carrying the foreign
// writes the patch was applied on top of, and a locally-extrapolated
// promotion mints a (seq, value) pair the server never had, feeding
// dishonest staleness bases into later reads. `set` revisions keep carrying
// their own payload; `delete` stays identity-only. Replayed accepts recover
// the same document via a seq-pinned read, so a replay observed after later
// commits landed still reports the state as of the replayed commit.

import { assertEquals } from "@std/assert";
import { toFileUrl } from "@std/path";
import { applyCommit, close, type Engine, open } from "../v2/engine.ts";
import { type EntityDocument } from "../v2.ts";

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

Deno.test("memory v2 engine: a patch accept carries the post-apply document, including foreign writes the client has not seen", async () => {
  const { engine, path } = await createEngine();
  try {
    // Foreign winner establishes the container the client's mirror lacks.
    applyCommit(engine, {
      sessionId: "session:other",
      invocation: invocationFor(1, { actor: "other" }),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:list",
          value: toEntityDocument({ items: ["a", "b"] }),
        }],
      },
    });

    // The session's blind append is applied against the winner's container.
    const applied = applyCommit(engine, {
      sessionId: "session:1",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "entity:list",
          patches: [{ op: "add", path: "/value/items/-", value: "X" }],
        }],
      },
    });

    assertEquals(applied.revisions.length, 1);
    assertEquals(applied.revisions[0].op, "patch");
    // The response tells the client what the doc actually became — the
    // winner's items plus the append — not just the patch it already knew.
    assertEquals(
      applied.revisions[0].document,
      toEntityDocument({ items: ["a", "b", "X"] }),
    );
  } finally {
    close(engine);
    await Deno.remove(path).catch(() => {});
  }
});

Deno.test("memory v2 engine: set and delete revisions keep their shapes; multi-patch docs report the final state on every revision", async () => {
  const { engine, path } = await createEngine();
  try {
    applyCommit(engine, {
      sessionId: "session:1",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:doc",
          value: toEntityDocument({ x: 1 }),
        }],
      },
    });

    // One commit, two patches on the same doc plus a set and a delete on
    // others: every patch revision carries the doc's FINAL post-commit
    // state (revision-order independent), the set echoes its payload, the
    // delete stays identity-only.
    const applied = applyCommit(engine, {
      sessionId: "session:1",
      invocation: invocationFor(2),
      authorization,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "patch",
            id: "entity:doc",
            patches: [{ op: "replace", path: "/value/x", value: 2 }],
          },
          {
            op: "patch",
            id: "entity:doc",
            patches: [{ op: "add", path: "/value/y", value: 3 }],
          },
          {
            op: "set",
            id: "entity:fresh",
            value: toEntityDocument({ ok: true }),
          },
          { op: "delete", id: "entity:gone" },
        ],
      },
    });

    const final = toEntityDocument({ x: 2, y: 3 });
    assertEquals(applied.revisions[0].document, final);
    assertEquals(applied.revisions[1].document, final);
    assertEquals(
      applied.revisions[2].document,
      toEntityDocument({ ok: true }),
    );
    assertEquals(applied.revisions[3].document, undefined);
  } finally {
    close(engine);
    await Deno.remove(path).catch(() => {});
  }
});

Deno.test("memory v2 engine: a replayed patch accept reports the state as of ITS commit, not the head", async () => {
  const { engine, path } = await createEngine();
  try {
    applyCommit(engine, {
      sessionId: "session:other",
      invocation: invocationFor(1, { actor: "other" }),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:list",
          value: toEntityDocument({ items: ["a"] }),
        }],
      },
    });
    const original = {
      sessionId: "session:1",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: {
          confirmed: [] as never[],
          pending: [] as never[],
        },
        operations: [{
          op: "patch" as const,
          id: "entity:list",
          patches: [{
            op: "add" as const,
            path: "/value/items/-",
            value: "X",
          }],
        }],
      },
    };
    applyCommit(engine, original);
    // A later foreign write advances the doc past the replayed commit.
    applyCommit(engine, {
      sessionId: "session:other",
      invocation: invocationFor(2, { actor: "other" }),
      authorization,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "entity:list",
          patches: [{ op: "add", path: "/value/items/-", value: "later" }],
        }],
      },
    });

    // Replay (same session, same localSeq, same payload): the seq-pinned
    // recovery reports ["a","X"], not the current head ["a","X","later"].
    const replayed = applyCommit(engine, original);
    assertEquals(
      replayed.revisions[0].document,
      toEntityDocument({ items: ["a", "X"] }),
    );
  } finally {
    close(engine);
    await Deno.remove(path).catch(() => {});
  }
});
