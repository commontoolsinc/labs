import {
  assertEquals,
  assertExists,
  assertMatch,
  assertThrows,
} from "@std/assert";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import {
  type EntityRef,
  entityRefFromString,
  LINK_V1_TAG,
  linkRefFrom,
} from "@commonfabric/data-model/cell-rep";
import { hashOf } from "@commonfabric/data-model/value-hash";
import { toFileUrl } from "@std/path";
import { Database } from "@db/sqlite";
import {
  applyCommit,
  close,
  ConflictError,
  createBranch,
  deleteBranch,
  type Engine,
  entityIdExists,
  listBranches,
  listEntityIdPage,
  listEntityIds,
  listPieceRootPage,
  listPieceRootSnapshotPage,
  open,
  ProtocolError,
  read,
  serverSeq,
} from "../v2/engine.ts";
import {
  decodeMemoryBoundary,
  DEFAULT_BRANCH,
  encodeMemoryBoundary,
  type EntityDocument,
  toDocumentPath,
} from "../v2.ts";

const createEngine = async (): Promise<{
  engine: Engine;
  path: string;
}> => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path) });
  return { engine, path };
};

const createEngineWithOptions = async (
  options: Omit<Parameters<typeof open>[0], "url">,
): Promise<{
  engine: Engine;
  path: string;
}> => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path), ...options });
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

const decodeStored = <Value extends FabricValue>(
  source: string | null | undefined,
): Value => decodeMemoryBoundary<Value>(source ?? "null");

const toEntityDocument = (
  value: unknown,
  source?: EntityRef,
  metadata: Record<string, unknown> = {},
): EntityDocument => {
  const document: Record<string, unknown> = {
    ...metadata,
    ...(source !== undefined ? { source } : {}),
  };
  if (value !== undefined) {
    document.value = value;
  }
  return document as EntityDocument;
};

Deno.test("memory v2 engine reserves sync schema reference strings", async () => {
  const { engine, path } = await createEngine();
  const id = "entity:reserved-sync-schema-ref";
  const reservedRef = "schema-ref@2:sha256:user-controlled";

  try {
    applyCommit(engine, {
      sessionId: "session:reserved-sync-schema-ref",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id,
          value: toEntityDocument({
            harmless: reservedRef,
            ref: {
              "/": {
                [LINK_V1_TAG]: {
                  id: "of:target",
                  path: [],
                  schema: "opaque-schema-name",
                },
              },
            },
            $alias: {
              id: "of:legacy-target",
              path: [],
              schema: "opaque-legacy-schema-name",
            },
          }),
        }],
      },
    });

    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:reserved-sync-schema-ref",
          commit: {
            localSeq: 2,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: "entity:reserved-sync-schema-ref-set",
              value: toEntityDocument({
                $alias: {
                  id: "of:target",
                  path: [],
                  schema: reservedRef,
                },
              }),
            }],
          },
        }),
      ProtocolError,
      "reserved wire schema reference",
    );

    applyCommit(engine, {
      sessionId: "session:reserved-sync-schema-ref",
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id,
          patches: [{
            op: "add",
            path: "/value/harmlessPatch",
            value: reservedRef,
          }],
        }],
      },
    });

    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:reserved-sync-schema-ref",
          commit: {
            localSeq: 3,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "patch",
              id,
              patches: [{
                op: "replace",
                path: `/value/ref/~1/${LINK_V1_TAG}/schema`,
                value: reservedRef,
              }],
            }],
          },
        }),
      ProtocolError,
      "reserved wire schema reference",
    );

    for (
      const path of [
        `/value/ref/~1/${LINK_V1_TAG}/schema`,
        "/value/$alias/schema",
      ]
    ) {
      assertThrows(
        () =>
          applyCommit(engine, {
            sessionId: "session:reserved-sync-schema-ref",
            commit: {
              localSeq: 3,
              reads: { confirmed: [], pending: [] },
              operations: [{
                op: "patch",
                id,
                patches: [{
                  op: "move",
                  from: "/value/harmless",
                  path,
                }],
              }],
            },
          }),
        ProtocolError,
        "reserved wire schema reference",
      );
    }

    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:reserved-sync-schema-ref",
          commit: {
            localSeq: 3,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: "entity:reserved-sync-schema-ref-hidden-by-set",
              value: toEntityDocument({
                $alias: {
                  id: "of:target",
                  path: [],
                  schema: reservedRef,
                },
              }),
            }, {
              op: "set",
              id: "entity:reserved-sync-schema-ref-hidden-by-set",
              value: toEntityDocument({ safe: true }),
            }],
          },
        }),
      ProtocolError,
      "reserved wire schema reference",
    );
    assertEquals(
      read(engine, { id: "entity:reserved-sync-schema-ref-hidden-by-set" }),
      null,
    );

    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:reserved-sync-schema-ref",
          commit: {
            localSeq: 3,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "patch",
              id,
              patches: [{
                op: "replace",
                path: `/value/ref/~1/${LINK_V1_TAG}/schema`,
                value: reservedRef,
              }],
            }, {
              op: "delete",
              id,
            }],
          },
        }),
      ProtocolError,
      "reserved wire schema reference",
    );

    // A reserved reference that exists only in a mid-commit state — placed by
    // one patch and cleaned by the next in the same commit — is still stored
    // history (readable at its seq) and must be rejected.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:reserved-sync-schema-ref",
          commit: {
            localSeq: 3,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "patch",
              id,
              patches: [{
                op: "replace",
                path: `/value/ref/~1/${LINK_V1_TAG}/schema`,
                value: reservedRef,
              }],
            }, {
              op: "patch",
              id,
              patches: [{
                op: "replace",
                path: `/value/ref/~1/${LINK_V1_TAG}/schema`,
                value: "opaque-schema-name",
              }],
            }],
          },
        }),
      ProtocolError,
      "reserved wire schema reference",
    );

    assertEquals(
      read(engine, { id }),
      toEntityDocument({
        harmless: reservedRef,
        harmlessPatch: reservedRef,
        ref: {
          "/": {
            [LINK_V1_TAG]: {
              id: "of:target",
              path: [],
              schema: "opaque-schema-name",
            },
          },
        },
        $alias: {
          id: "of:legacy-target",
          path: [],
          schema: "opaque-legacy-schema-name",
        },
      }),
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine replays stateful entities across set and delete revisions", async () => {
  const { engine, path } = await createEngine();
  const reservedRef = "schema-ref@2:sha256:harmless-position";
  const id = "entity:stateful-replay";

  try {
    applyCommit(engine, {
      sessionId: "session:stateful-replay",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id,
          value: toEntityDocument({ base: true }),
        }],
      },
    });

    // One commit whose replay walks every stateful branch without throwing:
    // a candidate patch placing a reserved string in a harmless position,
    // a wholesale set, a follow-up patch, and a tombstoning delete.
    applyCommit(engine, {
      sessionId: "session:stateful-replay",
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id,
          patches: [{
            op: "add",
            path: "/value/harmless",
            value: reservedRef,
          }],
        }, {
          op: "set",
          id,
          value: toEntityDocument({ replaced: true }),
        }, {
          op: "patch",
          id,
          patches: [{
            op: "add",
            path: "/value/afterSet",
            value: "clean",
          }],
        }, {
          op: "delete",
          id,
        }],
      },
    });

    assertEquals(read(engine, { id }), null);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine validates clean moves against snapshot-backed pre-state", async () => {
  const { engine, path } = await createEngineWithOptions({
    snapshotInterval: 1,
  });
  const reservedRef = "schema-ref@2:sha256:snapshot-resident";
  const id = "entity:snapshot-move";

  try {
    applyCommit(engine, {
      sessionId: "session:snapshot-move",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id,
          value: toEntityDocument({
            harmless: reservedRef,
            ref: {
              "/": {
                [LINK_V1_TAG]: {
                  id: "of:target",
                  path: [],
                  schema: "opaque-schema-name",
                },
              },
            },
          }),
        }],
      },
    });
    // Force a snapshot so the clean-move probe reads the snapshot row rather
    // than the base set revision.
    applyCommit(engine, {
      sessionId: "session:snapshot-move",
      invocation: invocationFor(2),
      authorization,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id,
          patches: [{ op: "add", path: "/value/padding", value: "clean" }],
        }],
      },
    });

    // The move commit's own serialization is clean; only the snapshot-backed
    // pre-state carries the reserved string, and relocating it into a schema
    // position must still be rejected.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:snapshot-move",
          invocation: invocationFor(3),
          authorization,
          commit: {
            localSeq: 3,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "patch",
              id,
              patches: [{
                op: "move",
                from: "/value/harmless",
                path: `/value/ref/~1/${LINK_V1_TAG}/schema`,
              }],
            }],
          },
        }),
      ProtocolError,
      "reserved wire schema reference",
    );

    // A clean move between harmless positions over the same snapshot-backed
    // pre-state is allowed.
    applyCommit(engine, {
      sessionId: "session:snapshot-move",
      invocation: invocationFor(3),
      authorization,
      commit: {
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id,
          patches: [{
            op: "move",
            from: "/value/harmless",
            path: "/value/relocated",
          }],
        }],
      },
    });
    const document = read(engine, { id });
    assertEquals(
      (document?.value as Record<string, unknown>).relocated,
      reservedRef,
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine reserves request CAS schema reference strings", async () => {
  const { engine, path } = await createEngine();
  const reservedRef = "schema-cas@1:sha256:user-controlled";
  try {
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:reserved-request-schema-ref",
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: "entity:reserved-request-schema-ref",
              value: toEntityDocument({
                $alias: {
                  id: "of:target",
                  path: [],
                  schema: reservedRef,
                },
              }),
            }],
          },
        }),
      ProtocolError,
      "reserved wire schema reference",
    );
    assertEquals(
      read(engine, { id: "entity:reserved-request-schema-ref" }),
      null,
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine lists live space-scoped entity identifiers", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:alice",
      principal: "did:key:alice",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "set",
            id: "of:fid1:second",
            value: toEntityDocument({ payload: "second" }),
          },
          {
            op: "set",
            id: "of:fid1:first",
            value: toEntityDocument({ payload: "first" }),
          },
          {
            op: "set",
            id: "of:fid1:user-only",
            scope: "user",
            value: toEntityDocument({ payload: "private" }),
          },
        ],
      },
    });

    assertEquals(listEntityIds(engine), [
      "of:fid1:first",
      "of:fid1:second",
    ]);
    assertEquals(listEntityIdPage(engine, { limit: 1 }), ["of:fid1:first"]);
    assertEquals(
      listEntityIdPage(engine, { after: "of:fid1:first", limit: 1 }),
      ["of:fid1:second"],
    );
    assertEquals(entityIdExists(engine, "of:fid1:first"), true);
    assertEquals(entityIdExists(engine, "of:fid1:missing"), false);

    applyCommit(engine, {
      sessionId: "session:alice",
      principal: "did:key:alice",
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "delete", id: "of:fid1:first" }],
      },
    });

    assertEquals(listEntityIds(engine), ["of:fid1:second"]);
    assertEquals(entityIdExists(engine, "of:fid1:first"), false);
    assertEquals(
      engine.database.prepare(`
        SELECT id, scope_key, op
        FROM head
        ORDER BY id, scope_key
      `).all(),
      [
        { id: "of:fid1:first", scope_key: "space", op: "delete" },
        { id: "of:fid1:second", scope_key: "space", op: "set" },
        {
          id: "of:fid1:user-only",
          scope_key: "user:did%3Akey%3Aalice",
          op: "set",
        },
      ],
    );

    const plan = engine.database.prepare(`
      EXPLAIN QUERY PLAN
      SELECT id
      FROM head
      WHERE branch = :branch
        AND scope_key = :scope_key
        AND op <> 'delete'
      ORDER BY id ASC
    `).all({ branch: "", scope_key: "space" }) as Array<{ detail: string }>;
    assertEquals(plan.length, 1);
    assertMatch(
      plan[0].detail,
      /^SEARCH head USING COVERING INDEX idx_head_live_entity_ids /,
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine indexes canonical piece roots and summaries", async () => {
  const space = "did:key:z6Mk-piece-root-index";
  const principal = "did:key:alice";
  const sessionId = "session:piece-root-index";
  const { engine, path } = await createEngineWithOptions({ space });
  const entityIdForCause = (cause: string) =>
    `of:${hashOf({ causal: cause }).taggedHashString}`;
  const spaceCellId = entityIdForCause(space);
  const sourceIdentity = "P".repeat(43);
  const sourceDocumentId = entityIdForCause(`pattern:${sourceIdentity}`);
  const link = (
    id: string,
    scope: "space" | "user" | "session" = "space",
  ) =>
    linkRefFrom({
      id,
      path: [],
      space,
      scope,
    });

  try {
    applyCommit(engine, {
      space,
      principal,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "set",
            id: spaceCellId,
            value: toEntityDocument({
              defaultPattern: link("of:root"),
            }),
          },
          {
            op: "set",
            id: "of:root",
            value: toEntityDocument(
              {
                $NAME: "Home",
                pieceRegistry: link("of:registry"),
              },
              undefined,
              {
                patternIdentity: {
                  identity: sourceIdentity,
                  symbol: "default",
                },
              },
            ),
          },
          {
            op: "set",
            id: "of:registry",
            value: toEntityDocument([
              link("of:wrapper"),
              link("of:registered"),
              link("of:foreign-wrapper"),
            ]),
          },
          {
            op: "set",
            id: "of:wrapper",
            value: toEntityDocument(link("of:registered")),
          },
          {
            op: "set",
            id: "of:foreign-wrapper",
            value: toEntityDocument(linkRefFrom({
              id: "of:foreign-collision",
              path: [],
              space: "did:key:foreign",
              scope: "space",
            })),
          },
          {
            op: "set",
            id: "of:foreign-collision",
            value: toEntityDocument(
              { $NAME: "Local collision" },
              undefined,
              {
                patternIdentity: {
                  identity: "F".repeat(43),
                  symbol: "default",
                },
              },
            ),
          },
          {
            op: "set",
            id: "of:registered",
            value: toEntityDocument(
              {
                $NAME: link("of:registered-name"),
                payload: "secret-document-value",
              },
              undefined,
              {
                patternIdentity: {
                  identity: sourceIdentity,
                  symbol: "default",
                },
                patternRepository: "https://example.test/repository",
                patternSource: "/patterns/notes.tsx",
              },
            ),
          },
          {
            op: "set",
            id: "of:registered-name",
            value: toEntityDocument("Registered"),
          },
          {
            op: "set",
            id: sourceDocumentId,
            value: toEntityDocument({
              kind: "source",
              identity: sourceIdentity,
              filename: "/patterns/notes.tsx",
            }),
          },
          {
            op: "set",
            id: "of:orphan",
            value: toEntityDocument({ $NAME: "Orphan" }, undefined, {
              patternIdentity: {
                identity: "O".repeat(43),
                symbol: "default",
              },
            }),
          },
          {
            op: "set",
            id: "of:argument-only",
            value: toEntityDocument({ $NAME: "Argument only" }, undefined, {
              argument: link("of:argument", "user"),
            }),
          },
          {
            op: "set",
            id: "of:ordinary",
            value: toEntityDocument({ $NAME: "Not a piece" }),
          },
          {
            op: "set",
            id: "of:malformed",
            value: toEntityDocument({ $NAME: "Malformed" }, undefined, {
              patternIdentity: { identity: sourceIdentity },
              argument: { not: "a link" },
            }),
          },
          {
            op: "set",
            id: "of:malformed-link-payload",
            value: toEntityDocument({ $NAME: "Malformed link" }, undefined, {
              argument: {
                "/": { [LINK_V1_TAG]: null },
              } as never,
            }),
          },
          {
            op: "set",
            id: "of:malformed-link-id",
            value: toEntityDocument({ $NAME: "Malformed link" }, undefined, {
              argument: linkRefFrom({
                id: 17,
                path: [],
                space,
                scope: "space",
              } as never),
            }),
          },
          {
            op: "set",
            id: "of:z-growing-name",
            value: toEntityDocument(
              {
                $NAME: linkRefFrom({
                  id: "of:z-growing-name",
                  path: ["$NAME", "x"],
                  space,
                  scope: "space",
                }),
              },
              undefined,
              {
                patternIdentity: {
                  identity: "G".repeat(43),
                  symbol: "default",
                },
              },
            ),
          },
          {
            op: "set",
            id: "of:scoped",
            scope: "user",
            value: toEntityDocument({ $NAME: "User scoped" }, undefined, {
              patternIdentity: {
                identity: "U".repeat(43),
                symbol: "default",
              },
            }),
          },
          {
            op: "set",
            id: "of:scoped",
            scope: "session",
            value: toEntityDocument({ $NAME: "Session scoped" }, undefined, {
              patternIdentity: {
                identity: "S".repeat(43),
                symbol: "default",
              },
            }),
          },
        ],
      },
    });
    applyCommit(engine, {
      space,
      principal: "did:key:bob",
      sessionId: "session:bob-piece-root-index",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:bob-only",
          scope: "user",
          value: toEntityDocument({ $NAME: "Bob only" }, undefined, {
            patternIdentity: {
              identity: "B".repeat(43),
              symbol: "default",
            },
          }),
        }],
      },
    });

    const listed = listPieceRootPage(engine, {
      principal,
      sessionId,
      limit: 20,
    });
    assertEquals(listed.map(({ entry }) => entry.id), [
      "registered",
      "argument-only",
      "foreign-collision",
      "orphan",
      "root",
      "scoped",
      "scoped",
      "z-growing-name",
    ]);
    assertEquals(
      listed.some(({ entry }) => entry.id === "bob-only"),
      false,
    );
    assertEquals(listed[0].entry, {
      id: "registered",
      scope: "space",
      registered: true,
      name: "Registered",
      pattern: {
        identity: sourceIdentity,
        symbol: "default",
        repository: "https://example.test/repository",
        origin: "/patterns/notes.tsx",
        entry: "/patterns/notes.tsx",
      },
    });
    assertEquals(
      listed
        .filter(({ entry }) => entry.id === "scoped")
        .map(({ entry }) => [entry.scope, entry.name]),
      [["user", "User scoped"], ["session", "Session scoped"]],
    );
    assertEquals(
      listPieceRootPage(engine, {
        principal,
        sessionId,
        limit: 20,
        registeredOnly: true,
      }).map(({ entry }) => entry.id),
      ["registered"],
    );
    assertEquals(
      listed.some(({ entry }) => entry.id === "ordinary"),
      false,
    );
    assertEquals(
      listed.some(({ entry }) => entry.id === "malformed"),
      false,
    );
    assertEquals(
      listed.some(({ entry }) => entry.id === "malformed-link-payload"),
      false,
    );
    assertEquals(
      listed.some(({ entry }) => entry.id === "malformed-link-id"),
      false,
    );
    assertEquals(
      listed.find(({ entry }) => entry.id === "z-growing-name")?.entry.name,
      undefined,
    );
    assertEquals(
      listed.find(({ entry }) => entry.id === "foreign-collision")?.entry
        .registered,
      false,
    );

    const firstPage = listPieceRootPage(engine, {
      principal,
      sessionId,
      limit: 2,
    });
    assertEquals(firstPage.map(({ entry }) => entry.id), [
      "registered",
      "argument-only",
    ]);
    assertEquals(firstPage[1].cursor.id, "argument-only");
    assertEquals(typeof firstPage[1].cursor.orderKey, "string");
    assertEquals(
      listPieceRootPage(engine, {
        principal,
        sessionId,
        after: firstPage[1].cursor,
        limit: 20,
      }).map(({ entry }) => entry.id),
      [
        "foreign-collision",
        "orphan",
        "root",
        "scoped",
        "scoped",
        "z-growing-name",
      ],
    );
    const beforeScoped = listed.find(({ entry }) => entry.id === "root")!
      .cursor;
    const userScopedPage = listPieceRootPage(engine, {
      principal,
      sessionId,
      after: beforeScoped,
      limit: 1,
    });
    assertEquals(userScopedPage.map(({ entry }) => entry.scope), ["user"]);
    const sessionScopedPage = listPieceRootPage(engine, {
      principal,
      sessionId,
      after: userScopedPage[0].cursor,
      limit: 1,
    });
    assertEquals(sessionScopedPage.map(({ entry }) => entry.scope), [
      "session",
    ]);
    assertEquals(
      listPieceRootPage(engine, {
        principal,
        sessionId,
        after: sessionScopedPage[0].cursor,
        limit: 1,
      }).map(({ entry }) => entry.id),
      ["z-growing-name"],
    );

    applyCommit(engine, {
      space,
      principal,
      sessionId,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:registered-name",
          value: toEntityDocument("Renamed"),
        }],
      },
    });
    assertEquals(
      listPieceRootPage(engine, {
        principal,
        sessionId,
        limit: 1,
      })[0].entry.name,
      "Renamed",
    );

    applyCommit(engine, {
      space,
      principal,
      sessionId,
      commit: {
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:orphan",
          value: toEntityDocument({ $NAME: "No longer a piece" }),
        }],
      },
    });
    assertEquals(
      listPieceRootPage(engine, {
        principal,
        sessionId,
        limit: 20,
      }).some(({ entry }) => entry.id === "orphan"),
      false,
    );

    const legacyRootValue = {
      $NAME: "Home",
      allPieces: link("of:registry"),
      addPiece: linkRefFrom({
        id: "of:add-piece-stream",
        path: [],
        space,
        scope: "space",
        schema: { asCell: ["stream"] },
      }),
    };
    applyCommit(engine, {
      space,
      principal,
      sessionId,
      commit: {
        localSeq: 4,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:root",
          value: toEntityDocument(legacyRootValue, undefined, {
            patternIdentity: {
              identity: sourceIdentity,
              symbol: "default",
            },
            patternSource: "/patterns/custom-default.tsx",
          }),
        }],
      },
    });
    const registeredIds = () =>
      listPieceRootPage(engine, {
        principal,
        sessionId,
        limit: 20,
        registeredOnly: true,
      }).map(({ entry }) => entry.id);
    assertEquals(registeredIds(), []);

    applyCommit(engine, {
      space,
      principal,
      sessionId,
      commit: {
        localSeq: 5,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:root",
          value: toEntityDocument(legacyRootValue, undefined, {
            patternIdentity: {
              identity: sourceIdentity,
              symbol: "default",
            },
            patternSource: "/api/patterns/system/default-app.tsx",
          }),
        }],
      },
    });
    assertEquals(registeredIds(), ["registered"]);

    applyCommit(engine, {
      space,
      principal,
      sessionId,
      commit: {
        localSeq: 6,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "of:root",
          patches: [{
            op: "replace",
            path: "/patternSource",
            value: "/patterns/custom-default.tsx",
          }],
        }],
      },
    });
    assertEquals(registeredIds(), []);

    applyCommit(engine, {
      space,
      principal,
      sessionId,
      commit: {
        localSeq: 7,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "of:root",
          patches: [{
            op: "replace",
            path: "/patternSource",
            value: "/api/patterns/system/default-app.tsx",
          }],
        }],
      },
    });
    assertEquals(registeredIds(), ["registered"]);

    applyCommit(engine, {
      space,
      principal,
      sessionId,
      commit: {
        localSeq: 8,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "of:root",
          patches: [{
            op: "add",
            path: "/value/pieceRegistry/malformed",
            value: true,
          }],
        }],
      },
    });
    assertEquals(registeredIds(), []);

    applyCommit(engine, {
      space,
      principal,
      sessionId,
      commit: {
        localSeq: 9,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:root",
          value: toEntityDocument(
            {
              ...legacyRootValue,
              pieceRegistry: link("of:empty-registry"),
            },
            undefined,
            {
              patternIdentity: {
                identity: sourceIdentity,
                symbol: "default",
              },
              patternSource: "/api/patterns/system/default-app.tsx",
            },
          ),
        }, {
          op: "set",
          id: "of:empty-registry",
          value: toEntityDocument(undefined),
        }],
      },
    });
    assertEquals(registeredIds(), []);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 piece registry tracks malformed links at partial paths", async () => {
  const space = "did:key:z6Mk-piece-root-partial-registry-link";
  const sessionId = "session:piece-root-partial-registry-link";
  const { engine, path } = await createEngineWithOptions({ space });
  const spaceCellId = `of:${hashOf({ causal: space }).taggedHashString}`;
  const link = (id: string, linkPath: string[] = []) =>
    linkRefFrom({ id, path: linkPath, space, scope: "space" });
  const pieceDocument = (identity: string, value: unknown) =>
    toEntityDocument(value, undefined, {
      patternIdentity: { identity, symbol: "default" },
    });

  try {
    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "set",
            id: spaceCellId,
            value: toEntityDocument({ defaultPattern: link("of:home") }),
          },
          {
            op: "set",
            id: "of:home",
            value: pieceDocument("H".repeat(43), {
              pieceRegistry: link("of:registry"),
            }),
          },
          {
            op: "set",
            id: "of:registry",
            value: toEntityDocument([
              link("of:wrapper", ["alias", "tail"]),
            ]),
          },
          {
            op: "set",
            id: "of:wrapper",
            value: pieceDocument("W".repeat(43), {
              alias: linkRefFrom({
                id: 17,
                path: [],
                space,
                scope: "space",
              } as never),
            }),
          },
          {
            op: "set",
            id: "of:actual",
            value: pieceDocument("A".repeat(43), { tail: {} }),
          },
        ],
      },
    });
    const registeredIds = () =>
      listPieceRootPage(engine, {
        sessionId,
        limit: 10,
        registeredOnly: true,
      }).map(({ entry }) => entry.id);
    assertEquals(registeredIds(), ["wrapper"]);

    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "of:wrapper",
          patches: [{
            op: "replace",
            path: `/value/alias/~1/${LINK_V1_TAG}/id`,
            value: "of:actual",
          }],
        }],
      },
    });
    assertEquals(registeredIds(), ["actual"]);

    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "of:wrapper",
          patches: [{
            op: "add",
            path: "/value/alias/extra",
            value: true,
          }],
        }],
      },
    });
    assertEquals(registeredIds(), ["wrapper"]);

    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 4,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "of:wrapper",
          patches: [{
            op: "remove",
            path: "/value/alias/extra",
          }],
        }],
      },
    });
    assertEquals(registeredIds(), ["actual"]);

    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 5,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "of:wrapper",
          patches: [{
            op: "replace",
            path: "/value/alias",
            value: { "/": 1 },
          }],
        }],
      },
    });
    assertEquals(registeredIds(), ["wrapper"]);

    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 6,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "of:wrapper",
          patches: [{
            op: "replace",
            path: "/value/alias/~1",
            value: {
              [LINK_V1_TAG]: {
                id: "of:actual",
                path: [],
                space,
                scope: "space",
              },
            },
          }],
        }],
      },
    });
    assertEquals(registeredIds(), ["actual"]);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 piece registry tracks shifted wrapper paths", async () => {
  const space = "did:key:z6Mk-piece-root-shifted-registry-path";
  const sessionId = "session:piece-root-shifted-registry-path";
  const { engine, path } = await createEngineWithOptions({ space });
  const spaceCellId = `of:${hashOf({ causal: space }).taggedHashString}`;
  const link = (id: string, linkPath: string[] = []) =>
    linkRefFrom({ id, path: linkPath, space, scope: "space" });
  const pieceDocument = (identity: string, value: unknown = {}) =>
    toEntityDocument(value, undefined, {
      patternIdentity: { identity, symbol: "default" },
    });

  try {
    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "set",
            id: spaceCellId,
            value: toEntityDocument({ defaultPattern: link("of:home") }),
          },
          {
            op: "set",
            id: "of:home",
            value: pieceDocument("H".repeat(43), {
              pieceRegistry: link("of:registry"),
            }),
          },
          {
            op: "set",
            id: "of:registry",
            value: toEntityDocument([
              link("of:wrapper", ["items", "1"]),
            ]),
          },
          {
            op: "set",
            id: "of:wrapper",
            value: pieceDocument("W".repeat(43), {
              items: [link("of:a"), link("of:b"), link("of:c")],
            }),
          },
          {
            op: "set",
            id: "of:a",
            value: pieceDocument("A".repeat(43)),
          },
          {
            op: "set",
            id: "of:b",
            value: pieceDocument("B".repeat(43)),
          },
          {
            op: "set",
            id: "of:c",
            value: pieceDocument("C".repeat(43)),
          },
        ],
      },
    });
    const registeredIds = () =>
      listPieceRootPage(engine, {
        sessionId,
        limit: 10,
        registeredOnly: true,
      }).map(({ entry }) => entry.id);
    assertEquals(registeredIds(), ["b"]);

    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "of:wrapper",
          patches: [{
            op: "remove",
            path: "/value/items/0",
          }],
        }],
      },
    });
    assertEquals(registeredIds(), ["c"]);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 piece registry pages dependency paths on one document", async () => {
  const space = "did:key:z6Mk-piece-root-registry-path-pages";
  const sessionId = "session:piece-root-registry-path-pages";
  const { engine, path } = await createEngineWithOptions({ space });
  const spaceCellId = `of:${hashOf({ causal: space }).taggedHashString}`;
  const registrySize = 300;
  const keys = Array.from(
    { length: registrySize },
    (_, index) => index.toString().padStart(4, "0"),
  );
  const link = (id: string, linkPath: string[] = []) =>
    linkRefFrom({ id, path: linkPath, space, scope: "space" });
  const pieceDocument = (identity: string, value: unknown = {}) =>
    toEntityDocument(value, undefined, {
      patternIdentity: {
        identity: identity.padEnd(43, "P"),
        symbol: "default",
      },
    });

  try {
    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "set",
            id: spaceCellId,
            value: toEntityDocument({ defaultPattern: link("of:home") }),
          },
          {
            op: "set",
            id: "of:home",
            value: pieceDocument("home", {
              pieceRegistry: keys.map((key) =>
                link("of:wrapper", ["items", key])
              ),
            }),
          },
          {
            op: "set",
            id: "of:wrapper",
            value: toEntityDocument({
              items: Object.fromEntries(
                keys.map((key) => [key, link(`of:root-${key}`)]),
              ),
            }),
          },
          ...keys.map((key) => ({
            op: "set" as const,
            id: `of:root-${key}`,
            value: pieceDocument(key),
          })),
          {
            op: "set",
            id: "of:replacement",
            value: pieceDocument("replacement"),
          },
        ],
      },
    });
    const registeredIds = () =>
      listPieceRootPage(engine, {
        sessionId,
        limit: registrySize + 1,
        registeredOnly: true,
      }).map(({ entry }) => entry.id);
    assertEquals(registeredIds().at(-1), "root-0299");
    assertEquals(
      engine.database.prepare(`
SELECT COUNT(*) AS count
FROM pragma_piece_registry_dependency
WHERE dependency_id = 'of:wrapper'
  AND dependency_scope_key = 'space'
`).get(),
      { count: registrySize },
    );

    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "of:wrapper",
          patches: [{
            op: "replace",
            path: "/value/items/0299",
            value: link("of:replacement"),
          }],
        }],
      },
    });
    const updatedIds = registeredIds();
    assertEquals(updatedIds.length, registrySize);
    assertEquals(updatedIds.at(-1), "replacement");
    assertEquals(updatedIds.includes("root-0299"), false);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 piece registry tracks shifted terminal arrays", async () => {
  const space = "did:key:z6Mk-piece-root-shifted-registry-array";
  const sessionId = "session:piece-root-shifted-registry-array";
  const { engine, path } = await createEngineWithOptions({ space });
  const spaceCellId = `of:${hashOf({ causal: space }).taggedHashString}`;
  const link = (id: string, linkPath: string[] = []) =>
    linkRefFrom({ id, path: linkPath, space, scope: "space" });
  const pieceDocument = (identity: string, value: unknown = {}) =>
    toEntityDocument(value, undefined, {
      patternIdentity: { identity, symbol: "default" },
    });

  try {
    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "set",
            id: spaceCellId,
            value: toEntityDocument({ defaultPattern: link("of:home") }),
          },
          {
            op: "set",
            id: "of:home",
            value: pieceDocument("H".repeat(43), {
              pieceRegistry: link("of:wrapper", ["items", "1"]),
            }),
          },
          {
            op: "set",
            id: "of:wrapper",
            value: toEntityDocument({
              items: [
                "padding",
                [link("of:a")],
                [link("of:b")],
              ],
            }),
          },
          {
            op: "set",
            id: "of:a",
            value: pieceDocument("A".repeat(43)),
          },
          {
            op: "set",
            id: "of:b",
            value: pieceDocument("B".repeat(43)),
          },
        ],
      },
    });
    const registeredIds = () =>
      listPieceRootPage(engine, {
        sessionId,
        limit: 10,
        registeredOnly: true,
      }).map(({ entry }) => entry.id);
    assertEquals(registeredIds(), ["a"]);

    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "of:wrapper",
          patches: [{
            op: "remove",
            path: "/value/items/0",
          }],
        }],
      },
    });
    assertEquals(registeredIds(), ["b"]);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 registry tails re-resolve wrappers into the new tail", async () => {
  const space = "did:key:z6Mk-piece-root-registry-tail-wrapper";
  const sessionId = "session:piece-root-registry-tail-wrapper";
  const { engine, path } = await createEngineWithOptions({ space });
  const spaceCellId = `of:${hashOf({ causal: space }).taggedHashString}`;
  const link = (id: string, linkPath: string[] = []) =>
    linkRefFrom({ id, path: linkPath, space, scope: "space" });
  const pieceDocument = (identity: string, value: unknown = {}) =>
    toEntityDocument(value, undefined, {
      patternIdentity: { identity, symbol: "default" },
    });

  try {
    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "set",
            id: spaceCellId,
            value: toEntityDocument({ defaultPattern: link("of:home") }),
          },
          {
            op: "set",
            id: "of:home",
            value: pieceDocument("H".repeat(43), {
              pieceRegistry: link("of:registry"),
            }),
          },
          {
            op: "set",
            id: "of:registry",
            value: pieceDocument("R".repeat(43), [
              link("of:registry", ["1"]),
            ]),
          },
          {
            op: "set",
            id: "of:b",
            value: pieceDocument("B".repeat(43)),
          },
        ],
      },
    });
    const registeredIds = () =>
      listPieceRootPage(engine, {
        sessionId,
        limit: 10,
        registeredOnly: true,
      }).map(({ entry }) => entry.id);
    assertEquals(registeredIds(), ["registry"]);

    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "of:registry",
          patches: [{
            op: "append",
            path: "/value",
            values: [link("of:b")],
          }],
        }],
      },
    });
    assertEquals(registeredIds(), ["b"]);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 legacy registry tracks nested stream markers", async () => {
  const space = "did:key:z6Mk-piece-root-legacy-stream-marker";
  const sessionId = "session:piece-root-legacy-stream-marker";
  const { engine, path } = await createEngineWithOptions({ space });
  const spaceCellId = `of:${hashOf({ causal: space }).taggedHashString}`;
  const link = (id: string, linkPath: string[] = []) =>
    linkRefFrom({ id, path: linkPath, space, scope: "space" });

  try {
    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "set",
            id: spaceCellId,
            value: toEntityDocument({ defaultPattern: link("of:home") }),
          },
          {
            op: "set",
            id: "of:home",
            value: toEntityDocument(
              {
                allPieces: link("of:registry"),
                addPiece: { $stream: false },
              },
              undefined,
              {
                patternIdentity: {
                  identity: "H".repeat(43),
                  symbol: "default",
                },
                patternSource: "/api/patterns/system/default-app.tsx",
              },
            ),
          },
          {
            op: "set",
            id: "of:registry",
            value: toEntityDocument([
              link("of:home", ["pieceRegistry"]),
              link("of:piece"),
            ]),
          },
          {
            op: "set",
            id: "of:piece",
            value: toEntityDocument({}, undefined, {
              patternIdentity: {
                identity: "P".repeat(43),
                symbol: "default",
              },
            }),
          },
        ],
      },
    });
    const registeredIds = () =>
      listPieceRootPage(engine, {
        sessionId,
        limit: 10,
        registeredOnly: true,
      }).map(({ entry }) => entry.id);
    assertEquals(registeredIds(), []);

    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "of:home",
          patches: [{
            op: "replace",
            path: "/value/addPiece/$stream",
            value: true,
          }],
        }],
      },
    });
    assertEquals(registeredIds(), ["home", "piece"]);

    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "of:home",
          patches: [{
            op: "add",
            path: "/value/pieceRegistry/malformed",
            value: true,
          }],
        }],
      },
    });
    assertEquals(registeredIds(), []);

    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 4,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "of:home",
          patches: [{
            op: "remove",
            path: "/value/pieceRegistry",
          }],
        }],
      },
    });
    assertEquals(registeredIds(), ["home", "piece"]);

    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 5,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "of:home",
          patches: [{
            op: "replace",
            path: "/value/addPiece/$stream",
            value: false,
          }],
        }],
      },
    });
    assertEquals(registeredIds(), []);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 registry tails refresh colocated root summaries", async () => {
  const space = "did:key:z6Mk-piece-root-colocated-registry";
  const sessionId = "session:piece-root-colocated-registry";
  const { engine, path } = await createEngineWithOptions({ space });
  const spaceCellId = `of:${hashOf({ causal: space }).taggedHashString}`;
  const link = (id: string, linkPath: string[] = []) =>
    linkRefFrom({ id, path: linkPath, space, scope: "space" });

  try {
    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "set",
            id: spaceCellId,
            value: toEntityDocument({ defaultPattern: link("of:home") }),
          },
          {
            op: "set",
            id: "of:home",
            value: toEntityDocument(
              {
                $NAME: link("of:home", ["pieceRegistry", "1"]),
                pieceRegistry: [link("of:piece")],
              },
              undefined,
              {
                patternIdentity: {
                  identity: "H".repeat(43),
                  symbol: "default",
                },
              },
            ),
          },
          {
            op: "set",
            id: "of:piece",
            value: toEntityDocument({}, undefined, {
              patternIdentity: {
                identity: "P".repeat(43),
                symbol: "default",
              },
            }),
          },
        ],
      },
    });
    const home = () =>
      listPieceRootPage(engine, {
        sessionId,
        limit: 10,
      }).find(({ entry }) => entry.id === "home")?.entry;
    assertEquals(home()?.name, undefined);

    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "of:home",
          patches: [{
            op: "append",
            path: "/value/pieceRegistry",
            values: ["Home from registry tail"],
          }],
        }],
      },
    });
    assertEquals(home()?.name, "Home from registry tail");
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 registry tail batches summarize their final document", async () => {
  const space = "did:key:z6Mk-piece-root-registry-tail-batch";
  const sessionId = "session:piece-root-registry-tail-batch";
  const { engine, path } = await createEngineWithOptions({ space });
  const spaceCellId = `of:${hashOf({ causal: space }).taggedHashString}`;
  const link = (id: string, linkPath: string[] = []) =>
    linkRefFrom({ id, path: linkPath, space, scope: "space" });
  const pieceDocument = (identity: string, value: unknown = {}) =>
    toEntityDocument(value, undefined, {
      patternIdentity: { identity, symbol: "default" },
    });

  try {
    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "set",
            id: spaceCellId,
            value: toEntityDocument({ defaultPattern: link("of:home") }),
          },
          {
            op: "set",
            id: "of:home",
            value: pieceDocument("H".repeat(43), {
              pieceRegistry: link("of:registry", ["items"]),
            }),
          },
          {
            op: "set",
            id: "of:registry",
            value: toEntityDocument({ items: [link("of:piece")] }),
          },
          {
            op: "set",
            id: "of:piece",
            value: pieceDocument("P".repeat(43)),
          },
        ],
      },
    });

    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "set",
            id: "of:registry",
            value: pieceDocument("R".repeat(43), {
              $NAME: link("of:registry", ["items", "1"]),
              items: [link("of:piece")],
            }),
          },
          {
            op: "patch",
            id: "of:registry",
            patches: [{
              op: "append",
              path: "/value/items",
              values: ["Final registry name"],
            }],
          },
        ],
      },
    });
    assertEquals(
      listPieceRootPage(engine, {
        sessionId,
        limit: 10,
      }).find(({ entry }) => entry.id === "registry")?.entry.name,
      "Final registry name",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine backfills piece roots with the owning space", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const url = toFileUrl(path);
  const space = "did:key:z6Mk-piece-root-backfill";
  const principal = "did:key:alice";
  const sessionId = "session:piece-root-backfill";
  const linkedName = linkRefFrom({
    id: "of:backfilled-name",
    path: [],
    space,
    scope: "space",
  });
  let engine: Engine | undefined;

  try {
    engine = await open({ url });
    applyCommit(engine, {
      space,
      principal,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:backfilled-piece",
          value: toEntityDocument({ $NAME: linkedName }, undefined, {
            patternIdentity: {
              identity: "P".repeat(43),
              symbol: "default",
            },
          }),
        }, {
          op: "set",
          id: "of:backfilled-name",
          value: toEntityDocument("Backfilled"),
        }],
      },
    });
    assertEquals(
      listPieceRootPage(engine, {
        principal,
        sessionId,
        limit: 10,
      })[0].entry.name,
      "Backfilled",
    );

    engine.database.exec(`
DROP TABLE pragma_piece_root_dependency;
DROP TABLE pragma_piece_registry_dependency;
DROP TABLE pragma_piece_root;
DROP TABLE pragma_piece_root_index_state;
`);
    close(engine);
    engine = undefined;
    engine = await open({ url });
    assertEquals(
      listPieceRootPage(engine, {
        principal,
        sessionId,
        limit: 10,
      })[0].entry.name,
      undefined,
    );

    close(engine);
    engine = undefined;
    engine = await open({ url, space });
    assertEquals(
      listPieceRootPage(engine, {
        principal,
        sessionId,
        limit: 10,
      })[0].entry.name,
      "Backfilled",
    );

    engine.database.exec(`
DROP TABLE pragma_piece_root_dependency;
DROP TABLE pragma_piece_registry_dependency;
DROP TABLE pragma_piece_root;
DROP TABLE pragma_piece_root_index_state;
`);
    close(engine);
    engine = undefined;
    engine = await open({ url, space });
    assertEquals(
      listPieceRootPage(engine, {
        principal,
        sessionId,
        limit: 10,
      })[0].entry.name,
      "Backfilled",
    );
  } finally {
    if (engine !== undefined) close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine migrates registry dependency paths", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const url = toFileUrl(path);
  const space = "did:key:z6Mk-piece-root-registry-dependency-migration";
  const sessionId = "session:piece-root-registry-dependency-migration";
  let engine: Engine | undefined;

  try {
    engine = await open({ url, space });
    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:migrated-piece",
          value: toEntityDocument({}, undefined, {
            patternIdentity: {
              identity: "M".repeat(43),
              symbol: "default",
            },
          }),
        }],
      },
    });
    engine.database.exec(`
DROP TABLE pragma_piece_registry_dependency;
CREATE TABLE pragma_piece_registry_dependency (
  branch                TEXT NOT NULL,
  dependency_id         TEXT NOT NULL,
  dependency_scope_key  TEXT NOT NULL,
  PRIMARY KEY (branch, dependency_id, dependency_scope_key)
);
UPDATE pragma_piece_root_index_state SET version = 5 WHERE singleton = 1;
`);
    close(engine);
    engine = undefined;

    engine = await open({ url, space });
    assertEquals(
      listPieceRootPage(engine, {
        sessionId,
        limit: 10,
      }).map(({ entry }) => entry.id),
      ["migrated-piece"],
    );
    assertEquals(
      (engine.database.prepare(`
PRAGMA table_info(pragma_piece_registry_dependency)
`).all() as Array<{ name: string }>).map(({ name }) => name),
      [
        "dependency_id",
        "dependency_scope_key",
        "dependency_path",
        "dependency_kind",
      ],
    );
    assertEquals(
      engine.database.prepare(`
SELECT version FROM pragma_piece_root_index_state WHERE singleton = 1
`).get(),
      { version: 9 },
    );
  } finally {
    if (engine !== undefined) close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine replaces prerelease piece index tables", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const url = toFileUrl(path);
  const space = "did:key:z6Mk-piece-root-prerelease-index";
  const sessionId = "session:piece-root-prerelease-index";
  let engine: Engine | undefined;

  try {
    engine = await open({ url, space });
    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:piece",
          value: toEntityDocument({}, undefined, {
            patternIdentity: {
              identity: "P".repeat(43),
              symbol: "default",
            },
          }),
        }],
      },
    });
    engine.database.exec(`
ALTER TABLE pragma_piece_root_dependency RENAME TO piece_root_dependency;
ALTER TABLE pragma_piece_registry_dependency
  RENAME TO piece_registry_dependency;
ALTER TABLE pragma_piece_root RENAME TO piece_root;
ALTER TABLE pragma_piece_root_index_state RENAME TO piece_root_index_state;
`);
    close(engine);
    engine = undefined;

    engine = await open({ url, space });
    assertEquals(
      listPieceRootPage(engine, { sessionId, limit: 10 }).map(({ entry }) =>
        entry.id
      ),
      ["piece"],
    );
    assertEquals(
      engine.database.prepare(`
SELECT name
FROM sqlite_schema
WHERE type = 'table'
  AND name IN (
    'piece_registry_dependency',
    'piece_root',
    'piece_root_dependency',
    'piece_root_index_state'
  )
ORDER BY name
`).all(),
      [],
    );
  } finally {
    if (engine !== undefined) close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine rebuilds a stale piece index after rollback writes", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const url = toFileUrl(path);
  const space = "did:key:z6Mk-piece-root-rollback-watermark";
  const sessionId = "session:piece-root-rollback-watermark";
  const pieceDocument = (identity: string) =>
    toEntityDocument({}, undefined, {
      patternIdentity: { identity, symbol: "default" },
    });
  let engine: Engine | undefined;

  try {
    engine = await open({ url, space });
    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:a",
          value: pieceDocument("A".repeat(43)),
        }],
      },
    });
    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:b",
          value: pieceDocument("B".repeat(43)),
        }],
      },
    });
    engine.database.exec(`
DELETE FROM pragma_piece_root_dependency
WHERE piece_id = 'of:b';
DELETE FROM pragma_piece_root
WHERE id = 'of:b';
UPDATE pragma_piece_root_index_state
SET indexed_commit_seq = 1
WHERE singleton = 1;
`);
    close(engine);
    engine = undefined;

    engine = await open({ url, space });
    assertEquals(
      listPieceRootPage(engine, { sessionId, limit: 10 }).map(({ entry }) =>
        entry.id
      ),
      ["a", "b"],
    );
    assertEquals(
      engine.database.prepare(`
SELECT version, indexed_commit_seq
FROM pragma_piece_root_index_state
WHERE singleton = 1
`).get(),
      { version: 9, indexed_commit_seq: 2 },
    );
  } finally {
    if (engine !== undefined) close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine defers piece index writes until the first read", async () => {
  const space = "did:key:z6Mk-piece-root-deferred-write";
  const sessionId = "session:piece-root-deferred-write";
  const { engine, path } = await createEngineWithOptions({ space });

  try {
    let rejectedIndexWrites = 0;
    engine.database.function("reject_piece_index", () => {
      rejectedIndexWrites++;
      throw new Error("deferred piece index write");
    });
    engine.database.exec(`
CREATE TRIGGER reject_piece_root_insert
BEFORE INSERT ON pragma_piece_root
BEGIN
  SELECT reject_piece_index();
END;
`);
    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:deferred",
          value: toEntityDocument(
            { $NAME: "Deferred" },
            undefined,
            {
              patternIdentity: {
                identity: "D".repeat(43),
                symbol: "default",
              },
            },
          ),
        }],
      },
    });
    assertEquals(rejectedIndexWrites, 0);
    assertEquals(
      engine.database.prepare(`
SELECT indexed_commit_seq
FROM pragma_piece_root_index_state
WHERE singleton = 1
`).get(),
      undefined,
    );
    assertEquals(
      engine.database.prepare(`
SELECT COUNT(*) AS count
FROM pragma_piece_root
`).get(),
      { count: 0 },
    );

    assertThrows(
      () => listPieceRootPage(engine, { sessionId, limit: 10 }),
      Error,
    );
    assertEquals(rejectedIndexWrites, 1);
    assertEquals(
      engine.database.prepare(`
SELECT indexed_commit_seq
FROM pragma_piece_root_index_state
WHERE singleton = 1
`).get(),
      undefined,
    );

    engine.database.exec(`DROP TRIGGER reject_piece_root_insert`);
    assertEquals(
      listPieceRootPage(engine, { sessionId, limit: 10 }).map(({ entry }) =>
        entry
      ),
      [{
        id: "deferred",
        scope: "space",
        registered: false,
        name: "Deferred",
        pattern: {
          identity: "D".repeat(43),
          symbol: "default",
        },
      }],
    );
    assertEquals(
      engine.database.prepare(`
SELECT indexed_commit_seq
FROM pragma_piece_root_index_state
WHERE singleton = 1
`).get(),
      { indexed_commit_seq: 1 },
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine coalesces pending root writes during catch-up", async () => {
  const space = "did:key:z6Mk-piece-root-coalesced-write";
  const sessionId = "session:piece-root-coalesced-write";
  const { engine, path } = await createEngineWithOptions({ space });
  const document = (name: string) =>
    toEntityDocument(
      { $NAME: name },
      undefined,
      {
        patternIdentity: {
          identity: "C".repeat(43),
          symbol: "default",
        },
      },
    );

  try {
    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:coalesced",
          value: document("Initial"),
        }],
      },
    });
    listPieceRootPage(engine, { sessionId, limit: 10 });
    engine.database.exec(`
CREATE TABLE piece_root_write_audit (
  count INTEGER NOT NULL
);
INSERT INTO piece_root_write_audit (count) VALUES (0);
CREATE TRIGGER audit_piece_root_update
AFTER UPDATE ON pragma_piece_root
BEGIN
  UPDATE piece_root_write_audit SET count = count + 1;
END;
`);

    for (let localSeq = 2; localSeq <= 301; localSeq++) {
      applyCommit(engine, {
        space,
        sessionId,
        commit: {
          localSeq,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:coalesced",
            value: document(`Final ${localSeq}`),
          }],
        },
      });
    }
    assertEquals(
      engine.database.prepare(`
SELECT indexed_commit_seq
FROM pragma_piece_root_index_state
WHERE singleton = 1
`).get(),
      { indexed_commit_seq: 1 },
    );
    assertEquals(
      engine.database.prepare(`
SELECT name
FROM pragma_piece_root
WHERE id = 'of:coalesced'
`).get(),
      { name: "Initial" },
    );

    assertEquals(
      listPieceRootPage(engine, { sessionId, limit: 10 })[0].entry.name,
      "Final 301",
    );
    assertEquals(
      engine.database.prepare(`
SELECT count
FROM piece_root_write_audit
`).get(),
      { count: 1 },
    );
    assertEquals(
      engine.database.prepare(`
SELECT indexed_commit_seq
FROM pragma_piece_root_index_state
WHERE singleton = 1
`).get(),
      { indexed_commit_seq: 301 },
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine merges high-fanout root summary refreshes", async () => {
  const space = "did:key:z6Mk-piece-root-high-fanout";
  const sessionId = "session:piece-root-high-fanout";
  const { engine, path } = await createEngineWithOptions({ space });
  const rootCount = 1_025;
  const patternIdentity = "H".repeat(43);
  const sourceId = `of:${
    hashOf({ causal: `pattern:${patternIdentity}` }).taggedHashString
  }`;
  const sharedName = linkRefFrom({
    id: "of:shared-piece-name",
    path: [],
    space,
    scope: "space",
  });

  try {
    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "set",
            id: "of:shared-piece-name",
            value: toEntityDocument("Initial"),
          },
          {
            op: "set",
            id: sourceId,
            value: toEntityDocument({
              kind: "source",
              identity: patternIdentity,
              filename: "/initial.tsx",
            }),
          },
          ...Array.from({ length: rootCount }, (_, index) => ({
            op: "set" as const,
            id: `of:shared-name-root-${index.toString().padStart(4, "0")}`,
            value: toEntityDocument(
              { $NAME: sharedName },
              undefined,
              {
                patternIdentity: {
                  identity: patternIdentity,
                  symbol: "default",
                },
              },
            ),
          })),
        ],
      },
    });
    listPieceRootPage(engine, { sessionId, limit: 1 });
    engine.database.exec(`
CREATE TABLE piece_root_fanout_audit (
  count INTEGER NOT NULL
);
INSERT INTO piece_root_fanout_audit (count) VALUES (0);
CREATE TRIGGER audit_piece_root_fanout_update
AFTER UPDATE OF name ON pragma_piece_root
BEGIN
  UPDATE piece_root_fanout_audit SET count = count + 1;
END;
`);

    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "set",
            id: "of:shared-piece-name",
            value: toEntityDocument("Updated"),
          },
          {
            op: "set",
            id: sourceId,
            value: toEntityDocument({
              kind: "source",
              identity: patternIdentity,
              filename: "/updated.tsx",
            }),
          },
        ],
      },
    });
    listPieceRootPage(engine, { sessionId, limit: 1 });

    assertEquals(
      engine.database.prepare(`
SELECT COUNT(*) AS count
FROM pragma_piece_root
WHERE name = 'Updated'
  AND pattern_entry = '/updated.tsx'
`).get(),
      { count: rootCount },
    );
    assertEquals(
      engine.database.prepare(`
SELECT count
FROM piece_root_fanout_audit
`).get(),
      { count: rootCount },
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine refreshes each root once across changed-head pages", async () => {
  const space = "did:key:z6Mk-piece-root-changed-name-chain";
  const sessionId = "session:piece-root-changed-name-chain";
  const { engine, path } = await createEngineWithOptions({ space });
  const rootCount = 300;
  const chainLength = 20;
  const interveningChanges = 300;
  const link = (id: string) =>
    linkRefFrom({ id, path: [], space, scope: "space" });
  const chainDocument = (index: number, finalName: string) =>
    toEntityDocument(
      index === chainLength - 1
        ? finalName
        : link(`of:shared-name-${index + 1}`),
    );
  const rootDocument = () =>
    toEntityDocument(
      { $NAME: link("of:shared-name-0") },
      undefined,
      {
        patternIdentity: {
          identity: "N".repeat(43),
          symbol: "default",
        },
      },
    );

  try {
    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          ...Array.from({ length: chainLength }, (_, index) => ({
            op: "set" as const,
            id: `of:shared-name-${index}`,
            value: chainDocument(index, "Initial"),
          })),
          ...Array.from({ length: rootCount }, (_, index) => ({
            op: "set" as const,
            id: `of:name-chain-root-${index.toString().padStart(3, "0")}`,
            value: rootDocument(),
          })),
        ],
      },
    });
    listPieceRootPage(engine, { sessionId, limit: 1 });
    engine.database.exec(`
CREATE TABLE piece_root_name_chain_audit (
  count INTEGER NOT NULL
);
INSERT INTO piece_root_name_chain_audit (count) VALUES (0);
CREATE TRIGGER audit_piece_root_name_chain_update
AFTER UPDATE OF name ON pragma_piece_root
BEGIN
  UPDATE piece_root_name_chain_audit SET count = count + 1;
END;
`);

    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "set",
            id: "of:shared-name-0",
            value: chainDocument(0, "Updated"),
          },
          {
            op: "set",
            id: "of:name-chain-root-000",
            value: rootDocument(),
          },
          ...Array.from({ length: interveningChanges }, (_, index) => ({
            op: "set" as const,
            id: `of:intervening-${index.toString().padStart(3, "0")}`,
            value: toEntityDocument({ index }),
          })),
          ...Array.from({ length: chainLength - 1 }, (_, offset) => {
            const index = offset + 1;
            return {
              op: "set" as const,
              id: `of:shared-name-${index}`,
              value: chainDocument(index, "Updated"),
            };
          }),
        ],
      },
    });
    listPieceRootPage(engine, { sessionId, limit: 1 });

    assertEquals(
      engine.database.prepare(`
SELECT COUNT(*) AS count
FROM pragma_piece_root
WHERE name = 'Updated'
`).get(),
      { count: rootCount },
    );
    assertEquals(
      engine.database.prepare(`
SELECT count
FROM piece_root_name_chain_audit
`).get(),
      { count: rootCount },
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine bounds broad dependency catch-up with a root scan", async () => {
  const space = "did:key:z6Mk-piece-root-broad-dependency-catch-up";
  const sessionId = "session:piece-root-broad-dependency-catch-up";
  const { engine, path } = await createEngineWithOptions({ space });
  const rootCount = 300;
  const link = (id: string) =>
    linkRefFrom({ id, path: [], space, scope: "space" });

  try {
    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: Array.from({ length: rootCount }, (_, index) => [
          {
            op: "set" as const,
            id: `of:broad-name-${index.toString().padStart(3, "0")}`,
            value: toEntityDocument("Initial"),
          },
          {
            op: "set" as const,
            id: `of:broad-root-${index.toString().padStart(3, "0")}`,
            value: toEntityDocument(
              {
                $NAME: link(
                  `of:broad-name-${index.toString().padStart(3, "0")}`,
                ),
              },
              undefined,
              {
                patternIdentity: {
                  identity: "B".repeat(43),
                  symbol: "default",
                },
              },
            ),
          },
        ]).flat(),
      },
    });
    listPieceRootPage(engine, { sessionId, limit: 1 });
    engine.database.exec(`
CREATE TABLE piece_root_broad_catch_up_audit (
  count INTEGER NOT NULL
);
INSERT INTO piece_root_broad_catch_up_audit (count) VALUES (0);
CREATE TRIGGER audit_piece_root_broad_catch_up
AFTER UPDATE OF name ON pragma_piece_root
BEGIN
  UPDATE piece_root_broad_catch_up_audit SET count = count + 1;
END;
`);

    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: Array.from({ length: rootCount }, (_, index) => ({
          op: "set" as const,
          id: `of:broad-name-${index.toString().padStart(3, "0")}`,
          value: toEntityDocument("Updated"),
        })),
      },
    });
    listPieceRootPage(engine, { sessionId, limit: 1 });

    assertEquals(
      engine.database.prepare(`
SELECT COUNT(*) AS count
FROM pragma_piece_root
WHERE name = 'Updated'
`).get(),
      { count: rootCount },
    );
    assertEquals(
      engine.database.prepare(`
SELECT count
FROM piece_root_broad_catch_up_audit
`).get(),
      { count: rootCount },
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 piece root IDs preserve URI kind without exposing data URIs", async () => {
  const space = "did:key:z6Mk-piece-root-uri-kinds";
  const sessionId = "session:piece-root-uri-kinds";
  const { engine, path } = await createEngineWithOptions({ space });
  const dataId = "data:text/plain,PIECE_ROOT_INLINE_SECRET_7e28325d47e74eaf";
  const sameCanonicalId = "fid1:same-piece-root";
  const patternIdentity = {
    identity: "K".repeat(43),
    symbol: "default",
  };

  try {
    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "set",
            id: `of:${sameCanonicalId}`,
            value: toEntityDocument({}, undefined, { patternIdentity }),
          },
          {
            op: "set",
            id: `computed:${sameCanonicalId}`,
            value: toEntityDocument({}, undefined, { patternIdentity }),
          },
          {
            op: "set",
            id: dataId,
            value: toEntityDocument({}, undefined, { patternIdentity }),
          },
          {
            op: "set",
            id: "of:urn:piece",
            value: toEntityDocument({}, undefined, { patternIdentity }),
          },
          {
            op: "set",
            id: "urn:piece",
            value: toEntityDocument({}, undefined, { patternIdentity }),
          },
        ],
      },
    });

    const listed = listPieceRootPage(engine, {
      sessionId,
      limit: 10,
    });
    assertEquals(
      listed
        .filter(({ entry }) => entry.id === sameCanonicalId)
        .map(({ entry }) => entry.entityKind ?? "of")
        .sort(),
      ["computed", "of"],
    );
    assertEquals(
      listed
        .filter(({ entry }) => entry.id === "urn:piece")
        .map(({ entry }) => entry.entityKind ?? "of")
        .sort(),
      ["of", "urn"],
    );
    assertEquals(
      listed.find(({ entry }) => entry.entityKind === "data")?.entry.id,
      hashOf(dataId).toString(),
    );
    assertEquals(
      new Set(listed.map(({ cursor }) => cursor.orderKey)).size,
      listed.length,
    );
    assertEquals(JSON.stringify(listed).includes("INLINE_SECRET"), false);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 piece root index learns its space and retains it", async () => {
  const space = "did:key:z6Mk-piece-root-late-space";
  const sessionId = "session:piece-root-late-space";
  const { engine, path } = await createEngine();
  const linkedName = linkRefFrom({
    id: "of:piece-name",
    path: [],
    space,
    scope: "space",
  });

  try {
    applyCommit(engine, {
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "set",
            id: "of:piece",
            value: toEntityDocument(
              { $NAME: linkedName },
              undefined,
              {
                patternIdentity: {
                  identity: "L".repeat(43),
                  symbol: "default",
                },
              },
            ),
          },
          {
            op: "set",
            id: "of:piece-name",
            value: toEntityDocument("Learned name"),
          },
        ],
      },
    });
    assertEquals(
      listPieceRootPage(engine, { sessionId, limit: 10 })[0].entry.name,
      undefined,
    );

    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:unrelated",
          value: toEntityDocument({ value: "unrelated" }),
        }],
      },
    });
    assertEquals(
      listPieceRootPage(engine, { sessionId, limit: 10 })[0].entry.name,
      "Learned name",
    );

    applyCommit(engine, {
      sessionId,
      commit: {
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:piece-name",
          value: toEntityDocument("Updated without space"),
        }],
      },
    });
    assertEquals(
      listPieceRootPage(engine, { sessionId, limit: 10 })[0].entry.name,
      "Updated without space",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 piece registry tail updates preserve indexed positions", async () => {
  const space = "did:key:z6Mk-piece-root-registry-tail";
  const sessionId = "session:piece-root-registry-tail";
  const { engine, path } = await createEngineWithOptions({ space });
  const spaceCellId = `of:${hashOf({ causal: space }).taggedHashString}`;
  const link = (id: string) =>
    linkRefFrom({ id, path: [], space, scope: "space" });
  const pieceDocument = (identity: string) =>
    toEntityDocument({}, undefined, {
      patternIdentity: { identity, symbol: "default" },
    });

  try {
    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "set",
            id: spaceCellId,
            value: toEntityDocument({ defaultPattern: link("of:home") }),
          },
          {
            op: "set",
            id: "of:home",
            value: toEntityDocument(
              { pieceRegistry: link("of:registry") },
              undefined,
              {
                patternIdentity: {
                  identity: "H".repeat(43),
                  symbol: "default",
                },
              },
            ),
          },
          {
            op: "set",
            id: "of:registry",
            value: toEntityDocument([link("of:a")]),
          },
          {
            op: "set",
            id: "of:a",
            value: pieceDocument("A".repeat(43)),
          },
          {
            op: "set",
            id: "of:b",
            value: pieceDocument("B".repeat(43)),
          },
        ],
      },
    });
    assertEquals(
      listPieceRootPage(engine, {
        sessionId,
        limit: 10,
        registeredOnly: true,
      }).map(({ entry }) => entry.id),
      ["a"],
    );

    engine.database.exec(`
CREATE TRIGGER reject_existing_registry_position_rewrite
BEFORE UPDATE OF registry_position ON pragma_piece_root
WHEN OLD.id = 'of:a'
BEGIN
  SELECT RAISE(ABORT, 'existing registry position was rewritten');
END;
`);
    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "of:registry",
          patches: [{
            op: "append",
            path: "/value",
            values: [link("of:b")],
          }],
        }],
      },
    });
    assertEquals(
      listPieceRootPage(engine, {
        sessionId,
        limit: 10,
        registeredOnly: true,
      }).map(({ entry }) => entry.id),
      ["a", "b"],
    );

    applyCommit(engine, {
      space,
      sessionId: `${sessionId}:pattern-source`,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "of:b",
          patches: [{
            op: "add",
            path: "/patternSource",
            value: "/patterns/registered-piece.tsx",
          }],
        }],
      },
    });
    assertEquals(
      listPieceRootPage(engine, {
        sessionId,
        limit: 10,
        registeredOnly: true,
      }).map(({ entry }) => entry.id),
      ["a", "b"],
    );

    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "of:b",
          patches: [{
            op: "add",
            path: "/value/x",
            value: true,
          }],
        }],
      },
    });
    assertEquals(
      listPieceRootPage(engine, {
        sessionId,
        limit: 10,
        registeredOnly: true,
      }).map(({ entry }) => entry.id),
      ["a", "b"],
    );

    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 4,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "of:registry",
          patches: [{
            op: "add-unique",
            path: "/value",
            values: [link("of:a")],
          }],
        }],
      },
    });
    assertEquals(
      listPieceRootPage(engine, {
        sessionId,
        limit: 10,
        registeredOnly: true,
      }).map(({ entry }) => entry.id),
      ["a", "b"],
    );

    applyCommit(engine, {
      sessionId,
      commit: {
        localSeq: 5,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "set",
            id: "of:c",
            value: pieceDocument("C".repeat(43)),
          },
          {
            op: "patch",
            id: "of:a",
            patches: [{
              op: "add",
              path: "/value/x",
              value: true,
            }],
          },
          {
            op: "patch",
            id: "of:registry",
            patches: [{
              op: "append",
              path: "/value",
              values: [link("of:c")],
            }],
          },
        ],
      },
    });
    assertEquals(
      listPieceRootPage(engine, {
        sessionId,
        limit: 10,
        registeredOnly: true,
      }).map(({ entry }) => entry.id),
      ["a", "b", "c"],
    );

    engine.database.exec(
      `DROP TRIGGER reject_existing_registry_position_rewrite`,
    );
    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 6,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "set",
            id: "of:registry",
            value: toEntityDocument([link("of:b"), link("of:a")]),
          },
          {
            op: "patch",
            id: "of:registry",
            patches: [{
              op: "append",
              path: "/value",
              values: [link("of:c")],
            }],
          },
        ],
      },
    });
    assertEquals(
      listPieceRootPage(engine, {
        sessionId,
        limit: 10,
        registeredOnly: true,
      }).map(({ entry }) => entry.id),
      ["b", "a", "c"],
    );

    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 7,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "of:registry",
          patches: [{
            op: "replace",
            path: "/value/0",
            value: link("of:a"),
          }],
        }],
      },
    });
    assertEquals(
      listPieceRootPage(engine, {
        sessionId,
        limit: 10,
        registeredOnly: true,
      }).map(({ entry }) => entry.id),
      ["a", "c"],
    );

    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 8,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "of:registry",
          patches: [{
            op: "replace",
            path: "/value/0",
            value: link("of:b"),
          }],
        }],
      },
    });
    assertEquals(
      listPieceRootPage(engine, {
        sessionId,
        limit: 10,
        registeredOnly: true,
      }).map(({ entry }) => entry.id),
      ["b", "a", "c"],
    );

    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 9,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "of:a",
          patches: [{
            op: "remove",
            path: "/patternIdentity",
          }],
        }],
      },
    });
    assertEquals(
      listPieceRootPage(engine, {
        sessionId,
        limit: 10,
        registeredOnly: true,
      }).map(({ entry }) => entry.id),
      ["b", "c"],
    );

    applyCommit(engine, {
      space,
      sessionId,
      commit: {
        localSeq: 10,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "of:a",
          patches: [{
            op: "add",
            path: "/patternIdentity",
            value: {
              identity: "A".repeat(43),
              symbol: "default",
            },
          }],
        }],
      },
    });
    assertEquals(
      listPieceRootPage(engine, {
        sessionId,
        limit: 10,
        registeredOnly: true,
      }).map(({ entry }) => entry.id),
      ["b", "a", "c"],
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 piece root continuations use ordering indexes", async () => {
  const { engine, path } = await createEngineWithOptions({
    space: "did:key:z6Mk-piece-root-query-plan",
  });
  const planDetails = (sql: string): string[] =>
    (engine.database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<
      { detail: string }
    >).map(({ detail }) => detail);

  try {
    const registered = planDetails(`
SELECT id
FROM pragma_piece_root
WHERE scope_key = 'space'
  AND registry_position IS NOT NULL
  AND registry_position > 100
ORDER BY registry_position
LIMIT 101
`);
    assertEquals(
      registered.some((detail) =>
        detail.includes("idx_piece_root_registry_position") &&
        detail.includes("registry_position>?")
      ),
      true,
    );
    assertEquals(
      registered.some((detail) => detail.includes("TEMP B-TREE")),
      false,
    );

    const unregistered = planDetails(`
SELECT id
FROM pragma_piece_root
  INDEXED BY idx_piece_root_unregistered_scope_listing
WHERE scope_key = 'user:alice'
  AND registry_position IS NULL
  AND (canonical_id, order_key) >
    ('fid1:cursor', 'opaque-order-key')
ORDER BY canonical_id, order_key
LIMIT 101
`);
    assertEquals(
      unregistered.some((detail) =>
        detail.includes("idx_piece_root_unregistered_scope_listing") &&
        detail.includes("scope_key=?") &&
        detail.includes("canonical_id") &&
        detail.includes("order_key")
      ),
      true,
    );
    assertEquals(
      unregistered.some((detail) => detail.includes("TEMP B-TREE")),
      false,
    );

    const dependency = planDetails(`
SELECT piece_id, piece_scope_key
FROM pragma_piece_root_dependency AS dependency
  INDEXED BY idx_piece_root_dependency_target
WHERE dependency_id = 'of:dependency'
  AND dependency_scope_key = 'space'
  AND NOT EXISTS (
    SELECT 1
    FROM head AS pending_root
    WHERE pending_root.branch = ''
      AND pending_root.id = dependency.piece_id
      AND pending_root.scope_key = dependency.piece_scope_key
      AND pending_root.seq > 10
      AND pending_root.seq <= 100
  )
  AND (piece_id, piece_scope_key) > ('of:cursor', 'space')
ORDER BY piece_id, piece_scope_key
LIMIT 256
`);
    assertEquals(
      dependency.some((detail) =>
        detail.includes("idx_piece_root_dependency_target") &&
        detail.includes("dependency_id=?") &&
        detail.includes("dependency_scope_key=?")
      ),
      true,
    );
    assertEquals(
      dependency.some((detail) => detail.includes("TEMP B-TREE")),
      false,
    );

    const pendingDependencyTargets = planDetails(`
SELECT pending.id, pending.scope_key
FROM head AS pending INDEXED BY idx_head_branch_sequence
WHERE pending.branch = ''
  AND pending.seq > 10
  AND pending.seq <= 100
  AND EXISTS (
    SELECT 1
    FROM pragma_piece_root_dependency AS dependency
      INDEXED BY idx_piece_root_dependency_target
    WHERE dependency.dependency_id = pending.id
      AND dependency.dependency_scope_key = pending.scope_key
      AND NOT EXISTS (
        SELECT 1
        FROM head AS pending_root
        WHERE pending_root.branch = ''
          AND pending_root.id = dependency.piece_id
          AND pending_root.scope_key = dependency.piece_scope_key
          AND pending_root.seq > 10
          AND pending_root.seq <= 100
      )
  )
ORDER BY pending.seq, pending.rowid
LIMIT 257
`);
    assertEquals(
      pendingDependencyTargets.some((detail) =>
        detail.includes("idx_head_branch_sequence") &&
        detail.includes("branch=?") &&
        detail.includes("seq>?")
      ),
      true,
    );
    assertEquals(
      pendingDependencyTargets.some((detail) =>
        detail.includes("idx_piece_root_dependency_target") &&
        detail.includes("dependency_id=?") &&
        detail.includes("dependency_scope_key=?")
      ),
      true,
    );
    assertEquals(
      pendingDependencyTargets.some((detail) =>
        detail.includes("sqlite_autoindex_head_1") &&
        detail.includes("branch=?") &&
        detail.includes("id=?") &&
        detail.includes("scope_key=?")
      ),
      true,
    );
    assertEquals(
      pendingDependencyTargets.some((detail) => detail.includes("TEMP B-TREE")),
      false,
    );

    const broadDependencyCatchUp = planDetails(`
SELECT dependency.piece_id, dependency.piece_scope_key
FROM pragma_piece_root_dependency AS dependency
WHERE (dependency.piece_id, dependency.piece_scope_key) >
    ('of:cursor', 'space')
  AND EXISTS (
    SELECT 1
    FROM head AS changed_dependency
    WHERE changed_dependency.branch = ''
      AND changed_dependency.id = dependency.dependency_id
      AND changed_dependency.scope_key = dependency.dependency_scope_key
      AND changed_dependency.seq > 10
      AND changed_dependency.seq <= 100
  )
  AND NOT EXISTS (
    SELECT 1
    FROM head AS pending_root
    WHERE pending_root.branch = ''
      AND pending_root.id = dependency.piece_id
      AND pending_root.scope_key = dependency.piece_scope_key
      AND pending_root.seq > 10
      AND pending_root.seq <= 100
  )
GROUP BY dependency.piece_id, dependency.piece_scope_key
ORDER BY dependency.piece_id, dependency.piece_scope_key
LIMIT 256
`);
    assertEquals(
      broadDependencyCatchUp.filter((detail) =>
        detail.includes("sqlite_autoindex_head_1")
      ).length >= 2,
      true,
      broadDependencyCatchUp.join("\n"),
    );
    assertEquals(
      broadDependencyCatchUp.some((detail) => detail.includes("TEMP B-TREE")),
      false,
    );

    const registryDependency = planDetails(`
SELECT dependency_path, dependency_kind
FROM pragma_piece_registry_dependency
WHERE dependency_id = 'of:dependency'
  AND dependency_scope_key = 'space'
  AND dependency_path > '["cursor"]'
ORDER BY dependency_path
LIMIT 256
`);
    assertEquals(
      registryDependency.some((detail) =>
        detail.includes("PRIMARY KEY") &&
        detail.includes("dependency_id=?") &&
        detail.includes("dependency_scope_key=?")
      ),
      true,
    );
    assertEquals(
      registryDependency.some((detail) => detail.includes("TEMP B-TREE")),
      false,
    );

    const changedHeads = planDetails(`
SELECT rowid, id, scope_key, seq
FROM head INDEXED BY idx_head_branch_sequence
WHERE branch = ''
  AND seq > 10
  AND seq <= 100
  AND (seq, rowid) > (20, 30)
ORDER BY seq, rowid
LIMIT 256
`);
    assertEquals(
      changedHeads.some((detail) =>
        detail.includes("idx_head_branch_sequence") &&
        detail.includes("branch=?") &&
        detail.includes("seq>?")
      ),
      true,
    );
    assertEquals(
      changedHeads.some((detail) => detail.includes("TEMP B-TREE")),
      false,
    );

    const changedRegistryDocument = planDetails(`
SELECT id, scope_key, seq, op_index, op, data
FROM revision
WHERE branch = ''
  AND seq > 10
  AND seq <= 100
  AND id = 'of:registry'
  AND scope_key = 'space'
  AND (seq, op_index) > (20, 0)
ORDER BY seq, op_index
LIMIT 256
`);
    assertEquals(
      changedRegistryDocument.some((detail) =>
        detail.includes("idx_revision_branch_id_seq") &&
        detail.includes("branch=?") &&
        detail.includes("id=?") &&
        detail.includes("scope_key=?") &&
        detail.includes("seq>?")
      ),
      true,
    );
    assertEquals(
      changedRegistryDocument.some((detail) => detail.includes("TEMP B-TREE")),
      false,
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 piece root pages use one SQLite snapshot", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const url = toFileUrl(path);
  const space = "did:key:z6Mk-piece-root-read-snapshot";
  const sessionId = "session:piece-root-read-snapshot";
  const reader = await open({ url, space });
  const writer = await open({ url, space });
  const pieceDocument = toEntityDocument({}, undefined, {
    patternIdentity: {
      identity: "R".repeat(43),
      symbol: "default",
    },
  });

  try {
    applyCommit(reader, {
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          { op: "set", id: "of:a", value: pieceDocument },
          { op: "set", id: "of:b", value: pieceDocument },
        ],
      },
    });
    // Warm the lazy index before opening the deliberate read snapshot.
    listPieceRootPage(reader, { sessionId, limit: 10 });

    const observed = reader.database.transaction(() => {
      const checkedSequence = serverSeq(reader);
      applyCommit(writer, {
        space,
        sessionId: "session:piece-root-snapshot-writer",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{ op: "set", id: "of:c", value: pieceDocument }],
        },
      });
      const ids = listPieceRootPage(reader, {
        sessionId,
        limit: 10,
      }).map(({ entry }) => entry.id);
      return { checkedSequence, ids };
    })();
    assertEquals(observed, { checkedSequence: 1, ids: ["a", "b"] });

    assertEquals(
      listPieceRootSnapshotPage(reader, {
        sessionId,
        limit: 10,
        expectedServerSeq: observed.checkedSequence,
      }),
      { serverSeq: 2 },
    );
  } finally {
    close(writer);
    close(reader);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 caught-up piece root reads do not reserve the writer slot", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const url = toFileUrl(path);
  const space = "did:key:z6Mk-piece-root-caught-up-reader";
  const sessionId = "session:piece-root-caught-up-reader";
  const reader = await open({ url, space });
  const writer = await open({ url, space });

  try {
    applyCommit(reader, {
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:current",
          value: toEntityDocument(
            { $NAME: "Current" },
            undefined,
            {
              patternIdentity: {
                identity: "Q".repeat(43),
                symbol: "default",
              },
            },
          ),
        }],
      },
    });
    listPieceRootPage(reader, { sessionId, limit: 10 });
    reader.database.exec("PRAGMA busy_timeout = 0");
    writer.database.exec("BEGIN IMMEDIATE");

    assertEquals(
      listPieceRootPage(reader, { sessionId, limit: 10 })[0].entry.name,
      "Current",
    );
    assertEquals(
      listPieceRootSnapshotPage(reader, {
        sessionId,
        limit: 10,
        expectedServerSeq: 1,
      }).rows?.[0].entry.name,
      "Current",
    );
  } finally {
    if (writer.database.inTransaction) writer.database.exec("ROLLBACK");
    close(writer);
    close(reader);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine stores independent scoped instances for the same id", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:alice",
      principal: "did:key:alice",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:scoped",
          value: toEntityDocument({ scope: "space" }),
        }],
      },
    });
    applyCommit(engine, {
      sessionId: "session:alice",
      principal: "did:key:alice",
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:scoped",
          scope: "user",
          value: toEntityDocument({ scope: "alice" }),
        }],
      },
    });
    applyCommit(engine, {
      sessionId: "session:alice",
      principal: "did:key:alice",
      commit: {
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:scoped",
          scope: "session",
          value: toEntityDocument({ scope: "alice-session" }),
        }],
      },
    });

    assertEquals(read(engine, { id: "entity:scoped" }), {
      value: { scope: "space" },
    });
    assertEquals(
      read(engine, {
        id: "entity:scoped",
        scope: "user",
        principal: "did:key:alice",
        sessionId: "session:alice",
      }),
      { value: { scope: "alice" } },
    );
    assertEquals(
      read(engine, {
        id: "entity:scoped",
        scope: "session",
        principal: "did:key:alice",
        sessionId: "session:alice",
      }),
      { value: { scope: "alice-session" } },
    );
    assertEquals(
      read(engine, {
        id: "entity:scoped",
        scope: "user",
        principal: "did:key:bob",
        sessionId: "session:bob",
      }),
      null,
    );
    assertEquals(
      read(engine, {
        id: "entity:scoped",
        scope: "session",
        principal: "did:key:alice",
        sessionId: "session:other",
      }),
      null,
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine binds session scoped instances to the principal", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:shared",
      principal: "did:key:alice",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:session-principal",
          scope: "session",
          value: toEntityDocument({ owner: "alice" }),
        }],
      },
    });
    applyCommit(engine, {
      sessionId: "session:shared",
      principal: "did:key:bob",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:session-principal",
          scope: "session",
          value: toEntityDocument({ owner: "bob" }),
        }],
      },
    });

    assertEquals(
      read(engine, {
        id: "entity:session-principal",
        scope: "session",
        principal: "did:key:alice",
        sessionId: "session:shared",
      }),
      { value: { owner: "alice" } },
    );
    assertEquals(
      read(engine, {
        id: "entity:session-principal",
        scope: "session",
        principal: "did:key:bob",
        sessionId: "session:shared",
      }),
      { value: { owner: "bob" } },
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine encodes user and session scoped principal keys symmetrically", async () => {
  const { engine, path } = await createEngine();

  try {
    const principals = ["did:key:foo", "did:key:bar"];
    for (const [index, principal] of principals.entries()) {
      applyCommit(engine, {
        sessionId: "session:shared",
        principal,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [
            {
              op: "set",
              id: "entity:encoded-user",
              scope: "user",
              value: toEntityDocument({ owner: principal }),
            },
            {
              op: "set",
              id: "entity:encoded-session",
              scope: "session",
              value: toEntityDocument({ owner: principal }),
            },
          ],
        },
      });

      assertEquals(
        read(engine, {
          id: "entity:encoded-user",
          scope: "user",
          principal,
          sessionId: "session:shared",
        }),
        { value: { owner: principal } },
      );
      assertEquals(
        read(engine, {
          id: "entity:encoded-session",
          scope: "session",
          principal,
          sessionId: "session:shared",
        }),
        { value: { owner: principal } },
      );
      assertEquals(
        read(engine, {
          id: "entity:encoded-user",
          scope: "user",
          principal: principals[1 - index],
          sessionId: "session:shared",
        }),
        index === 0 ? null : { value: { owner: principals[0] } },
      );
    }

    const scopeKeys = (
      engine.database.prepare(
        `SELECT DISTINCT scope_key FROM revision WHERE id IN ('entity:encoded-user', 'entity:encoded-session') ORDER BY scope_key`,
      ).all() as Array<{ scope_key: string }>
    ).map((row) => row.scope_key);
    assertEquals(scopeKeys, [
      "session:did%3Akey%3Abar:session%3Ashared",
      "session:did%3Akey%3Afoo:session%3Ashared",
      "user:did%3Akey%3Abar",
      "user:did%3Akey%3Afoo",
    ]);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine requires principal context for user and session scoped reads", async () => {
  const { engine, path } = await createEngine();

  try {
    assertThrows(
      () => read(engine, { id: "entity:principal-required", scope: "user" }),
      ProtocolError,
      "user scoped memory operations require a principal",
    );
    assertThrows(
      () =>
        read(engine, {
          id: "entity:principal-required",
          scope: "session",
          sessionId: "session:present",
        }),
      ProtocolError,
      "session scoped memory operations require a principal",
    );
    assertThrows(
      () =>
        read(engine, {
          id: "entity:principal-required",
          scope: "session",
          principal: "did:key:foo",
        }),
      ProtocolError,
      "session scoped memory operations require a session id",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine migrates pre-scope entity tables to space scope", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const url = toFileUrl(path);
  const legacyDb = new Database(path, { create: true });
  try {
    legacyDb.exec(`
      CREATE TABLE "commit" (
        seq                INTEGER NOT NULL PRIMARY KEY,
        branch             TEXT    NOT NULL DEFAULT '',
        session_id         TEXT    NOT NULL,
        local_seq          INTEGER NOT NULL,
        invocation_ref     TEXT,
        authorization_ref  TEXT,
        original           JSON    NOT NULL,
        resolution         JSON    NOT NULL,
        created_at         TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX idx_commit_session_local_seq
        ON "commit" (session_id, local_seq);
      CREATE TABLE revision (
        branch      TEXT    NOT NULL DEFAULT '',
        id          TEXT    NOT NULL,
        seq         INTEGER NOT NULL,
        op_index    INTEGER NOT NULL,
        op          TEXT    NOT NULL,
        data        JSON,
        commit_seq  INTEGER NOT NULL,
        PRIMARY KEY (branch, id, seq, op_index)
      );
      CREATE INDEX idx_revision_branch_id_seq
        ON revision (branch, id, seq, op_index);
      CREATE INDEX idx_revision_commit ON revision (commit_seq);
      CREATE INDEX idx_revision_branch ON revision (branch, seq);
      CREATE TABLE head (
        branch    TEXT    NOT NULL,
        id        TEXT    NOT NULL,
        seq       INTEGER NOT NULL,
        op_index  INTEGER NOT NULL,
        PRIMARY KEY (branch, id)
      );
      CREATE INDEX idx_head_branch ON head (branch);
      CREATE TABLE snapshot (
        branch  TEXT    NOT NULL DEFAULT '',
        id      TEXT    NOT NULL,
        seq     INTEGER NOT NULL,
        value   JSON    NOT NULL,
        PRIMARY KEY (branch, id, seq)
      );
      CREATE INDEX idx_snapshot_lookup ON snapshot (branch, id, seq);
      CREATE TABLE branch (
        name           TEXT    NOT NULL PRIMARY KEY,
        parent_branch  TEXT,
        fork_seq       INTEGER,
        created_seq    INTEGER NOT NULL DEFAULT 0,
        head_seq       INTEGER NOT NULL DEFAULT 0,
        status         TEXT    NOT NULL DEFAULT 'active',
        created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
        deleted_at     TEXT
      );
      INSERT INTO branch (name, created_seq, head_seq, status)
      VALUES ('', 0, 1, 'active');
      INSERT INTO "commit" (seq, branch, session_id, local_seq, original, resolution)
      VALUES (1, '', 'legacy-session', 1, '{}', '{}');
    `);
    legacyDb.prepare(
      `INSERT INTO revision (branch, id, seq, op_index, op, data, commit_seq)
       VALUES ('', 'entity:legacy', 1, 0, 'set', ?, 1)`,
    ).run(encodeMemoryBoundary(toEntityDocument({ migrated: true })));
    legacyDb.prepare(
      `INSERT INTO head (branch, id, seq, op_index)
       VALUES ('', 'entity:legacy', 1, 0)`,
    ).run();
    legacyDb.prepare(
      `INSERT INTO snapshot (branch, id, seq, value)
       VALUES ('', 'entity:legacy', 1, ?)`,
    ).run(encodeMemoryBoundary(toEntityDocument({ migrated: true })));
  } finally {
    legacyDb.close();
  }

  let engine = await open({ url });
  try {
    assertEquals(read(engine, { id: "entity:legacy", scope: "space" }), {
      value: { migrated: true },
    });
    applyCommit(engine, {
      sessionId: "session:scoped",
      principal: "did:key:scoped",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:legacy",
          scope: "user",
          value: toEntityDocument({ migrated: false, scoped: true }),
        }],
      },
    });
    assertEquals(read(engine, { id: "entity:legacy", scope: "space" }), {
      value: { migrated: true },
    });
    assertEquals(
      read(engine, {
        id: "entity:legacy",
        scope: "user",
        principal: "did:key:scoped",
        sessionId: "session:scoped",
      }),
      { value: { migrated: false, scoped: true } },
    );
  } finally {
    close(engine);
  }

  engine = await open({ url });
  try {
    assertEquals(read(engine, { id: "entity:legacy", scope: "space" }), {
      value: { migrated: true },
    });
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine backfills current head operations", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const url = toFileUrl(path);
  let engine = await open({ url });
  try {
    applyCommit(engine, {
      sessionId: "session:migration",
      principal: "did:key:migration",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "set",
            id: "entity:migrated-live",
            value: toEntityDocument({ live: true }),
          },
          {
            op: "set",
            id: "entity:migrated-deleted",
            value: toEntityDocument({ live: false }),
          },
          {
            op: "set",
            id: "entity:migrated-user",
            scope: "user",
            value: toEntityDocument({ private: true }),
          },
        ],
      },
    });
    applyCommit(engine, {
      sessionId: "session:migration",
      principal: "did:key:migration",
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "delete", id: "entity:migrated-deleted" }],
      },
    });
  } finally {
    close(engine);
  }

  const legacyDb = new Database(path);
  try {
    legacyDb.exec(`
      DROP INDEX idx_head_live_entity_ids;
      ALTER TABLE head DROP COLUMN op;
    `);
    assertEquals(
      legacyDb.prepare(`PRAGMA table_info("head")`).all().some(
        (row) => (row as { name: string }).name === "op",
      ),
      false,
    );
  } finally {
    legacyDb.close();
  }

  engine = await open({ url });
  try {
    assertEquals(listEntityIds(engine), ["entity:migrated-live"]);
    assertEquals(
      engine.database.prepare(`
        SELECT id, scope_key, op
        FROM head
        ORDER BY id, scope_key
      `).all(),
      [
        {
          id: "entity:migrated-deleted",
          scope_key: "space",
          op: "delete",
        },
        { id: "entity:migrated-live", scope_key: "space", op: "set" },
        {
          id: "entity:migrated-user",
          scope_key: "user:did%3Akey%3Amigration",
          op: "set",
        },
      ],
    );
    assertEquals(
      engine.database.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_head_live_entity_ids'
      `).get(),
      { name: "idx_head_live_entity_ids" },
    );
    assertEquals(
      (engine.database.prepare(`PRAGMA table_info("head")`).all() as Array<{
        name: string;
        dflt_value: string | null;
      }>).find(({ name }) => name === "op")?.dflt_value,
      null,
    );
    assertThrows(
      () =>
        engine.database.prepare(`
          INSERT INTO head (branch, id, scope_key, seq, op_index)
          VALUES ('', 'entity:migrated-live', 'space', 1, 0)
          ON CONFLICT (branch, id, scope_key) DO UPDATE
          SET seq = excluded.seq, op_index = excluded.op_index
        `).run(),
      Error,
      "NOT NULL constraint failed: head.op",
    );
  } finally {
    close(engine);
  }

  const defaultedDb = new Database(path);
  try {
    defaultedDb.exec(`
      DROP INDEX idx_head_live_entity_ids;
      DROP INDEX idx_head_branch_sequence;
      ALTER TABLE head RENAME TO head_defaulted_migration;
      CREATE TABLE head (
        branch    TEXT    NOT NULL,
        id        TEXT    NOT NULL,
        scope_key TEXT    NOT NULL DEFAULT 'space',
        seq       INTEGER NOT NULL,
        op_index  INTEGER NOT NULL,
        op        TEXT    NOT NULL DEFAULT 'set'
          CHECK (op IN ('set', 'patch', 'delete')),
        PRIMARY KEY (branch, id, scope_key)
      );
      CREATE INDEX idx_head_branch ON head (branch);
      INSERT INTO head (branch, id, scope_key, seq, op_index)
      SELECT branch, id, scope_key, seq, op_index
      FROM head_defaulted_migration;
      DROP TABLE head_defaulted_migration;
    `);
    assertEquals(
      defaultedDb.prepare(`
        SELECT op FROM head
        WHERE id = 'entity:migrated-deleted' AND scope_key = 'space'
      `).get(),
      { op: "set" },
    );
  } finally {
    defaultedDb.close();
  }

  engine = await open({ url });
  try {
    assertEquals(listEntityIds(engine), ["entity:migrated-live"]);
    assertEquals(
      engine.database.prepare(`
        SELECT op FROM head
        WHERE id = 'entity:migrated-deleted' AND scope_key = 'space'
      `).get(),
      { op: "delete" },
    );
    assertEquals(
      (engine.database.prepare(`PRAGMA table_info("head")`).all() as Array<{
        name: string;
        dflt_value: string | null;
      }>).find(({ name }) => name === "op")?.dflt_value,
      null,
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine conflicts are scoped by declared scope", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:alice",
      principal: "did:key:alice",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:conflict",
          scope: "user",
          value: toEntityDocument({ count: 1 }),
        }],
      },
    });

    const spaceWrite = applyCommit(engine, {
      sessionId: "session:alice",
      principal: "did:key:alice",
      commit: {
        localSeq: 2,
        reads: {
          confirmed: [{
            id: "entity:conflict",
            path: toDocumentPath(["value"]),
            seq: 0,
          }],
          pending: [],
        },
        operations: [{
          op: "set",
          id: "entity:space-only",
          value: toEntityDocument("ok"),
        }],
      },
    });
    assertEquals(spaceWrite.seq, 2);

    applyCommit(engine, {
      sessionId: "session:alice",
      principal: "did:key:alice",
      commit: {
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:conflict",
          scope: "user",
          value: toEntityDocument({ count: 2 }),
        }],
      },
    });

    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:alice",
          principal: "did:key:alice",
          commit: {
            localSeq: 4,
            reads: {
              confirmed: [{
                id: "entity:conflict",
                scope: "user",
                path: toDocumentPath(["value"]),
                seq: 1,
              }],
              pending: [],
            },
            operations: [{
              op: "set",
              id: "entity:conflict-result",
              scope: "user",
              value: toEntityDocument("stale"),
            }],
          },
        }),
      Error,
      "stale confirmed read",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

// CT-1824 contract: a stale-read ConflictError must name the conflicted
// entity BOTH structurally (of/seq/conflictSeq — read in-process by
// editWithRetry's pull) AND in the message with this exact shape — server
// Error fields do not survive serialization to the browser, so the runner
// client re-derives `of` by parsing the message (runner storage/v2.ts
// toRejectedError). Changing either surface breaks conflict recovery for
// blind writes.
Deno.test("memory v2 engine: stale-read ConflictError carries the conflicted entity structurally and in the message", async () => {
  const { engine, path } = await createEngine();
  const sessionId = "session:alice";
  const principal = "did:key:alice";

  try {
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:stale-named",
          value: toEntityDocument({ v: 1 }),
        }],
      },
    });
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:stale-named",
          value: toEntityDocument({ v: 2 }),
        }],
      },
    });

    const error = assertThrows(
      () =>
        applyCommit(engine, {
          sessionId,
          principal,
          commit: {
            localSeq: 3,
            reads: {
              confirmed: [{
                id: "entity:stale-named",
                path: toDocumentPath(["value"]),
                seq: 1,
              }],
              pending: [],
            },
            operations: [{
              op: "set",
              id: "entity:stale-result",
              value: toEntityDocument("late"),
            }],
          },
        }),
      ConflictError,
    );
    assertEquals(error.of, "entity:stale-named");
    assertEquals(error.seq, 1);
    assertEquals(error.conflictSeq, 2);
    assertMatch(
      error.message,
      /^stale confirmed read: \S+ at seq \d+ conflicted with seq \d+$/,
    );
    // The exact parse the runner client performs on the wire-crossed message.
    assertEquals(
      error.message.match(/stale confirmed read: (\S+) at seq/)?.[1],
      "entity:stale-named",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine: leaf-only commit conflict — disjoint-key writers merge, same-key/container readers still conflict", async () => {
  const { engine, path } = await createEngine();
  const sessionId = "session:alice";
  const principal = "did:key:alice";
  const id = "entity:map";
  const scope = "space" as const;

  try {
    // seq 1: establish a map with keys a, b.
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id,
          scope,
          value: toEntityDocument({ a: "1", b: "2" }),
        }],
      },
    });

    // seq 2: a concurrent writer ADDS a new key `c`. An add/remove patch is the
    // case where `touchedPathsForPatch` used to inject the parent ["value"].
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id,
          scope,
          patches: [{ op: "add", path: "/value/c", value: "3" }],
        }],
      },
    });

    // DISTINCT-KEY: a writer whose conflict read is only the SIBLING key `a`
    // (as a keyed `.set()`'s own-key/diff read is) must NOT conflict with the
    // seq-2 add of `c`. Leaf-only: ["value","c"] does not overlap ["value","a"].
    // Pre-fix (parent-injected ["value"]) this collided — the write-contention bug.
    const merged = applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 3,
        reads: {
          confirmed: [{
            id,
            scope,
            path: toDocumentPath(["value", "a"]),
            seq: 1,
          }],
          pending: [],
        },
        operations: [{
          op: "patch",
          id,
          scope,
          patches: [{ op: "add", path: "/value/d", value: "4" }],
        }],
      },
    });
    assertEquals(merged.seq, 3);

    // SAME-KEY: a writer that read `c` (the key the seq-2 add created) MUST still
    // conflict — genuine read-modify-write is preserved (leaf exactly matches).
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId,
          principal,
          commit: {
            localSeq: 4,
            reads: {
              confirmed: [{
                id,
                scope,
                path: toDocumentPath(["value", "c"]),
                seq: 1,
              }],
              pending: [],
            },
            operations: [{
              op: "set",
              id: "entity:sink",
              scope,
              value: toEntityDocument("x"),
            }],
          },
        }),
      Error,
      "stale confirmed read",
    );

    // CONTAINER READER: a writer that read the whole container ["value"] MUST
    // still conflict with a key add (the container's value changed) — caught via
    // the bidirectional overlap (the container read is a prefix of the leaf add).
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId,
          principal,
          commit: {
            localSeq: 5,
            reads: {
              confirmed: [{
                id,
                scope,
                path: toDocumentPath(["value"]),
                seq: 1,
              }],
              pending: [],
            },
            operations: [{
              op: "set",
              id: "entity:sink2",
              scope,
              value: toEntityDocument("y"),
            }],
          },
        }),
      Error,
      "stale confirmed read",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine: nonRecursive shape read conflicts with key add but not a disjoint deep-value write", async () => {
  const { engine, path } = await createEngine();
  const sessionId = "session:alice";
  const principal = "did:key:alice";
  const id = "entity:shape";
  const scope = "space" as const;

  try {
    // seq 1: container with a value at key x.
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id,
          scope,
          value: toEntityDocument({ x: "1" }),
        }],
      },
    });
    // seq 2: a key ADD (changes the container's key-set).
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id,
          scope,
          patches: [{ op: "add", path: "/value/y", value: "3" }],
        }],
      },
    });
    // seq 3: a disjoint DEEP-VALUE replace strictly below the container.
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id,
          scope,
          patches: [{ op: "replace", path: "/value/x", value: "2" }],
        }],
      },
    });

    // A: a SHAPE (nonRecursive) reader of the container observed at seq 2 must
    // NOT conflict with the seq-3 deep-value replace — it never depended on x's
    // value, only the container's shape.
    const ok = applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 4,
        reads: {
          confirmed: [{
            id,
            scope,
            path: toDocumentPath(["value"]),
            seq: 2,
            nonRecursive: true,
          }],
          pending: [],
        },
        operations: [{
          op: "set",
          id: "entity:sinkA",
          scope,
          value: toEntityDocument("ok"),
        }],
      },
    });
    assertEquals(ok.seq, 4);

    // B: a RECURSIVE reader of the same container observed at seq 2 MUST conflict
    // with the seq-3 deep-value replace (its read covered x).
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId,
          principal,
          commit: {
            localSeq: 5,
            reads: {
              confirmed: [{
                id,
                scope,
                path: toDocumentPath(["value"]),
                seq: 2,
              }],
              pending: [],
            },
            operations: [{
              op: "set",
              id: "entity:sinkB",
              scope,
              value: toEntityDocument("x"),
            }],
          },
        }),
      Error,
      "stale confirmed read",
    );

    // C: a SHAPE reader observed at seq 1 MUST still conflict with the seq-2 key
    // ADD — adding a key changes the key-set the shape read observed.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId,
          principal,
          commit: {
            localSeq: 6,
            reads: {
              confirmed: [{
                id,
                scope,
                path: toDocumentPath(["value"]),
                seq: 1,
                nonRecursive: true,
              }],
              pending: [],
            },
            operations: [{
              op: "set",
              id: "entity:sinkC",
              scope,
              value: toEntityDocument("y"),
            }],
          },
        }),
      Error,
      "stale confirmed read",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine: nonRecursive shape read conflicts with array move and splice patches", async () => {
  // A non-recursive (keyset / shape) read is matched against a patch via the
  // parent-injecting `touchedPathsForPatch` (patchOverlapsNonRecursiveRead). The
  // add/remove arms are covered above; this pins the `move` and `splice` arms —
  // reordering or splicing an array changes the shape a keyset reader observed,
  // so it must conflict (the patch's parent path is injected and prefix-matches
  // the read).
  const { engine, path } = await createEngine();
  const sessionId = "session:alice";
  const principal = "did:key:alice";
  const id = "entity:array-shape";
  const scope = "space" as const;

  try {
    // seq 1: a container holding an array.
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id,
          scope,
          value: toEntityDocument({ arr: ["a", "b", "c"] }),
        }],
      },
    });

    // seq 2: a MOVE within the array (reorders elements).
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id,
          scope,
          patches: [{ op: "move", from: "/value/arr/0", path: "/value/arr/2" }],
        }],
      },
    });

    // A shape reader of the array observed at seq 1 MUST conflict with the seq-2
    // move (covers `touchedPathsForPatch`'s `move` arm via the injected parent).
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId,
          principal,
          commit: {
            localSeq: 3,
            reads: {
              confirmed: [{
                id,
                scope,
                path: toDocumentPath(["value", "arr"]),
                seq: 1,
                nonRecursive: true,
              }],
              pending: [],
            },
            operations: [{
              op: "set",
              id: "entity:sinkMove",
              scope,
              value: toEntityDocument("m"),
            }],
          },
        }),
      Error,
      "stale confirmed read",
    );

    // seq 3: a SPLICE on the array (removes an element, adds another).
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 4,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id,
          scope,
          patches: [{
            op: "splice",
            path: "/value/arr",
            index: 0,
            remove: 1,
            add: ["z"],
          }],
        }],
      },
    });

    // A shape reader observed at seq 2 (after the move, before the splice) MUST
    // conflict with the seq-3 splice (covers `touchedPathsForPatch`'s `splice`
    // arm: the spliced array path prefix-matches the keyset read).
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId,
          principal,
          commit: {
            localSeq: 5,
            reads: {
              confirmed: [{
                id,
                scope,
                path: toDocumentPath(["value", "arr"]),
                seq: 2,
                nonRecursive: true,
              }],
              pending: [],
            },
            operations: [{
              op: "set",
              id: "entity:sinkSplice",
              scope,
              value: toEntityDocument("s"),
            }],
          },
        }),
      Error,
      "stale confirmed read",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine: leaf-only matcher does NOT conflict on a synthetic indexed-array add (intentional; runner never emits one)", async () => {
  // DIVERGENCE MARKER. The recursive commit matcher is leaf-only, so an indexed
  // array `add` (which the engine accepts but the runner never produces) touches
  // ONLY the added index — it does not conflict a reader of a sibling index.
  // This is intentional: it keeps commit-conflict aligned with the leaf-only
  // scheduler reader-dirty index (the invariant #4210 relies on). Production
  // safety comes from the diff generator never emitting an indexed-array add (see
  // packages/runner/test/memory-v2-native-commit.test.ts and the
  // `assertNoIndexedArrayStructuralOps` guard in storage/v2-transaction.ts), NOT
  // from the matcher conflicting it. Ben's #4307 deliberately diverges here (its
  // "keeps array add conflicts conservative" test asserts the opposite); that
  // extra conservatism is what makes #4307 incompatible with #4210, because the
  // reader-dirty index would not re-trigger the conflicted reader.
  const { engine, path } = await createEngine();
  const sessionId = "session:alice";
  const principal = "did:key:alice";
  const id = "entity:array-leaf-only";

  try {
    // seq 1: array seed.
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id,
          value: toEntityDocument({ poll: { answers: ["bob"] } }),
        }],
      },
    });

    // seq 2: a (synthetic) indexed-array add inserting at index 1.
    applyCommit(engine, {
      sessionId: "session:other",
      principal: "did:key:other",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id,
          patches: [{
            op: "add",
            path: "/value/poll/answers/1",
            value: "alice",
          }],
        }],
      },
    });

    // A reader of the sibling index `answers/0` observed at seq 1 is NOT rejected
    // by the leaf-only matcher: the seq-2 add touched only `answers/1`. (Here
    // `answers/0` is in fact unchanged by an insert at index 1, so allowing it is
    // also semantically correct; the general point is that leaf-only conflicts no
    // sibling-index reader on an indexed add — hence the runner must never emit
    // one.)
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 2,
        reads: {
          confirmed: [{
            id,
            path: toDocumentPath(["value", "poll", "answers", "0"]),
            seq: 1,
          }],
          pending: [],
        },
        operations: [{
          op: "set",
          id: "entity:derived",
          value: toEntityDocument({ firstAnswer: "bob" }),
        }],
      },
    });
    assertEquals(read(engine, { id: "entity:derived" }), {
      value: { firstAnswer: "bob" },
    });
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine: leaf-only matcher conflicts conservatively with array splice and whole-array replace (the shapes the runner DOES emit)", async () => {
  // The runner encodes every array length change as a `splice` on the array path
  // or a whole-array `replace` (never an indexed add/remove). Both carry the
  // ARRAY's own path, which the leaf-only matcher treats as touching every index
  // below it — so a recursive reader of any sibling index conflicts. This pins
  // that leaf-only stays conservative (no false-negative) for the array ops that
  // actually occur in production, which is what makes #4220 safe given the
  // divergence-marker test above.
  const { engine, path } = await createEngine();
  const sessionId = "session:alice";
  const principal = "did:key:alice";
  const id = "entity:array-conservative";

  try {
    // seq 1: array seed.
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id,
          value: toEntityDocument({ arr: ["a", "b", "c"] }),
        }],
      },
    });

    // seq 2: a SPLICE on the array path (how the runner encodes a length change).
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id,
          patches: [{
            op: "splice",
            path: "/value/arr",
            index: 0,
            remove: 1,
            add: ["z"],
          }],
        }],
      },
    });

    // A recursive reader of the sibling index `arr/0` observed at seq 1 MUST
    // conflict with the seq-2 splice (the splice's array path prefix-matches the
    // index read) — leaf-only stays conservative for shifts encoded as splice.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId,
          principal,
          commit: {
            localSeq: 3,
            reads: {
              confirmed: [{
                id,
                path: toDocumentPath(["value", "arr", "0"]),
                seq: 1,
              }],
              pending: [],
            },
            operations: [{
              op: "set",
              id: "entity:sinkSplice",
              value: toEntityDocument("s"),
            }],
          },
        }),
      Error,
      "stale confirmed read",
    );

    // seq 3: a whole-array REPLACE (the runner's fallback for messy shifts).
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 4,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id,
          patches: [{
            op: "replace",
            path: "/value/arr",
            value: ["p", "q"],
          }],
        }],
      },
    });

    // A recursive reader of `arr/1` observed at seq 2 MUST conflict with the
    // seq-3 whole-array replace (replace's array path prefix-matches the read).
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId,
          principal,
          commit: {
            localSeq: 5,
            reads: {
              confirmed: [{
                id,
                path: toDocumentPath(["value", "arr", "1"]),
                seq: 2,
              }],
              pending: [],
            },
            operations: [{
              op: "set",
              id: "entity:sinkReplace",
              value: toEntityDocument("r"),
            }],
          },
        }),
      Error,
      "stale confirmed read",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine persists set and delete commits as seq revisions", async () => {
  const { engine, path } = await createEngine();

  try {
    const document = toEntityDocument(
      { hello: "world" },
      entityRefFromString("origin"),
    );

    const setResult = applyCommit(engine, {
      sessionId: "session:1",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:1",
          value: document,
        }],
      },
    });

    assertEquals(setResult.seq, 1);
    assertEquals(setResult.branch, DEFAULT_BRANCH);
    assertEquals(read(engine, { id: "entity:1" }), document);

    const commitRow = engine.database.prepare(
      `SELECT seq, branch, session_id, local_seq, invocation_ref,
              authorization_ref, original, resolution
       FROM "commit"
       WHERE seq = 1`,
    ).get() as
      | {
        seq: number;
        branch: string;
        session_id: string;
        local_seq: number;
        invocation_ref: string | null;
        authorization_ref: string | null;
        original: string;
        resolution: string;
      }
      | undefined;
    assertExists(commitRow);
    assertEquals(commitRow.seq, 1);
    assertEquals(commitRow.branch, DEFAULT_BRANCH);
    assertEquals(commitRow.session_id, "session:1");
    assertEquals(commitRow.local_seq, 1);
    assertEquals(commitRow.invocation_ref, null);
    assertEquals(commitRow.authorization_ref, null);
    assertEquals(decodeStored(commitRow.original), {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "entity:1",
        value: document,
      }],
    });
    assertEquals(decodeStored(commitRow.resolution), { seq: 1 });

    const revisionRow = engine.database.prepare(
      `SELECT branch, id, seq, op_index, op, data, commit_seq
       FROM revision
       WHERE id = 'entity:1' AND seq = 1`,
    ).get() as
      | {
        branch: string;
        id: string;
        seq: number;
        op_index: number;
        op: string;
        data: string;
        commit_seq: number;
      }
      | undefined;
    assertExists(revisionRow);
    assertEquals(revisionRow.branch, DEFAULT_BRANCH);
    assertEquals(revisionRow.id, "entity:1");
    assertEquals(revisionRow.seq, 1);
    assertEquals(revisionRow.op_index, 0);
    assertEquals(revisionRow.op, "set");
    assertEquals(decodeStored(revisionRow.data), document);
    assertEquals(revisionRow.commit_seq, 1);
    assertEquals(
      engine.database.prepare(
        "SELECT COUNT(*) AS count FROM invocation",
      ).get() as { count: number },
      { count: 0 },
    );
    assertEquals(
      engine.database.prepare(
        "SELECT COUNT(*) AS count FROM authorization",
      ).get() as { count: number },
      { count: 0 },
    );

    const deleteResult = applyCommit(engine, {
      sessionId: "session:1",
      invocation: invocationFor(2),
      authorization,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "delete", id: "entity:1" }],
      },
    });

    assertEquals(deleteResult.seq, 2);
    assertEquals(read(engine, { id: "entity:1" }), null);

    const deleteRevision = engine.database.prepare(
      `SELECT op, data
       FROM revision
       WHERE id = 'entity:1' AND seq = 2`,
    ).get() as
      | {
        op: string;
        data: string | null;
      }
      | undefined;
    assertEquals(deleteRevision, { op: "delete", data: null });

    const headRow = engine.database.prepare(
      `SELECT branch, id, seq, op_index
       FROM head
       WHERE branch = '' AND id = 'entity:1'`,
    ).get() as
      | {
        branch: string;
        id: string;
        seq: number;
        op_index: number;
      }
      | undefined;
    assertEquals(headRow, {
      branch: "",
      id: "entity:1",
      seq: 2,
      op_index: 0,
    });
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine preserves source-only entity documents", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:source-only",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:piece:1",
          value: toEntityDocument(undefined, entityRefFromString("process:1")),
        }],
      },
    });

    assertEquals(
      read(engine, { id: "of:piece:1" }),
      toEntityDocument(undefined, entityRefFromString("process:1")),
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine ignores supplied transact invocation metadata", async () => {
  const { engine, path } = await createEngine();

  try {
    const rawInvocation = {
      iss: 42,
      aud: { unexpected: true },
      cmd: ["not", "a", "string"],
      sub: null,
      args: {
        localSeq: 1,
      },
      note: "untrusted transport payload",
    };

    applyCommit(engine, {
      sessionId: "session:raw-invocation",
      invocation: {
        iss: "did:key:space",
        aud: null,
        cmd: "/memory/transact",
        sub: "did:key:space",
        args: {
          localSeq: 1,
        },
      },
      invocationPayload: rawInvocation,
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:raw-invocation",
          value: toEntityDocument({ ok: true }),
        }],
      },
    });

    const row = engine.database.prepare(
      `SELECT invocation_ref, authorization_ref
       FROM "commit"
       WHERE session_id = ? AND local_seq = ?`,
    ).get(["session:raw-invocation", 1]) as
      | {
        invocation_ref: string | null;
        authorization_ref: string | null;
      }
      | undefined;
    assertExists(row);
    assertEquals(row.invocation_ref, null);
    assertEquals(row.authorization_ref, null);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine preserves root objects whose data includes value siblings", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:value-siblings",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:value-siblings",
          value: toEntityDocument("hello", undefined, {
            other: "data",
          }),
        }],
      },
    });

    assertEquals(
      read(engine, { id: "entity:value-siblings" }),
      toEntityDocument("hello", undefined, {
        other: "data",
      }),
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine replays patch revisions for current and point-in-time reads", async () => {
  const { engine, path } = await createEngine();

  try {
    const original = toEntityDocument(
      {
        profile: { name: "Alice" },
        tags: ["one"],
      },
      entityRefFromString("origin"),
    );

    applyCommit(engine, {
      sessionId: "session:patch",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:patch",
          value: original,
        }],
      },
    });

    applyCommit(engine, {
      sessionId: "session:patch",
      invocation: invocationFor(2),
      authorization,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "entity:patch",
          patches: [
            { op: "replace", path: "/value/profile/name", value: "Bob" },
            { op: "add", path: "/value/profile/title", value: "Dr" },
            {
              op: "splice",
              path: "/value/tags",
              index: 1,
              remove: 0,
              add: ["two", "three"],
            },
          ],
        }],
      },
    });

    assertEquals(
      read(engine, { id: "entity:patch" }),
      toEntityDocument(
        {
          profile: { name: "Bob", title: "Dr" },
          tags: ["one", "two", "three"],
        },
        entityRefFromString("origin"),
      ),
    );
    assertEquals(read(engine, { id: "entity:patch", seq: 1 }), original);

    const patchRevision = engine.database.prepare(
      `SELECT op, data
       FROM revision
       WHERE id = 'entity:patch' AND seq = 2`,
    ).get() as
      | {
        op: string;
        data: string;
      }
      | undefined;
    assertEquals(patchRevision?.op, "patch");
    assertEquals(decodeStored(patchRevision?.data), [
      { op: "replace", path: "/value/profile/name", value: "Bob" },
      { op: "add", path: "/value/profile/title", value: "Dr" },
      {
        op: "splice",
        path: "/value/tags",
        index: 1,
        remove: 0,
        add: ["two", "three"],
      },
    ]);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine materializes snapshots and reuses them for later reads", async () => {
  const { engine, path } = await createEngineWithOptions({
    snapshotInterval: 2,
  });

  try {
    applyCommit(engine, {
      sessionId: "session:snapshot",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:snapshot",
          value: toEntityDocument({ tags: ["one"] }),
        }],
      },
    });

    for (const [localSeq, value] of [[2, "two"], [3, "three"]] as const) {
      applyCommit(engine, {
        sessionId: "session:snapshot",
        invocation: invocationFor(localSeq),
        authorization,
        commit: {
          localSeq,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "patch",
            id: "entity:snapshot",
            patches: [{
              op: "splice",
              path: "/value/tags",
              index: localSeq - 1,
              remove: 0,
              add: [value],
            }],
          }],
        },
      });
    }

    const snapshotRow = engine.database.prepare(
      `SELECT seq, value
       FROM snapshot
       WHERE branch = '' AND id = 'entity:snapshot'
       ORDER BY seq DESC
       LIMIT 1`,
    ).get() as
      | {
        seq: number;
        value: string;
      }
      | undefined;
    assertEquals(snapshotRow?.seq, 3);
    assertEquals(decodeStored(snapshotRow?.value), {
      value: { tags: ["one", "two", "three"] },
    });

    applyCommit(engine, {
      sessionId: "session:snapshot",
      invocation: invocationFor(4),
      authorization,
      commit: {
        localSeq: 4,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "entity:snapshot",
          patches: [{
            op: "splice",
            path: "/value/tags",
            index: 3,
            remove: 0,
            add: ["four"],
          }],
        }],
      },
    });

    engine.database.prepare(
      "DELETE FROM revision WHERE id = 'entity:snapshot' AND seq = 2",
    ).run();

    assertEquals(
      read(engine, { id: "entity:snapshot", seq: 3 }),
      toEntityDocument({ tags: ["one", "two", "three"] }),
    );
    assertEquals(
      read(engine, { id: "entity:snapshot" }),
      toEntityDocument({ tags: ["one", "two", "three", "four"] }),
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine compacts old snapshots beyond retention", async () => {
  const { engine, path } = await createEngineWithOptions({
    snapshotInterval: 1,
    snapshotRetention: 2,
  });

  try {
    applyCommit(engine, {
      sessionId: "session:snapshot-retention",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:snapshot-retention",
          value: toEntityDocument({ tags: ["one"] }),
        }],
      },
    });

    for (
      const [localSeq, value] of [[2, "two"], [3, "three"], [
        4,
        "four",
      ]] as const
    ) {
      applyCommit(engine, {
        sessionId: "session:snapshot-retention",
        invocation: invocationFor(localSeq),
        authorization,
        commit: {
          localSeq,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "patch",
            id: "entity:snapshot-retention",
            patches: [{
              op: "splice",
              path: "/value/tags",
              index: localSeq - 1,
              remove: 0,
              add: [value],
            }],
          }],
        },
      });
    }

    const snapshotRows = engine.database.prepare(
      `SELECT seq
       FROM snapshot
       WHERE branch = '' AND id = 'entity:snapshot-retention'
       ORDER BY seq ASC`,
    ).all() as Array<{ seq: number }>;
    assertEquals(snapshotRows, [{ seq: 3 }, { seq: 4 }]);
    assertEquals(
      read(engine, { id: "entity:snapshot-retention", seq: 2 }),
      toEntityDocument({ tags: ["one", "two"] }),
    );
    assertEquals(
      read(engine, { id: "entity:snapshot-retention" }),
      toEntityDocument({ tags: ["one", "two", "three", "four"] }),
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine rejects stale confirmed reads and allows non-overlapping ones", async () => {
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
          id: "entity:source",
          value: toEntityDocument({
            profile: { name: "Alice" },
            settings: { theme: "light" },
          }),
        }],
      },
    });

    applyCommit(engine, {
      sessionId: "session:other",
      invocation: invocationFor(1, { actor: "other" }),
      authorization,
      commit: {
        localSeq: 1,
        reads: {
          confirmed: [{
            id: "entity:source",
            path: toDocumentPath(["value", "settings"]),
            seq: 1,
          }],
          pending: [],
        },
        operations: [{
          op: "patch",
          id: "entity:source",
          patches: [{
            op: "replace",
            path: "/value/settings/theme",
            value: "dark",
          }],
        }],
      },
    });

    const allowed = applyCommit(engine, {
      sessionId: "session:1",
      invocation: invocationFor(2),
      authorization,
      commit: {
        localSeq: 2,
        reads: {
          confirmed: [{
            id: "entity:source",
            path: toDocumentPath(["value", "profile", "name"]),
            seq: 1,
          }],
          pending: [],
        },
        operations: [{
          op: "set",
          id: "entity:derived",
          value: toEntityDocument({ derivedFromName: true }),
        }],
      },
    });
    assertEquals(allowed.seq, 3);

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
                id: "entity:source",
                path: toDocumentPath(["value", "settings"]),
                seq: 1,
              }],
              pending: [],
            },
            operations: [{
              op: "set",
              id: "entity:rejected",
              value: toEntityDocument({ ok: false }),
            }],
          },
        }),
      Error,
      "stale confirmed read",
    );

    assertEquals(read(engine, { id: "entity:derived" }), {
      value: { derivedFromName: true },
    });
    assertEquals(read(engine, { id: "entity:rejected" }), null);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine resolves pending reads and rejects stale pending reads", async () => {
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
          id: "entity:source",
          value: toEntityDocument({ foo: 0, bar: 0 }),
        }],
      },
    });

    const base = applyCommit(engine, {
      sessionId: "session:1",
      invocation: invocationFor(2),
      authorization,
      commit: {
        localSeq: 2,
        reads: {
          confirmed: [{
            id: "entity:source",
            path: toDocumentPath(["value", "foo"]),
            seq: 1,
          }],
          pending: [],
        },
        operations: [{
          op: "patch",
          id: "entity:source",
          patches: [{ op: "replace", path: "/value/foo", value: 1 }],
        }],
      },
    });
    assertEquals(base.seq, 2);

    const derived = applyCommit(engine, {
      sessionId: "session:1",
      invocation: invocationFor(3),
      authorization,
      commit: {
        localSeq: 3,
        reads: {
          confirmed: [],
          pending: [{
            id: "entity:source",
            path: toDocumentPath(["value", "foo"]),
            localSeq: 2,
          }],
        },
        operations: [{
          op: "set",
          id: "entity:target",
          value: toEntityDocument({ derived: true }),
        }],
      },
    });
    assertEquals(derived.seq, 3);

    const resolutionRow = engine.database.prepare(
      `SELECT resolution
       FROM "commit"
       WHERE session_id = 'session:1' AND local_seq = 3`,
    ).get() as { resolution: string } | undefined;
    assertEquals(decodeStored(resolutionRow?.resolution), {
      seq: 3,
      resolvedPendingReads: [{
        localSeq: 2,
        seq: 2,
      }],
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
          id: "entity:source",
          patches: [{ op: "replace", path: "/value/bar", value: 1 }],
        }],
      },
    });

    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:1",
          invocation: invocationFor(4),
          authorization,
          commit: {
            localSeq: 4,
            reads: {
              confirmed: [],
              pending: [{
                id: "entity:source",
                path: toDocumentPath(["value", "bar"]),
                localSeq: 2,
              }],
            },
            operations: [{
              op: "set",
              id: "entity:broken",
              value: toEntityDocument({ ok: false }),
            }],
          },
        }),
      Error,
      "stale pending read",
    );

    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:1",
          invocation: invocationFor(5),
          authorization,
          commit: {
            localSeq: 5,
            reads: {
              confirmed: [],
              pending: [{
                id: "entity:source",
                path: toDocumentPath(["value"]),
                localSeq: 99,
              }],
            },
            operations: [{
              op: "set",
              id: "entity:missing",
              value: toEntityDocument({ ok: false }),
            }],
          },
        }),
      Error,
      "pending dependency",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

// CT-1872 1c: an array localSeq names every pending layer the read sat on.
// Non-highest elements impose resolution ONLY (the dependency must have an
// accepted commit row) — staleness is based at the HIGHEST element, so a
// foreign write that lands before the highest element's resolution must NOT
// reject the read, while an unresolved element still must.
//
// NOTE: this pins main's de-facto basis semantics made explicit on the wire,
// not an endorsement of the scan interval. The staleness scan starts at the
// highest layer's resolution seq, so foreign writes in (reader's confirmed
// basis, that resolution] go unscanned — a pre-existing gap tracked as
// CT-1910 (pending-read basis over-advance), whose fix (own-session
// exclusion + true-basis validation) supersedes the max-basis rule.
Deno.test("memory v2 engine: array pending reads scan at the highest layer and require every layer to resolve", async () => {
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
          id: "entity:source",
          value: toEntityDocument({ foo: 0 }),
        }],
      },
    });

    // The dependency: localSeq 2 commits durably (seq 2).
    const dependency = applyCommit(engine, {
      sessionId: "session:1",
      invocation: invocationFor(2),
      authorization,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "entity:source",
          patches: [{ op: "replace", path: "/value/foo", value: 1 }],
        }],
      },
    });
    assertEquals(dependency.seq, 2);

    // A LATER overlapping foreign write to the same doc (a whole-doc set is
    // path-blind, so it overlaps ANY read of entity:source): a normal pending
    // read via localSeq 2 is now stale.
    applyCommit(engine, {
      sessionId: "session:other",
      invocation: invocationFor(1, { actor: "other" }),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:source",
          value: toEntityDocument({ foo: 2 }),
        }],
      },
    });

    // A newer same-session blind layer (localSeq 3, zero reads) lands AFTER
    // the foreign write: the doc's stack top below the reader.
    const top = applyCommit(engine, {
      sessionId: "session:1",
      invocation: invocationFor(3),
      authorization,
      commit: {
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "entity:source",
          patches: [{ op: "add", path: "/value/blind", value: true }],
        }],
      },
    });
    assertEquals(top.seq, 4);

    // Array [2, 3]: staleness is based at the HIGHEST layer (3 → seq 4), so
    // the foreign seq-3 write is outside the scan; element 2 imposes
    // resolution only ⇒ ACCEPTED.
    const accepted = applyCommit(engine, {
      sessionId: "session:1",
      invocation: invocationFor(4),
      authorization,
      commit: {
        localSeq: 4,
        reads: {
          confirmed: [],
          pending: [{
            id: "entity:source",
            path: toDocumentPath([]),
            localSeq: [2, 3],
          }],
        },
        operations: [{
          op: "set",
          id: "entity:target",
          value: toEntityDocument({ derived: true }),
        }],
      },
    });
    assertEquals(accepted.seq, 5);

    // The array does NOT waive resolution for any element: one uncommitted
    // member rejects the whole read.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:1",
          invocation: invocationFor(5),
          authorization,
          commit: {
            localSeq: 5,
            reads: {
              confirmed: [],
              pending: [{
                id: "entity:source",
                path: toDocumentPath([]),
                localSeq: [2, 99],
              }],
            },
            operations: [{
              op: "set",
              id: "entity:unresolved",
              value: toEntityDocument({ ok: false }),
            }],
          },
        }),
      ConflictError,
      "pending dependency not resolved",
    );

    // Malformed dependency sets are protocol violations, not conflicts: an
    // empty array names no layer at all…
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:1",
          invocation: invocationFor(7),
          authorization,
          commit: {
            localSeq: 7,
            reads: {
              confirmed: [],
              pending: [{
                id: "entity:source",
                path: toDocumentPath([]),
                localSeq: [],
              }],
            },
            operations: [{
              op: "set",
              id: "entity:malformed-empty",
              value: toEntityDocument({ ok: false }),
            }],
          },
        }),
      ProtocolError,
      "names no localSeq",
    );

    // …and a non-integer element is not a localSeq.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:1",
          invocation: invocationFor(8),
          authorization,
          commit: {
            localSeq: 8,
            reads: {
              confirmed: [],
              pending: [{
                id: "entity:source",
                path: toDocumentPath([]),
                localSeq: [1.5],
              }],
            },
            operations: [{
              op: "set",
              id: "entity:malformed-float",
              value: toEntityDocument({ ok: false }),
            }],
          },
        }),
      ProtocolError,
      "non-integer localSeq",
    );

    // Control: based at the LOWER layer alone (scalar 2), the foreign seq-3
    // write is inside the scan interval — the max-basis rule, not the
    // scenario, is what admitted the commit above.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:1",
          invocation: invocationFor(6),
          authorization,
          commit: {
            localSeq: 6,
            reads: {
              confirmed: [],
              pending: [{
                id: "entity:source",
                path: toDocumentPath([]),
                localSeq: 2,
              }],
            },
            operations: [{
              op: "set",
              id: "entity:control",
              value: toEntityDocument({ ok: false }),
            }],
          },
        }),
      ConflictError,
      "stale pending read",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

// CT-1872 1c, end to end at the engine: a fabricated composite must die on
// the resolution edge, because no staleness scan can catch it.
//
//   base:  D = { items: [] }                                  (seq 1)
//   T1  (localSeq 10): items = ["A"]  — REJECTED (stale read on title)
//   T1.5 (localSeq 11): blind append "B", zero reads — APPLIED → items ["B"]
//   T2  (localSeq 12): observed items ["A","B"] through the client stack
//
// T2's observation is not STALE — ["A","B"] never existed at any seq; "A"
// lived only in the client's optimistic layer for a commit the server
// refused. An under-declared T2 (scalar top-of-stack read: what a client
// emits toward a server without the `pendingReadStacks` flag) passes both
// resolution (T1.5 has a commit row) and the staleness scan (nothing touched
// items after seq(T1.5)) and is durably ACCEPTED with a phantom premise.
// The full-stack array shape (#4606) also names T1, and the missing commit
// row rejects it.
Deno.test("memory v2 engine: full-stack dependency recording rejects a fabricated composite an under-declared commit smuggles through", async () => {
  const { engine, path } = await createEngine();

  try {
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
          value: toEntityDocument({ items: [], title: "t0" }),
        }],
      },
    });

    // Foreign write (seq 2) bumps title so T1's confirmed read goes stale.
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
          patches: [{
            op: "replace",
            path: "/value/title",
            value: "t-foreign",
          }],
        }],
      },
    });

    // T1: REJECTED — its items=["A"] write is discarded everywhere.
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
              patches: [{
                op: "replace",
                path: "/value/items",
                value: ["A"],
              }],
            }],
          },
        }),
      ConflictError,
      "stale confirmed read",
    );

    // T1.5: blind append, zero reads — applies onto the T1-less base.
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

    // Under-declared shape (pre-#4606 client): top-of-stack read only.
    // ACCEPTED — resolution and staleness both legitimately pass, and the
    // phantom ["A","B"] premise lands durably. This pins WHY the full-stack
    // shape below is load-bearing (and stays reachable via version skew).
    const smuggled = applyCommit(engine, {
      sessionId: "session:1",
      invocation: invocationFor(12),
      authorization,
      commit: {
        localSeq: 12,
        reads: {
          confirmed: [],
          pending: [{
            id: "entity:D",
            path: toDocumentPath(["value", "items"]),
            localSeq: 11,
          }],
        },
        operations: [{
          op: "set",
          id: "entity:phantom",
          value: toEntityDocument({ observedItems: ["A", "B"] }),
        }],
      },
    });
    assertEquals(smuggled.seq, 4);
    const durable = read(engine, { id: "entity:D" });
    assertEquals(
      (durable as { value?: { items?: unknown } } | null)?.value?.items,
      ["B"],
    );

    // Full-stack array shape (#4606): the same observation also names T1,
    // whose commit row does not exist — rejected on the resolution edge.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:1",
          invocation: invocationFor(13),
          authorization,
          commit: {
            localSeq: 13,
            reads: {
              confirmed: [],
              pending: [{
                id: "entity:D",
                path: toDocumentPath(["value", "items"]),
                localSeq: [10, 11],
              }],
            },
            operations: [{
              op: "set",
              id: "entity:caught",
              value: toEntityDocument({ observedItems: ["A", "B"] }),
            }],
          },
        }),
      ConflictError,
      "pending dependency not resolved: 10",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine reconstructs state across delete boundaries", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:timeline",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:timeline",
          value: toEntityDocument({
            phase: "one",
            data: { start: true },
          }),
        }],
      },
    });
    applyCommit(engine, {
      sessionId: "session:timeline",
      invocation: invocationFor(2),
      authorization,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "entity:timeline",
          patches: [{ op: "add", path: "/value/data/step", value: 2 }],
        }],
      },
    });
    applyCommit(engine, {
      sessionId: "session:timeline",
      invocation: invocationFor(3),
      authorization,
      commit: {
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "delete", id: "entity:timeline" }],
      },
    });
    applyCommit(engine, {
      sessionId: "session:timeline",
      invocation: invocationFor(4),
      authorization,
      commit: {
        localSeq: 4,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:timeline",
          value: toEntityDocument({
            phase: "two",
            data: { restart: true },
          }),
        }],
      },
    });

    assertEquals(
      read(engine, { id: "entity:timeline", seq: 1 }),
      toEntityDocument({ phase: "one", data: { start: true } }),
    );
    assertEquals(
      read(engine, { id: "entity:timeline", seq: 2 }),
      toEntityDocument({ phase: "one", data: { start: true, step: 2 } }),
    );
    assertEquals(read(engine, { id: "entity:timeline", seq: 3 }), null);
    assertEquals(
      read(engine, { id: "entity:timeline" }),
      toEntityDocument({ phase: "two", data: { restart: true } }),
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine supports branch inheritance, divergence, and deletion", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:branch",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:branch-doc",
          value: toEntityDocument({ count: 1 }),
        }],
      },
    });

    assertEquals(createBranch(engine, DEFAULT_BRANCH), {
      name: DEFAULT_BRANCH,
      parentBranch: null,
      forkSeq: null,
      createdSeq: 0,
      headSeq: 1,
      status: "active",
    });
    const featureBranch = {
      name: "feature",
      parentBranch: DEFAULT_BRANCH,
      forkSeq: 1,
      createdSeq: 1,
      headSeq: 1,
      status: "active" as const,
    };
    assertEquals(
      createBranch(engine, "feature"),
      featureBranch,
    );
    assertEquals(createBranch(engine, "feature"), featureBranch);
    assertEquals(
      read(engine, { id: "entity:branch-doc", branch: "feature" }),
      toEntityDocument({ count: 1 }),
    );

    applyCommit(engine, {
      sessionId: "session:branch",
      invocation: invocationFor(2),
      authorization,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:branch-doc",
          value: toEntityDocument({ count: 2 }),
        }],
      },
    });

    applyCommit(engine, {
      sessionId: "session:branch",
      invocation: invocationFor(3),
      authorization,
      commit: {
        localSeq: 3,
        branch: "feature",
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:branch-doc",
          value: toEntityDocument({ count: 10 }),
        }],
      },
    });

    assertEquals(
      read(engine, { id: "entity:branch-doc" }),
      toEntityDocument({ count: 2 }),
    );
    assertEquals(
      read(engine, { id: "entity:branch-doc", branch: "feature" }),
      toEntityDocument({ count: 10 }),
    );
    assertEquals(
      listBranches(engine),
      [{
        name: "",
        parentBranch: null,
        forkSeq: null,
        createdSeq: 0,
        headSeq: 2,
        status: "active",
      }, {
        name: "feature",
        parentBranch: "",
        forkSeq: 1,
        createdSeq: 1,
        headSeq: 3,
        status: "active",
      }],
    );

    deleteBranch(engine, "feature");
    assertEquals(
      listBranches(engine).find((branch) => branch.name === "feature"),
      {
        name: "feature",
        parentBranch: "",
        forkSeq: 1,
        createdSeq: 1,
        headSeq: 3,
        status: "deleted",
      },
    );
    assertEquals(
      read(engine, { id: "entity:branch-doc", branch: "feature" }),
      toEntityDocument({ count: 10 }),
    );
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:branch",
          invocation: invocationFor(4),
          authorization,
          commit: {
            localSeq: 4,
            branch: "feature",
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: "entity:branch-doc",
              value: toEntityDocument({ count: 11 }),
            }],
          },
        }),
      Error,
      "branch is not active",
    );
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:branch",
          invocation: invocationFor(5),
          authorization,
          commit: {
            localSeq: 5,
            branch: "missing",
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: "entity:branch-doc",
              value: toEntityDocument({ count: 12 }),
            }],
          },
        }),
      Error,
      "unknown branch: missing",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine rejects branch reads before createdSeq", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:branch-bounds",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:branch-bounds-doc",
          value: toEntityDocument({ count: 1 }),
        }],
      },
    });
    createBranch(engine, "feature");

    assertThrows(
      () =>
        read(engine, {
          id: "entity:branch-bounds-doc",
          branch: "feature",
          seq: 0,
        }),
      Error,
      "seq 0 is out of range for branch feature",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine persists fabric patch values at the storage boundary", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:rich-patch",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:rich-patch",
          value: toEntityDocument({ counter: 1n }),
        }],
      },
    });

    applyCommit(engine, {
      sessionId: "session:rich-patch",
      invocation: invocationFor(2),
      authorization,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "entity:rich-patch",
          patches: [{
            op: "replace",
            path: "/value/counter",
            value: 2n,
          }],
        }],
      },
    });

    assertEquals(
      read(engine, { id: "entity:rich-patch" }),
      toEntityDocument({ counter: 2n }),
    );

    const patchRow = engine.database.prepare(
      `SELECT data
         FROM revision
         WHERE id = 'entity:rich-patch' AND seq = 2`,
    ).get() as { data: string } | undefined;
    assertEquals(decodeStored(patchRow?.data), [{
      op: "replace",
      path: "/value/counter",
      value: 2n,
    }]);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine: nonRecursive shape read conflicts with a mergeable create-from-absent (createsKey) but not an append to an existing array", async () => {
  const { engine, path } = await createEngine();
  const sessionId = "session:alice";
  const principal = "did:key:alice";
  const scope = "space" as const;
  const created = "entity:created";
  const existing = "entity:existing";

  try {
    // `created`: seq 1 sets a container with NO `items`; seq 2 pushes the first
    // element, materializing `items` — the append carries `createsKey`.
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          { op: "set", id: created, scope, value: toEntityDocument({}) },
        ],
      },
    });
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: created,
          scope,
          patches: [{
            op: "append",
            path: "/value/items",
            values: ["a"],
            createsKey: true,
          }],
        }],
      },
    });

    // `existing`: seq 3 sets a container WITH `items`; seq 4 appends to it — no
    // `createsKey`, because the key already existed.
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: existing,
          scope,
          value: toEntityDocument({ items: ["a"] }),
        }],
      },
    });
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 4,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: existing,
          scope,
          patches: [{ op: "append", path: "/value/items", values: ["b"] }],
        }],
      },
    });

    // B (checked first so its commit seq is deterministic): a SHAPE reader of the
    // parent MUST NOT conflict with an append to an ALREADY-PRESENT child array —
    // only the array's contents changed, not the parent's key set.
    const ok = applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 5,
        reads: {
          confirmed: [{
            id: existing,
            scope,
            path: toDocumentPath(["value"]),
            seq: 3,
            nonRecursive: true,
          }],
          pending: [],
        },
        operations: [
          {
            op: "set",
            id: "entity:sinkB",
            scope,
            value: toEntityDocument("b"),
          },
        ],
      },
    });
    assertEquals(ok.seq, 5);

    // A: a SHAPE reader of the parent, observed BEFORE the create, MUST conflict
    // with the create-from-absent append — the parent gained the `items` key.
    // This is the gap the `createsKey` flag closes.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId,
          principal,
          commit: {
            localSeq: 6,
            reads: {
              confirmed: [{
                id: created,
                scope,
                path: toDocumentPath(["value"]),
                seq: 1,
                nonRecursive: true,
              }],
              pending: [],
            },
            operations: [
              {
                op: "set",
                id: "entity:sinkA",
                scope,
                value: toEntityDocument("a"),
              },
            ],
          },
        }),
      Error,
      "stale confirmed read",
    );

    // C: a SHAPE reader of the ARRAY ITSELF still conflicts with the append — its
    // own key set (indices / length) changed. Independent of `createsKey`.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId,
          principal,
          commit: {
            localSeq: 7,
            reads: {
              confirmed: [{
                id: existing,
                scope,
                path: toDocumentPath(["value", "items"]),
                seq: 3,
                nonRecursive: true,
              }],
              pending: [],
            },
            operations: [
              {
                op: "set",
                id: "entity:sinkC",
                scope,
                value: toEntityDocument("c"),
              },
            ],
          },
        }),
      Error,
      "stale confirmed read",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});
