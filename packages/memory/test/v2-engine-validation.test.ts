/**
 * Deterministic coverage for the engine's commit/read validation paths —
 * protocol-shape rejections, branch existence/range checks, and stored-row
 * decode guards. These branches otherwise only run on malformed input or
 * corrupt rows, so exercising them here keeps the coverage of this package
 * stable instead of flapping with timing-dependent suites.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { toFileUrl } from "@std/path";
import {
  applyCommit,
  close,
  type Engine,
  open,
  ProtocolError,
  read,
} from "../v2/engine.ts";
import { encodeMemoryBoundary } from "../v2.ts";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model/schema-hash";

const withEngine = async (
  fn: (engine: Engine) => void | Promise<void>,
): Promise<void> => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path) });
  try {
    await fn(engine);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
};

const setOp = (id: string, value: unknown) =>
  ({ op: "set", id, value: { value } }) as never;

const commit = (localSeq: number, extra: Record<string, unknown>) =>
  ({
    localSeq,
    reads: { confirmed: [], pending: [] },
    operations: [],
    ...extra,
  }) as never;

Deno.test("rejects a commit with no operations, observation, or preconditions", async () => {
  await withEngine((engine) => {
    assertThrows(
      () => applyCommit(engine, { sessionId: "s:a", commit: commit(1, {}) }),
      Error,
      "requires at least one operation",
    );
  });
});

Deno.test("rejects mixing schedulerObservation with schedulerObservationBatch", async () => {
  await withEngine((engine) => {
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          principal: "did:key:alice",
          commit: commit(1, {
            schedulerObservation: { x: 1 },
            schedulerObservationBatch: [{ y: 1 }],
          }),
        }),
      ProtocolError,
      "cannot mix schedulerObservation and schedulerObservationBatch",
    );
  });
});

Deno.test("rejects semantic operations on an observation-batch commit", async () => {
  await withEngine((engine) => {
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          principal: "did:key:alice",
          commit: commit(1, {
            operations: [setOp("of:fid1:a", 1)],
            schedulerObservationBatch: [{ y: 1 }],
          }),
        }),
      ProtocolError,
      "must not include semantic operations",
    );
  });
});

Deno.test("rejects commits and reads against an unknown branch", async () => {
  await withEngine((engine) => {
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(1, {
            branch: "nope",
            operations: [setOp("of:fid1:a", 1)],
          }),
        }),
      Error,
      "unknown branch: nope",
    );
    assertThrows(
      () => read(engine, { id: "of:fid1:a", branch: "nope" } as never),
      Error,
      "unknown branch: nope",
    );
  });
});

Deno.test("rejects reads at a seq beyond the branch head", async () => {
  await withEngine((engine) => {
    assertThrows(
      () => read(engine, { id: "of:fid1:a", seq: 999 } as never),
      Error,
      "out of range",
    );
  });
});

Deno.test("rejects stored revision rows that decode to non-documents", async () => {
  await withEngine((engine) => {
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, { operations: [setOp("of:fid1:bad", 1)] }),
    });
    // Corrupt the stored row in place: a VALID boundary encoding whose root
    // is an array, not the plain-object root every stored document must be.
    engine.database.prepare(
      `UPDATE revision SET data = :data WHERE id = 'of:fid1:bad'`,
    ).run({ data: encodeMemoryBoundary([1]) });
    assertThrows(
      () => read(engine, { id: "of:fid1:bad" } as never),
      Error,
      "stored documents must be plain object roots",
    );
  });
});

Deno.test("rejects stored revision rows with an unexpected op", async () => {
  await withEngine((engine) => {
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, { operations: [setOp("of:fid1:odd", 1)] }),
    });
    engine.database.prepare(
      `UPDATE revision SET op = 'bogus' WHERE id = 'of:fid1:odd'`,
    ).run({});
    assertThrows(
      () => read(engine, { id: "of:fid1:odd" } as never),
      Error,
      "unexpected stored revision op",
    );
  });
});

Deno.test("a valid set still reads back after the validation batteries", async () => {
  await withEngine((engine) => {
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, { operations: [setOp("of:fid1:ok", 7)] }),
    });
    assertEquals(read(engine, { id: "of:fid1:ok" } as never), { value: 7 });
  });
});

Deno.test("rejects deleting or patching a content-addressed document", async () => {
  await withEngine((engine) => {
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, {
        operations: [setOp("cid:fid1:immutable", { type: "string" })],
      }),
    });
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(2, {
            operations: [{ op: "delete", id: "cid:fid1:immutable" } as never],
          }),
        }),
      ProtocolError,
      "cannot delete content-addressed document",
    );
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(3, {
            operations: [
              { op: "patch", id: "cid:fid1:immutable", patches: [] } as never,
            ],
          }),
        }),
      ProtocolError,
      "cannot patch content-addressed document",
    );
    // An idempotent re-set stays legal: it is how writers install closures.
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(4, {
        operations: [setOp("cid:fid1:immutable", { type: "string" })],
      }),
    });
  });
});

Deno.test("compares content-addressed sets by content inside special objects", async () => {
  await withEngine((engine) => {
    // A special object keeps its state in private fields, which a naive
    // structural walk conflates across distinct instances (CT-1770); the
    // guard compares canonical content, so a difference inside one is a
    // difference.
    const bytesDoc = (byte: number) => ({
      payload: new FabricBytes(new Uint8Array([byte])),
    });
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(1, {
            operations: [
              setOp("cid:fid1:special", bytesDoc(1)),
              setOp("cid:fid1:special", bytesDoc(2)),
            ],
          }),
        }),
      ProtocolError,
      "conflicting sets of content-addressed document",
    );
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(2, {
        operations: [setOp("cid:fid1:special", bytesDoc(1))],
      }),
    });
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(3, {
            operations: [setOp("cid:fid1:special", bytesDoc(2))],
          }),
        }),
      ProtocolError,
      "cannot change content-addressed document",
    );
  });
});

Deno.test("rejects a set that changes a content-addressed document", async () => {
  await withEngine((engine) => {
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, {
        operations: [setOp("cid:fid1:settled", { type: "string" })],
      }),
    });
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(2, {
            operations: [setOp("cid:fid1:settled", { type: "number" })],
          }),
        }),
      ProtocolError,
      "cannot change content-addressed document",
    );
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(3, {
            operations: [
              setOp("cid:fid1:conflicted", { type: "string" }),
              setOp("cid:fid1:conflicted", { type: "number" }),
            ],
          }),
        }),
      ProtocolError,
      "conflicting sets of content-addressed document",
    );
    // Identical duplicate sets within one commit are the idempotent case.
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(4, {
        operations: [
          setOp("cid:fid1:duplicated", { type: "boolean" }),
          setOp("cid:fid1:duplicated", { type: "boolean" }),
        ],
      }),
    });
  });
});

Deno.test("rejects a content-addressed document written at a non-space scope", async () => {
  await withEngine((engine) => {
    // A scoped partition could hold a divergent copy under one cid: id —
    // the immutability check reads at the operation's scope, and readers
    // resolve cid: documents at space scope only.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          principal: "did:key:alice",
          commit: commit(1, {
            operations: [{
              op: "set",
              id: "cid:fid1:scoped",
              scope: "user",
              value: { value: { type: "string" } },
            } as never],
          }),
        }),
      ProtocolError,
      "cannot write content-addressed document cid:fid1:scoped at user scope",
    );
  });
});

Deno.test("validates the schema closure a commit's content references", async () => {
  await withEngine((engine) => {
    const leafSchema = { type: "string", title: "closure-leaf" } as const;
    const leafHash = internSchemaAsTaggedHashString(leafSchema);
    const rootSchema = {
      type: "object",
      properties: { x: { $ref: `cid:${leafHash}` } },
    } as const;
    const rootHash = internSchemaAsTaggedHashString(rootSchema);
    const carrier = (target: string) => ({
      linked: {
        "/": {
          "link@1": {
            id: target,
            path: [],
            schema: { $ref: `cid:${rootHash}` },
          },
        },
      },
    });

    // A reference nothing backs is rejected outright.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(1, {
            operations: [setOp("of:closure-carrier", carrier("of:t1"))],
          }),
        }),
      ProtocolError,
      "neither included in the commit nor stored in the space",
    );

    // The whole closure included in the SAME commit is accepted...
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(2, {
        operations: [
          setOp("of:closure-carrier", carrier("of:t1")),
          setOp(`cid:${rootHash}`, rootSchema),
          setOp(`cid:${leafHash}`, leafSchema),
        ],
      }),
    });

    // ...and once stored, it satisfies later commits by itself.
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(3, {
        operations: [setOp("of:closure-carrier-2", carrier("of:t2"))],
      }),
    });
  });
});

Deno.test("rejects incomplete or forged closures included in a commit", async () => {
  await withEngine((engine) => {
    const leafSchema = { type: "number", title: "partial-leaf" } as const;
    const leafHash = internSchemaAsTaggedHashString(leafSchema);
    const rootSchema = {
      type: "object",
      properties: { y: { $ref: `cid:${leafHash}` } },
    } as const;
    const rootHash = internSchemaAsTaggedHashString(rootSchema);

    // Installing the root without its dependency is an incomplete closure:
    // the walk is transitive.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(1, {
            operations: [setOp(`cid:${rootHash}`, rootSchema)],
          }),
        }),
      ProtocolError,
      "neither included in the commit nor stored in the space",
    );

    // Forged content under a referenced id is rejected by the identity
    // check, so a forged first-install cannot back a reference.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(2, {
            operations: [
              setOp(`cid:${rootHash}`, rootSchema),
              setOp(`cid:${leafHash}`, { type: "boolean", title: "forged" }),
            ],
          }),
        }),
      ProtocolError,
      "whose included content does not verify",
    );

    // A patch's own values introduce requirements too.
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(3, {
        operations: [setOp("of:patched-carrier", { plain: true })],
      }),
    });
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(4, {
            operations: [{
              op: "patch",
              id: "of:patched-carrier",
              patches: [{
                op: "add",
                path: "/value/linked",
                value: {
                  "/": {
                    "link@1": {
                      id: "of:patched-target",
                      path: [],
                      schema: { $ref: `cid:${rootHash}` },
                    },
                  },
                },
              }],
            } as never],
          }),
        }),
      ProtocolError,
      "neither included in the commit nor stored in the space",
    );
  });
});
