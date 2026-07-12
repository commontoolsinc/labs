import { assert, assertEquals } from "@std/assert";
import { toFileUrl } from "@std/path";
import {
  close,
  createBranch,
  type Engine,
  markSchedulerReadersDirtyForWrites,
  open as openEngine,
  resolveScopeKey,
  type SchedulerActionObservation,
  type SchedulerExecutionContextKey,
  type SchedulerObservationAddress,
  type SchedulerScopeContext,
  staleReadersForTargets,
  upsertSchedulerObservation,
} from "../v2/engine.ts";
import { Server } from "../v2/server.ts";
import { resolveSpaceStoreUrl } from "../v2/storage-path.ts";
import { testSessionOpenServerOptions } from "./v2-auth-test-helpers.ts";

const OWNER_SPACE = "did:key:stale-reader-owner";

const ALICE = {
  principal: "did:key:stale-reader-alice",
  sessionId: "alice-session",
} as const satisfies SchedulerScopeContext;
const BOB = {
  principal: "did:key:stale-reader-bob",
  sessionId: "bob-session",
} as const satisfies SchedulerScopeContext;

const SPACE_CONTEXT = resolveScopeKey(
  "space",
  ALICE,
) as SchedulerExecutionContextKey;
const ALICE_USER_CONTEXT = resolveScopeKey(
  "user",
  ALICE,
) as SchedulerExecutionContextKey;
const BOB_USER_CONTEXT = resolveScopeKey(
  "user",
  BOB,
) as SchedulerExecutionContextKey;

const address = (
  id: string,
  path: readonly string[] = ["value"],
  scope: "space" | "user" | "session" = "space",
  space = OWNER_SPACE,
): SchedulerObservationAddress => ({ space, id, scope, path });

const observation = (options: {
  branch?: string;
  pieceId: string;
  actionId: string;
  reads: readonly SchedulerObservationAddress[];
  shallowReads?: readonly SchedulerObservationAddress[];
  writes: readonly SchedulerObservationAddress[];
}): SchedulerActionObservation => {
  const branch = options.branch ?? "";
  const implementationFingerprint = `impl:${options.actionId}`;
  const pieceSeparator = options.pieceId.indexOf(":");
  const pieceScope = options.pieceId.slice(0, pieceSeparator) as
    | "space"
    | "user"
    | "session";
  const pieceRoot = address(
    options.pieceId.slice(pieceSeparator + 1),
    [],
    pieceScope,
  );
  return {
    version: 2,
    ownerSpace: OWNER_SPACE,
    branch,
    pieceId: options.pieceId,
    processGeneration: 1,
    actionId: options.actionId,
    actionKind: "computation",
    implementationFingerprint,
    runtimeFingerprint: "runtime:stale-reader-test",
    completeActionScopeSummary: {
      version: 1,
      complete: true,
      implementationFingerprint,
      runtimeFingerprint: "runtime:stale-reader-test",
      piece: pieceRoot,
      reads: [...options.reads, ...(options.shallowReads ?? [])],
      writes: [...options.writes],
      materializerWriteEnvelopes: [],
      directOutputs: [...options.writes],
    },
    observedAtSeq: 0,
    transactionKind: "action-run",
    reads: [...options.reads],
    shallowReads: [...(options.shallowReads ?? [])],
    actualChangedWrites: [],
    currentKnownWrites: [...options.writes],
    materializerWriteEnvelopes: [],
    ignoredSchedulingWrites: [],
    actionOptions: {},
    status: "success",
  };
};

const store = (
  engine: Engine,
  value: SchedulerActionObservation,
  scopeContext: SchedulerScopeContext = ALICE,
) =>
  upsertSchedulerObservation(engine, {
    branch: value.branch,
    ownerSpace: OWNER_SPACE,
    observedAtSeq: 0,
    observation: value,
    scopeContext,
  });

const withEngine = async (
  run: (engine: Engine) => void | Promise<void>,
): Promise<void> => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await openEngine({ url: toFileUrl(path) });
  try {
    await run(engine);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
};

Deno.test("stale reader lookup returns distinct transitive demanded actions", async () => {
  await withEngine((engine) => {
    const source = address("of:source", ["value", "container"]);
    const sourceLeaf = address("of:source", [
      "value",
      "container",
      "leaf",
    ]);
    const intermediate = address("of:intermediate", ["value"]);
    const demandedPieceId = "space:of:demanded-piece";

    store(
      engine,
      observation({
        pieceId: "space:of:undemanded-bridge",
        actionId: "bridge-action",
        reads: [source],
        writes: [intermediate],
      }),
    );
    const demanded = store(
      engine,
      observation({
        pieceId: demandedPieceId,
        actionId: "demanded-action",
        // Two overlapping rows prove that result identity, not read-row
        // identity, controls deduplication.
        reads: [
          intermediate,
          address("of:intermediate", ["value", "child"]),
        ],
        writes: [address("of:demanded-output")],
      }),
    );

    markSchedulerReadersDirtyForWrites(engine, {
      branch: "",
      ownerSpace: OWNER_SPACE,
      dirtySeq: 17,
      writes: [sourceLeaf],
    });

    assertEquals(
      staleReadersForTargets(engine, {
        branch: "",
        ownerSpace: OWNER_SPACE,
        targets: [sourceLeaf, sourceLeaf, address("of:source", ["value"])],
        demandedSchedulerPieceIds: [demandedPieceId, demandedPieceId],
        applicableExecutionContextKeys: [SPACE_CONTEXT, SPACE_CONTEXT],
        dirtySeq: 17,
      }),
      [{
        branch: "",
        ownerSpace: OWNER_SPACE,
        pieceId: demandedPieceId,
        processGeneration: 1,
        actionId: "demanded-action",
        executionContextKey: SPACE_CONTEXT,
        latestObservationId: demanded.observationId,
        directDirtySeq: null,
        staleSeq: 17,
        unknownReason: null,
      }],
    );

    // A disjoint sibling has no direct indexed reader, even though the
    // downstream action remains durably stale from the earlier write.
    assertEquals(
      staleReadersForTargets(engine, {
        branch: "",
        ownerSpace: OWNER_SPACE,
        targets: [address("of:source", ["value", "sibling"])],
        demandedSchedulerPieceIds: [demandedPieceId],
        applicableExecutionContextKeys: [SPACE_CONTEXT],
        dirtySeq: 17,
      }),
      [],
    );
  });
});

Deno.test("stale reader lookup filters demanded pieces and clean rows", async () => {
  await withEngine((engine) => {
    const source = address("of:source");
    const dirtyDemandedPieceId = "space:of:dirty-demanded";
    const cleanDemandedPieceId = "space:of:clean-demanded";
    const undemandedPieceId = "space:of:undemanded";

    store(
      engine,
      observation({
        pieceId: dirtyDemandedPieceId,
        actionId: "dirty-demanded-action",
        reads: [source],
        writes: [address("of:dirty-output")],
      }),
    );
    store(
      engine,
      observation({
        pieceId: cleanDemandedPieceId,
        actionId: "clean-demanded-action",
        reads: [address("of:clean-source")],
        writes: [address("of:clean-output")],
      }),
    );
    store(
      engine,
      observation({
        pieceId: undemandedPieceId,
        actionId: "undemanded-action",
        reads: [source],
        writes: [address("of:undemanded-output")],
      }),
    );

    markSchedulerReadersDirtyForWrites(engine, {
      ownerSpace: OWNER_SPACE,
      dirtySeq: 23,
      writes: [source],
    });

    assertEquals(
      staleReadersForTargets(engine, {
        ownerSpace: OWNER_SPACE,
        targets: [source],
        demandedSchedulerPieceIds: [
          dirtyDemandedPieceId,
          cleanDemandedPieceId,
        ],
        applicableExecutionContextKeys: [SPACE_CONTEXT],
        dirtySeq: 23,
      }).map(({ pieceId, actionId }) => ({ pieceId, actionId })),
      [{
        pieceId: dirtyDemandedPieceId,
        actionId: "dirty-demanded-action",
      }],
    );
  });
});

Deno.test("stale reader lookup isolates branch, effective scope, and context", async () => {
  await withEngine((engine) => {
    const scopedInput = address("of:scoped-input", ["value"], "user");
    const alicePieceId = "user:of:alice-piece";
    const bobPieceId = "user:of:bob-piece";
    createBranch(engine, "other");

    store(
      engine,
      observation({
        pieceId: alicePieceId,
        actionId: "alice-action",
        reads: [scopedInput],
        writes: [address("of:alice-output", ["value"], "user")],
      }),
      ALICE,
    );
    store(
      engine,
      observation({
        pieceId: bobPieceId,
        actionId: "bob-action",
        reads: [scopedInput],
        writes: [address("of:bob-output", ["value"], "user")],
      }),
      BOB,
    );
    store(
      engine,
      observation({
        branch: "other",
        pieceId: alicePieceId,
        actionId: "other-branch-action",
        reads: [scopedInput],
        writes: [address("of:other-branch-output", ["value"], "user")],
      }),
      ALICE,
    );

    const aliceTarget = {
      ...scopedInput,
      scopeKey: ALICE_USER_CONTEXT,
    };
    const bobTarget = {
      ...scopedInput,
      scopeKey: BOB_USER_CONTEXT,
    };
    markSchedulerReadersDirtyForWrites(engine, {
      branch: "",
      ownerSpace: OWNER_SPACE,
      dirtySeq: 31,
      writes: [aliceTarget],
    });
    markSchedulerReadersDirtyForWrites(engine, {
      branch: "",
      ownerSpace: OWNER_SPACE,
      dirtySeq: 32,
      writes: [bobTarget],
    });
    markSchedulerReadersDirtyForWrites(engine, {
      branch: "other",
      ownerSpace: OWNER_SPACE,
      dirtySeq: 33,
      writes: [aliceTarget],
    });

    const demandedSchedulerPieceIds = [alicePieceId, bobPieceId];
    assertEquals(
      staleReadersForTargets(engine, {
        branch: "",
        ownerSpace: OWNER_SPACE,
        targets: [aliceTarget],
        demandedSchedulerPieceIds,
        applicableExecutionContextKeys: [ALICE_USER_CONTEXT],
        dirtySeq: 31,
      }).map((state) => [state.actionId, state.executionContextKey]),
      [["alice-action", ALICE_USER_CONTEXT]],
    );
    assertEquals(
      staleReadersForTargets(engine, {
        branch: "",
        ownerSpace: OWNER_SPACE,
        targets: [bobTarget],
        demandedSchedulerPieceIds,
        applicableExecutionContextKeys: [ALICE_USER_CONTEXT],
        dirtySeq: 32,
      }),
      [],
    );
    assertEquals(
      staleReadersForTargets(engine, {
        branch: "other",
        ownerSpace: OWNER_SPACE,
        targets: [aliceTarget],
        demandedSchedulerPieceIds,
        applicableExecutionContextKeys: [ALICE_USER_CONTEXT],
        dirtySeq: 33,
      }).map((state) => state.actionId),
      ["other-branch-action"],
    );

    // The same effective space-scoped target can feed independently owned
    // user-context actions. Context filtering must isolate those rows even
    // though their target scope key is identical.
    const sharedInput = address("of:shared-input");
    const aliceSharedPieceId = "user:of:alice-shared-piece";
    const bobSharedPieceId = "user:of:bob-shared-piece";
    store(
      engine,
      observation({
        pieceId: aliceSharedPieceId,
        actionId: "alice-shared-action",
        reads: [sharedInput],
        writes: [address("of:alice-shared-output", ["value"], "user")],
      }),
      ALICE,
    );
    store(
      engine,
      observation({
        pieceId: bobSharedPieceId,
        actionId: "bob-shared-action",
        reads: [sharedInput],
        writes: [address("of:bob-shared-output", ["value"], "user")],
      }),
      BOB,
    );
    markSchedulerReadersDirtyForWrites(engine, {
      branch: "",
      ownerSpace: OWNER_SPACE,
      dirtySeq: 34,
      writes: [sharedInput],
    });

    assertEquals(
      staleReadersForTargets(engine, {
        branch: "",
        ownerSpace: OWNER_SPACE,
        targets: [sharedInput],
        demandedSchedulerPieceIds: [
          aliceSharedPieceId,
          bobSharedPieceId,
        ],
        applicableExecutionContextKeys: [ALICE_USER_CONTEXT],
        dirtySeq: 34,
      }).map((state) => state.actionId),
      ["alice-shared-action"],
    );
    assertEquals(
      staleReadersForTargets(engine, {
        branch: "",
        ownerSpace: OWNER_SPACE,
        targets: [sharedInput],
        demandedSchedulerPieceIds: [
          aliceSharedPieceId,
          bobSharedPieceId,
        ],
        applicableExecutionContextKeys: [BOB_USER_CONTEXT],
        dirtySeq: 34,
      }).map((state) => state.actionId),
      ["bob-shared-action"],
    );
  });
});

Deno.test("stale reader lookup uses target and action-state indexes", async () => {
  await withEngine((engine) => {
    const targetPlan = engine.database.prepare(`
      EXPLAIN QUERY PLAN
      SELECT observation_id
      FROM scheduler_read_index
      WHERE branch = :branch
        AND read_space = :read_space
        AND read_id = :read_id
        AND read_scope_key = :read_scope_key
    `).all({
      branch: "",
      read_space: OWNER_SPACE,
      read_id: "of:source",
      read_scope_key: "space",
    }) as Array<{ detail: string }>;
    assert(
      targetPlan.some((row) =>
        row.detail.includes("idx_scheduler_read_index_lookup")
      ),
      `expected indexed reader target lookup, got ${
        JSON.stringify(targetPlan)
      }`,
    );

    const statePlan = engine.database.prepare(`
      EXPLAIN QUERY PLAN
      SELECT action_id
      FROM scheduler_action_state
      WHERE branch = :branch
        AND owner_space = :owner_space
        AND piece_id IN (:piece_id)
        AND execution_context_key IN (:context_key)
        AND (
          direct_dirty_seq >= :dirty_seq OR
          stale_seq >= :dirty_seq OR
          unknown_reason IS NOT NULL
        )
    `).all({
      branch: "",
      owner_space: OWNER_SPACE,
      piece_id: "space:of:piece",
      context_key: SPACE_CONTEXT,
      dirty_seq: 1,
    }) as Array<{ detail: string }>;
    assert(
      statePlan.some((row) =>
        row.detail.includes("sqlite_autoindex_scheduler_action_state_1")
      ),
      `expected indexed action-state lookup, got ${JSON.stringify(statePlan)}`,
    );

    // This exact column order is the efficiency contract for demanded-piece
    // filtering after the target index proves a relevant dependency.
    assertEquals(
      (engine.database.prepare(`
        PRAGMA index_info('sqlite_autoindex_scheduler_action_state_1')
      `).all() as Array<{ seqno: number; name: string }>)
        .sort((left, right) => left.seqno - right.seqno)
        .map((row) => row.name),
      [
        "branch",
        "owner_space",
        "piece_id",
        "process_generation",
        "action_id",
        "execution_context_key",
      ],
    );
  });
});

Deno.test("server exposes stale reader lookup only as a host process API", async () => {
  const storePath = await Deno.makeTempDir();
  const storeUrl = toFileUrl(`${storePath}/`);
  await Deno.mkdir(new URL("./engine-v3/", storeUrl), { recursive: true });
  const engine = await openEngine({
    url: resolveSpaceStoreUrl(storeUrl, OWNER_SPACE),
  });
  const source = address("of:server-source");
  const demandedSchedulerPieceId = "space:of:server-demanded";
  try {
    store(
      engine,
      observation({
        pieceId: demandedSchedulerPieceId,
        actionId: "server-demanded-action",
        reads: [source],
        writes: [address("of:server-output")],
      }),
    );
    markSchedulerReadersDirtyForWrites(engine, {
      ownerSpace: OWNER_SPACE,
      dirtySeq: 41,
      writes: [source],
    });
  } finally {
    close(engine);
  }

  const server = new Server({
    ...testSessionOpenServerOptions,
    store: storeUrl,
  });
  try {
    assertEquals(
      (await server.staleReadersForTargets(OWNER_SPACE, {
        branch: "",
        targets: [source],
        demandedSchedulerPieceIds: [demandedSchedulerPieceId],
        applicableExecutionContextKeys: [SPACE_CONTEXT],
        dirtySeq: 41,
      })).map((state) => [state.pieceId, state.actionId]),
      [[demandedSchedulerPieceId, "server-demanded-action"]],
    );
  } finally {
    await server.close();
    await Deno.remove(storePath, { recursive: true });
  }
});
