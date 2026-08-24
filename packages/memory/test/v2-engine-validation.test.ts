/**
 * Deterministic coverage for the engine's commit/read validation paths —
 * protocol-shape rejections, branch existence/range checks, and stored-row
 * decode guards. These branches otherwise only run on malformed input or
 * corrupt rows, so exercising them here keeps the coverage of this package
 * stable instead of flapping with timing-dependent suites.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { toFileUrl } from "@std/path";
import { applyCommit, close, type Engine, open, read } from "../v2/engine.ts";
import { encodeMemoryBoundary, ProtocolError } from "../v2.ts";
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

Deno.test("serves a repeat schema reference from the per-engine verification cache", async () => {
  await withEngine((engine) => {
    const leaf = { type: "string", title: "cache-hit-leaf" } as const;
    const leafHash = internSchemaAsTaggedHashString(leaf);
    const schema = {
      type: "object",
      properties: { x: { $ref: `cid:${leafHash}` } },
    } as const;
    const hash = internSchemaAsTaggedHashString(schema);
    const carrier = (target: string) => ({
      linked: {
        "/": {
          "link@1": {
            id: target,
            path: [],
            schema: { $ref: `cid:${hash}` },
          },
        },
      },
    });
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, {
        operations: [
          setOp(`cid:${hash}`, schema),
          setOp(`cid:${leafHash}`, leaf),
        ],
      }),
    });
    // The first stored-backed reference verifies by re-hashing the stored
    // content and caches the verdict...
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(2, {
        operations: [setOp("of:cache-carrier-1", carrier("of:t1"))],
      }),
    });
    // ...and a repeat reference is served from that cache: the document is
    // immutable, so its unchanged seq revalidates it without re-hashing,
    // and the cached entry re-enqueues its own dependencies.
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(3, {
        operations: [setOp("of:cache-carrier-2", carrier("of:t2"))],
      }),
    });
    assertEquals(read(engine, { id: "of:cache-carrier-2" } as never), {
      value: carrier("of:t2"),
    });
  });
});

Deno.test("rejects a reference backed by a stored cid: document holding other content", async () => {
  await withEngine((engine) => {
    const claimed = { type: "string", title: "impostor-claim" } as const;
    const claimedHash = internSchemaAsTaggedHashString(claimed);
    // A cid: install nothing references is admitted without a class check —
    // the boundary cannot name an unreferenced document's class...
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, {
        operations: [
          setOp(`cid:${claimedHash}`, { type: "boolean", title: "impostor" }),
        ],
      }),
    });
    // ...but it cannot back a schema reference: satisfaction re-hashes the
    // stored content against the id the reference claims.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(2, {
            operations: [
              setOp("of:impostor-carrier", {
                linked: {
                  "/": {
                    "link@1": {
                      id: "of:impostor-target",
                      path: [],
                      schema: { $ref: `cid:${claimedHash}` },
                    },
                  },
                },
              }),
            ],
          }),
        }),
      ProtocolError,
      "whose stored content does not verify",
    );
  });
});

Deno.test("treats an $alias-shaped record as plain data at the commit boundary", async () => {
  await withEngine((engine) => {
    // An alias is a binding only by context. To the commit boundary this
    // record is plain data, so the `cid:` ref inside its `schema` member
    // creates no closure obligation — a document that merely looks like a
    // binding must never have its commit rejected over one.
    const hash = internSchemaAsTaggedHashString({
      type: "string",
      title: "alias-data-leaf",
    });
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, {
        operations: [
          setOp("of:alias-data-carrier", {
            bound: {
              $alias: {
                cell: "argument",
                path: ["field"],
                schema: { $ref: `cid:${hash}` },
              },
            },
          }),
        ],
      }),
    });
    assertEquals(
      read(engine, { id: "of:alias-data-carrier" } as never) !== null,
      true,
    );
  });
});
Deno.test("applies an identical content-addressed re-set as a no-op", async () => {
  await withEngine((engine) => {
    const schema = { type: "string", title: "elided-re-set" } as const;
    const install = applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, {
        operations: [setOp("cid:fid1:elided", schema)],
      }),
    });
    assertEquals(install.revisions.length, 1);
    assertEquals(install.elidedOpIndexes, undefined);
    const headSeq = engine.database.prepare(
      `SELECT seq FROM head WHERE id = 'cid:fid1:elided'`,
    ).get<{ seq: number }>()!.seq;

    // The identical re-set is proven unchanged by the immutability
    // comparison, so it applies as a no-op: no revision, no head advance —
    // and therefore nothing for fan-out to deliver — while the commit
    // itself still records and advances the space log.
    const reSet = applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(2, {
        operations: [
          setOp("cid:fid1:elided", schema),
          setOp("cid:fid1:elided", schema),
          setOp("of:elide-bystander", { n: 1 }),
        ],
      }),
    });
    assertEquals(reSet.seq > install.seq, true);
    assertEquals(reSet.elidedOpIndexes, [0, 1]);
    assertEquals(reSet.revisions.map((revision) => revision.id), [
      "of:elide-bystander",
    ]);
    const after = engine.database.prepare(
      `SELECT seq FROM head WHERE id = 'cid:fid1:elided'`,
    ).get<{ seq: number }>()!.seq;
    assertEquals(after, headSeq);

    // A differing re-set still cannot slip through as an elision.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(3, {
            operations: [
              setOp("cid:fid1:elided", { type: "number", title: "changed" }),
            ],
          }),
        }),
      ProtocolError,
      "cannot change content-addressed document",
    );
  });
});

Deno.test("a replayed eliding commit reports its elision again", async () => {
  await withEngine((engine) => {
    const schema = { type: "string", title: "replayed-elision" } as const;
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, {
        operations: [setOp("cid:fid1:replayed", schema)],
      }),
    });
    const elidingCommit = commit(2, {
      operations: [setOp("cid:fid1:replayed", schema)],
    });
    const first = applyCommit(engine, {
      sessionId: "s:a",
      commit: elidingCommit,
    });
    assertEquals(first.elidedOpIndexes, [0]);
    // The replay returns the stored result — including the elision report,
    // which persisted no revision and must be re-derived, or the accept
    // path would classify the unchanged document as dirty.
    const replayed = applyCommit(engine, {
      sessionId: "s:a",
      commit: elidingCommit,
    });
    assertEquals(replayed.seq, first.seq);
    assertEquals(replayed.elidedOpIndexes, [0]);
    assertEquals(replayed.revisions, []);
  });
});

Deno.test("validates the schema document a CFC envelope's schemaHash references", async () => {
  await withEngine((engine) => {
    const envelopeSchema = {
      type: "object",
      properties: { field: { type: "string" } },
      ifc: { confidentiality: ["secret"] },
    } as const;
    const envelopeHash = internSchemaAsTaggedHashString(envelopeSchema);
    const docWithMetadata = (schemaHash: string) =>
      ({
        op: "set",
        id: "of:envelope-carrier",
        value: {
          value: { field: "v" },
          cfc: {
            version: 1,
            schemaHash,
            labelMap: { version: 1, entries: [] },
          },
        },
      }) as never;

    // Metadata naming a document nothing backs is rejected — the same
    // broken closure a dangling link `$ref` would create, spelled as a
    // bare hash at the reserved `cfc` position.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(1, {
            operations: [docWithMetadata(envelopeHash)],
          }),
        }),
      ProtocolError,
      "neither included in the commit nor stored in the space",
    );

    // The document included in the SAME commit is accepted...
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(2, {
        operations: [
          docWithMetadata(envelopeHash),
          setOp(`cid:${envelopeHash}`, envelopeSchema),
        ],
      }),
    });

    // ...and once stored, it satisfies later metadata by itself.
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(3, {
        operations: [docWithMetadata(envelopeHash)],
      }),
    });

    // The boundary polices backing, not spelling: a `schemaHash` in any
    // format is the reference, and one no content can verify against is
    // permanently unbackable — refused here rather than reading as
    // unreadable later.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(4, {
            operations: [
              {
                op: "set",
                id: "of:junk-envelope-carrier",
                value: {
                  value: { field: "v" },
                  cfc: {
                    version: 1,
                    schemaHash: "seed-schema",
                    labelMap: { version: 1, entries: [] },
                  },
                },
              } as never,
            ],
          }),
        }),
      ProtocolError,
      "neither included in the commit nor stored in the space",
    );

    // The patch spelling of the same landing is validated too.
    const missingSchema = {
      type: "object",
      properties: { other: { type: "number" } },
    } as const;
    const missingHash = internSchemaAsTaggedHashString(missingSchema);
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(5, {
            operations: [
              {
                op: "patch",
                id: "of:envelope-carrier",
                patches: [{
                  op: "replace",
                  path: "/cfc",
                  value: {
                    version: 1,
                    schemaHash: missingHash,
                    labelMap: { version: 1, entries: [] },
                  },
                }],
              } as never,
            ],
          }),
        }),
      ProtocolError,
      "neither included in the commit nor stored in the space",
    );

    // A ROOT-level replace smuggles the same landing inside a whole
    // document value.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(6, {
            operations: [
              {
                op: "patch",
                id: "of:envelope-carrier",
                patches: [{
                  op: "replace",
                  path: "",
                  value: {
                    value: { field: "v" },
                    cfc: {
                      version: 1,
                      schemaHash: missingHash,
                      labelMap: { version: 1, entries: [] },
                    },
                  },
                }],
              } as never,
            ],
          }),
        }),
      ProtocolError,
      "neither included in the commit nor stored in the space",
    );

    // A MOVE converts plain document data into a metadata reference: the
    // installed value exists only post-patch, so only the post-patch scan
    // sees it.
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(7, {
        operations: [{
          op: "set",
          id: "of:move-carrier",
          value: { value: { hoard: missingHash } },
        } as never],
      }),
    });
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(8, {
            operations: [
              {
                op: "patch",
                id: "of:move-carrier",
                patches: [{
                  op: "add",
                  path: "/cfc",
                  value: { version: 1, labelMap: { version: 1, entries: [] } },
                }, {
                  op: "move",
                  from: "/value/hoard",
                  path: "/cfc/schemaHash",
                }],
              } as never,
            ],
          }),
        }),
      ProtocolError,
      "neither included in the commit nor stored in the space",
    );

    // The same move with the document backing it lands.
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(9, {
        operations: [
          setOp(`cid:${missingHash}`, missingSchema),
          {
            op: "patch",
            id: "of:move-carrier",
            patches: [{
              op: "add",
              path: "/cfc",
              value: { version: 1, labelMap: { version: 1, entries: [] } },
            }, {
              op: "move",
              from: "/value/hoard",
              path: "/cfc/schemaHash",
            }],
          } as never,
        ],
      }),
    });

    // A cfc-touching sequence that cannot APPLY is not the validator's to
    // judge: the closure scan skips it, and the commit's own application
    // refuses it on its own terms.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(10, {
            operations: [
              {
                op: "patch",
                id: "of:move-carrier",
                patches: [{ op: "replace", path: "", value: 42 }],
              } as never,
            ],
          }),
        }),
      Error,
      "entity document",
    );

    // A SCOPED patch replays over the document at its OWN scope — the
    // space-scoped instance (absent here) is not the document a
    // user-scoped patch lands on, and validating against it would let a
    // scoped envelope be re-pointed at an unbacked hash.
    applyCommit(engine, {
      sessionId: "s:a",
      principal: "did:key:scoped-author",
      commit: commit(11, {
        operations: [{
          op: "set",
          id: "of:scoped-envelope-carrier",
          scope: "user",
          value: {
            value: { field: "v" },
            cfc: {
              version: 1,
              schemaHash: envelopeHash,
              labelMap: { version: 1, entries: [] },
            },
          },
        } as never],
      }),
    });
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          principal: "did:key:scoped-author",
          commit: commit(12, {
            operations: [{
              op: "patch",
              id: "of:scoped-envelope-carrier",
              scope: "user",
              patches: [{
                op: "replace",
                path: "/cfc/schemaHash",
                value: "fid1:scoped-unbacked-hash",
              }],
            } as never],
          }),
        }),
      ProtocolError,
      "neither included in the commit nor stored in the space",
    );

    // A delete between them clears the staged base: the patch that
    // follows replays over an absent document, and the envelope it adds
    // there is validated like any other landing.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(14, {
            operations: [{
              op: "set",
              id: "of:delete-then-patch-carrier",
              value: { value: { field: "v" } },
            } as never, {
              op: "delete",
              id: "of:delete-then-patch-carrier",
            } as never, {
              op: "patch",
              id: "of:delete-then-patch-carrier",
              patches: [{
                op: "add",
                path: "/cfc",
                value: {
                  version: 1,
                  schemaHash: "fid1:post-delete-unbacked",
                  labelMap: { version: 1, entries: [] },
                },
              }],
            } as never],
          }),
        }),
      ProtocolError,
      "neither included in the commit nor stored in the space",
    );

    // Operations in ONE commit compose: a set stages the base a later
    // patch rewrites, so the patch validates against what THIS commit
    // leaves, never against durable pre-commit state alone.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(13, {
            operations: [{
              op: "set",
              id: "of:intra-commit-carrier",
              value: {
                value: { field: "v" },
                cfc: {
                  version: 1,
                  schemaHash: "",
                  labelMap: { version: 1, entries: [] },
                },
              },
            } as never, {
              op: "patch",
              id: "of:intra-commit-carrier",
              patches: [{
                op: "replace",
                path: "/cfc/schemaHash",
                value: "fid1:intra-commit-unbacked",
              }],
            } as never],
          }),
        }),
      ProtocolError,
      "neither included in the commit nor stored in the space",
    );
  });
});

Deno.test("walks a CFC envelope's schema-document closure transitively", async () => {
  await withEngine((engine) => {
    // A decomposed envelope root references its definitions as
    // `$ref: cid:` members. The closure walk must follow those
    // references — a root without its definition is the same broken
    // closure as missing the root itself.
    const childSchema = {
      type: "string",
      ifc: { confidentiality: ["decomposed"] },
    } as const;
    const childHash = internSchemaAsTaggedHashString(childSchema);
    const rootSchema = {
      type: "object",
      properties: { secret: { $ref: `cid:${childHash}` } },
    } as never;
    const rootHash = internSchemaAsTaggedHashString(rootSchema);
    const carrier = {
      op: "set",
      id: "of:decomposed-envelope-carrier",
      value: {
        value: { secret: "v" },
        cfc: {
          version: 1,
          schemaHash: rootHash,
          labelMap: { version: 1, entries: [] },
        },
      },
    } as never;

    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(30, {
            operations: [carrier, setOp(`cid:${rootHash}`, rootSchema)],
          }),
        }),
      ProtocolError,
      "neither included in the commit nor stored in the space",
    );

    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(31, {
        operations: [
          carrier,
          setOp(`cid:${rootHash}`, rootSchema),
          setOp(`cid:${childHash}`, childSchema),
        ],
      }),
    });
  });
});
