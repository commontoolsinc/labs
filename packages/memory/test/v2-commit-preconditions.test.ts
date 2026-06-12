import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { toFileUrl } from "@std/path";
import {
  applyCommit,
  close,
  type Engine,
  open,
  PreconditionFailedError,
  read,
} from "../v2/engine.ts";
import { Server } from "../v2/server.ts";
import { connect, loopback } from "../v2/client.ts";
import { type EntityDocument, toDocumentPath } from "../v2.ts";
import type { FabricValue } from "../interface.ts";

const createEngine = async (): Promise<{
  engine: Engine;
  path: string;
}> => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path) });
  return { engine, path };
};

const toEntityDocument = (value: FabricValue): EntityDocument => ({ value });

Deno.test("origin-committed precondition accepts a committed same-session origin", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:lineage",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:origin",
          value: toEntityDocument({ ok: true }),
        }],
      },
    });

    const followUp = applyCommit(engine, {
      sessionId: "session:lineage",
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        preconditions: [{
          kind: "origin-committed",
          originLocalSeq: 1,
        }],
        operations: [{
          op: "set",
          id: "entity:follow-up",
          value: toEntityDocument({ released: true }),
        }],
      },
    });

    assertEquals(followUp.seq, 2);
    assertEquals(read(engine, { id: "entity:follow-up" }), {
      value: { released: true },
    });
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("origin-committed precondition rejects a rejected origin localSeq", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:setup",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:source",
          value: toEntityDocument({ version: 1 }),
        }],
      },
    });

    applyCommit(engine, {
      sessionId: "session:other",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "entity:source",
          patches: [{
            op: "replace",
            path: "/value/version",
            value: 2,
          }],
        }],
      },
    });

    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:lineage",
          commit: {
            localSeq: 1,
            reads: {
              confirmed: [{
                id: "entity:source",
                path: toDocumentPath(["value", "version"]),
                seq: 1,
              }],
              pending: [],
            },
            operations: [{
              op: "set",
              id: "entity:origin-attempt",
              value: toEntityDocument({ shouldNotCommit: true }),
            }],
          },
        }),
      Error,
      "stale confirmed read",
    );

    const rejected = assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:lineage",
          commit: {
            localSeq: 2,
            reads: { confirmed: [], pending: [] },
            preconditions: [{
              kind: "origin-committed",
              originLocalSeq: 1,
            }],
            operations: [{
              op: "set",
              id: "entity:descendant",
              value: toEntityDocument({ shouldNotCommit: true }),
            }],
          },
        }),
      PreconditionFailedError,
      "origin commit not committed",
    );

    assertEquals(rejected.name, "PreconditionFailedError");
    assertEquals(rejected.precondition, "origin-committed");
    assertEquals(read(engine, { id: "entity:descendant" }), null);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("commits without preconditions are unaffected", async () => {
  const { engine, path } = await createEngine();

  try {
    const applied = applyCommit(engine, {
      sessionId: "session:no-preconditions",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:plain",
          value: toEntityDocument({ ok: true }),
        }],
      },
    });

    assertEquals(applied.seq, 1);
    assertEquals(read(engine, { id: "entity:plain" }), {
      value: { ok: true },
    });
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("precondition failures keep name and precondition through client round trip", async () => {
  const server = new Server({
    store: new URL("memory://memory-v2-commit-preconditions-client"),
  });
  const client = await connect({ transport: loopback(server) });
  const session = await client.mount(
    "did:key:z6Mk-memory-v2-commit-preconditions-client",
  );

  try {
    const error = await assertRejects(
      () =>
        session.transact({
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          preconditions: [{
            kind: "origin-committed",
            originLocalSeq: 99,
          }],
          operations: [{
            op: "set",
            id: "entity:descendant",
            value: toEntityDocument({ shouldNotCommit: true }),
          }],
        }),
      Error,
      "origin commit not committed",
    );

    assertEquals(error.name, "PreconditionFailedError");
    assertEquals(
      (error as Error & { precondition?: unknown }).precondition,
      "origin-committed",
    );
  } finally {
    await client.close();
    await server.close();
  }
});
