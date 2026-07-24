import { assert, assertEquals, assertExists } from "@std/assert";
import * as MemoryClient from "../v2/client.ts";
import * as Engine from "../v2/engine.ts";
import { Server } from "../v2/server.ts";
import * as MemoryV2 from "../v2.ts";
import type { AcceptedCommitEvent } from "../v2/server.ts";
import type {
  SchedulerActionObservation,
  SchedulerExecutionContextKey,
  SchedulerObservationAddress,
} from "../v2/engine.ts";

const SPACE = "did:key:z6Mk-lane-lifecycle-space";
// Colon-bearing DIDs keep the canonical percent-encoded lane keys honest.
const ALICE = "did:key:z6Mk-lane-lifecycle-alice";
const BOB = "did:key:z6Mk-lane-lifecycle-bob";
const AUDIENCE = "did:key:z6Mk-lane-lifecycle-audience";

const ALICE_CONTEXT_KEY = Engine.userExecutionContextKey(
  ALICE,
) as SchedulerExecutionContextKey;

const PIECE_ROOT = "of:lane-lifecycle:demanded-piece";
const SCHEDULER_PIECE_ID = `space:${PIECE_ROOT}`;
const ACTION_ID = "action:lane-lifecycle-reader";

const SOURCE: SchedulerObservationAddress = {
  space: SPACE,
  id: "of:lane-lifecycle:source",
  scope: "space",
  path: ["value"],
};
// A user-scoped output narrows the action's context floor to `user`, so the
// row materializes at alice's user context while still READING the shared
// space-scoped source — the design §4 cross-lane dirt shape.
const USER_OUTPUT: SchedulerObservationAddress = {
  space: SPACE,
  id: "of:lane-lifecycle:user-output",
  scope: "user",
  path: ["value"],
};

type ExecutionSession = MemoryClient.SpaceSession & {
  setExecutionDemand(
    branch: string,
    pieces: readonly string[],
  ): Promise<boolean>;
};

type LaneServer = Server & {
  openUserLaneGrant(
    space: string,
    branch: string,
    principal: string,
  ): Promise<{ laneGeneration: number; contextKey: string }>;
  userLaneGrant(
    space: string,
    branch: string,
    principal: string,
  ): { laneGeneration: number } | null;
  closeUserLaneGrant(grant: unknown): boolean;
  executionUserLanesEnabled(): boolean;
};

/** Test-only reach into the host's per-space engine (declared private). */
const engineOf = (server: Server, space: string): Promise<Engine.Engine> =>
  (server as unknown as { openEngine(space: string): Promise<Engine.Engine> })
    .openEngine(space);

const serverOptions = (
  name: string,
  acl: { mode: "off" | "enforce"; serviceDids: string[] },
) => ({
  store: new URL(`memory://${name}`),
  authorizeSessionOpen: (message: { authorization?: unknown }) => {
    const principal = (message.authorization as { principal?: unknown })
      ?.principal;
    return typeof principal === "string" ? principal : undefined;
  },
  sessionOpenAuth: { audience: AUDIENCE },
  protocolFlags: {
    serverPrimaryExecutionV1: true,
    serverPrimaryExecutionClaimRoutingV1: true,
    serverPrimaryExecutionBuiltinPassivityV1: true,
    serverPrimaryExecutionContextLatticeClaimsV1: true,
  },
  acl,
});

const createLifecycleServer = (name: string): LaneServer =>
  new Server(
    serverOptions(name, {
      mode: "off",
      serviceDids: [],
    }) as unknown as ConstructorParameters<typeof Server>[0],
  ) as LaneServer;

const connectClient = async (
  server: Server,
  options: { negotiateContextLatticeClaims?: boolean } = {},
): Promise<MemoryClient.Client> =>
  await MemoryClient.connect({
    transport: MemoryClient.loopback(server),
    protocolFlags: {
      serverPrimaryExecutionV1: true,
      serverPrimaryExecutionClaimRoutingV1: true,
      serverPrimaryExecutionBuiltinPassivityV1: true,
      serverPrimaryExecutionContextLatticeClaimsV1:
        options.negotiateContextLatticeClaims !== false,
    },
  } as MemoryClient.ConnectOptions);

const mountAs = async (
  client: MemoryClient.Client,
  principal: string,
  space = SPACE,
): Promise<ExecutionSession> =>
  await client.mount(space, {}, (_space, _session, context) => ({
    invocation: {
      aud: context.audience,
      challenge: context.challenge.value,
    },
    authorization: { principal },
  })) as ExecutionSession;

const rankDial = MemoryV2 as unknown as {
  setServerPrimaryExecutionClaimRankConfig(rank?: "space" | "user"): void;
  resetServerPrimaryExecutionClaimRankConfig(): void;
};

/** Observation-only commit shaping alice's user-context reader row: a
 * user-scoped output plus a space-scoped read of the shared source. */
const userReaderObservation = (): SchedulerActionObservation => ({
  version: 2,
  ownerSpace: SPACE,
  branch: "",
  pieceId: SCHEDULER_PIECE_ID,
  processGeneration: 1,
  actionId: ACTION_ID,
  actionKind: "computation",
  implementationFingerprint: "impl:lane-lifecycle",
  runtimeFingerprint: "runtime:lane-lifecycle",
  observedAtSeq: 0,
  transactionKind: "action-run",
  reads: [SOURCE],
  shallowReads: [],
  actualChangedWrites: [],
  currentKnownWrites: [USER_OUTPUT],
  declaredWrites: [USER_OUTPUT],
  materializerWriteEnvelopes: [],
  completeActionScopeSummary: {
    version: 1,
    complete: true,
    implementationFingerprint: "impl:lane-lifecycle",
    runtimeFingerprint: "runtime:lane-lifecycle",
    piece: { ...SOURCE, id: PIECE_ROOT, path: [] },
    reads: [SOURCE],
    writes: [USER_OUTPUT],
    materializerWriteEnvelopes: [],
    directOutputs: [USER_OUTPUT],
  },
  status: "success",
});

const writeSource = async (
  session: ExecutionSession,
  localSeq: number,
  value: string,
): Promise<void> => {
  await session.transact({
    localSeq,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set",
      id: SOURCE.id,
      value: { value },
    }],
  });
};

const userStaleRows = (event: AcceptedCommitEvent) =>
  event.staleDemandedReaders.filter(
    (reader) => reader.executionContextKey !== "space",
  );

Deno.test("A4: a space commit wakes an open user lane's reader and skips parked principals", async () => {
  const server = createLifecycleServer("memory-v2-lane-lifecycle-wake");
  const aliceClient = await connectClient(server);
  const bobClient = await connectClient(server);
  const events: AcceptedCommitEvent[] = [];
  server.subscribeAcceptedCommits(SPACE, (event) => {
    events.push(event);
  });
  try {
    const alice = await mountAs(aliceClient, ALICE);
    const bob = await mountAs(bobClient, BOB);
    // First write flips the pre-launch compatibility capability to WRITE.
    await writeSource(alice, 1, "seed");

    // Alice's user-context reader row over the shared space-scoped source.
    await alice.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: userReaderObservation(),
    });
    const engine = await engineOf(server, SPACE);
    const planted = Engine.listSchedulerActionSnapshots(engine, {
      branch: "",
      ownerSpace: SPACE,
      pieceId: SCHEDULER_PIECE_ID,
      actionId: ACTION_ID,
    }).snapshots;
    assertEquals(
      planted.map((snapshot) => snapshot.executionContextKey),
      [ALICE_CONTEXT_KEY],
      "row must land at alice's user context",
    );

    await alice.setExecutionDemand("", [PIECE_ROOT]);

    // Parked principal: demand but NO lane grant. Bob's space write records
    // dirt on alice's row without waking anything (design §4 parked-wake
    // skip).
    await writeSource(bob, 1, "parked-write");
    const parkedEvent = events.at(-1)!;
    assertEquals(userStaleRows(parkedEvent), []);
    const parkedDirt = Engine.staleReadersForTargets(engine, {
      branch: "",
      ownerSpace: SPACE,
      targets: [SOURCE],
      demandedSchedulerPieceIds: [SCHEDULER_PIECE_ID],
      applicableExecutionContextKeys: [ALICE_CONTEXT_KEY],
      dirtySeq: parkedEvent.dataSeq,
    });
    assertEquals(
      parkedDirt.map((row) => row.executionContextKey),
      [ALICE_CONTEXT_KEY],
      "parked rows still accumulate dirt",
    );

    // Open lane: the same space-scoped write now surfaces alice's
    // user-context reader in the accepted-commit wake lookup.
    await server.openUserLaneGrant(SPACE, "", ALICE);
    await writeSource(bob, 2, "lane-open-write");
    const wakeEvent = events.at(-1)!;
    assertEquals(
      userStaleRows(wakeEvent).map((reader) => ({
        pieceId: reader.pieceId,
        actionId: reader.actionId,
        executionContextKey: reader.executionContextKey,
      })),
      [{
        pieceId: SCHEDULER_PIECE_ID,
        actionId: ACTION_ID,
        executionContextKey: ALICE_CONTEXT_KEY,
      }],
    );

    // Per-lane demand pairing: bob demanding the piece does NOT stand in for
    // alice — with only bob's demand row present, alice's lane query has no
    // demanded pieces and stays silent.
    await bob.setExecutionDemand("", [PIECE_ROOT]);
    await alice.setExecutionDemand("", []);
    await writeSource(bob, 3, "foreign-demand-write");
    assertEquals(userStaleRows(events.at(-1)!), []);
  } finally {
    await aliceClient.close();
    await bobClient.close();
    await server.close();
  }
});

Deno.test("A24: demand rows carry the session's context-lattice negotiation bit", async () => {
  const server = createLifecycleServer("memory-v2-lane-lifecycle-demand-bit");
  const negotiating = await connectClient(server);
  const legacy = await connectClient(server, {
    negotiateContextLatticeClaims: false,
  });
  try {
    const alice = await mountAs(negotiating, ALICE);
    const bob = await mountAs(legacy, BOB);
    await alice.setExecutionDemand("", ["piece:negotiating"]);
    await bob.setExecutionDemand("", ["piece:legacy"]);
    const rows = server.listExecutionDemands(SPACE, "");
    assertEquals(rows.length, 2);
    const byPrincipal = new Map(
      rows.map((row) => [row.principal, row.negotiatesContextLatticeClaims]),
    );
    assertEquals(byPrincipal.get(ALICE), true);
    assertEquals(byPrincipal.get(BOB), false);
  } finally {
    await negotiating.close();
    await legacy.close();
    await server.close();
  }
});

Deno.test("closeUserLaneGrant drains exactly the named incarnation", async () => {
  const server = createLifecycleServer("memory-v2-lane-lifecycle-close");
  const client = await connectClient(server);
  try {
    const alice = await mountAs(client, ALICE);
    await writeSource(alice, 1, "seed");
    const grant = await server.openUserLaneGrant(SPACE, "", ALICE);
    assertEquals(server.closeUserLaneGrant(grant), true);
    assertEquals(server.userLaneGrant(SPACE, "", ALICE), null);
    // A stale incarnation cannot close its successor.
    const reopened = await server.openUserLaneGrant(SPACE, "", ALICE);
    assert(reopened.laneGeneration > grant.laneGeneration);
    assertEquals(server.closeUserLaneGrant(grant), false);
    assertExists(server.userLaneGrant(SPACE, "", ALICE));
  } finally {
    await client.close();
    await server.close();
  }
});

Deno.test("inertness: user lanes stay disabled until the rank dial and subcapability align", () => {
  const withSubcapability = createLifecycleServer(
    "memory-v2-lane-lifecycle-inert-subcap",
  );
  const withoutSubcapability = new Server(
    {
      ...serverOptions("memory-v2-lane-lifecycle-inert-nosubcap", {
        mode: "off",
        serviceDids: [],
      }),
      protocolFlags: {
        serverPrimaryExecutionV1: true,
        serverPrimaryExecutionClaimRoutingV1: true,
        serverPrimaryExecutionBuiltinPassivityV1: true,
      },
    } as unknown as ConstructorParameters<typeof Server>[0],
  ) as LaneServer;
  try {
    // Default rank dial (space): disabled regardless of the subcapability.
    assertEquals(withSubcapability.executionUserLanesEnabled(), false);
    rankDial.setServerPrimaryExecutionClaimRankConfig("user");
    assertEquals(withSubcapability.executionUserLanesEnabled(), true);
    // Rank dial without the host subcapability advertisement stays off.
    assertEquals(withoutSubcapability.executionUserLanesEnabled(), false);
  } finally {
    rankDial.resetServerPrimaryExecutionClaimRankConfig();
  }
});

Deno.test("A2: an ACL demotion fences the user lane before the transact response", async () => {
  const server = new Server(
    serverOptions("memory-v2-lane-lifecycle-acl", {
      mode: "enforce",
      serviceDids: [BOB],
    }) as unknown as ConstructorParameters<typeof Server>[0],
  ) as LaneServer;
  const ownerClient = await connectClient(server);
  const aliceClient = await connectClient(server);
  try {
    const owner = await mountAs(ownerClient, BOB);
    await owner.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: `of:${SPACE}`,
        value: { value: { [BOB]: "OWNER", [ALICE]: "WRITE" } },
      }],
    });
    const alice = await mountAs(aliceClient, ALICE);
    await alice.setExecutionDemand("", [PIECE_ROOT]);
    await server.openUserLaneGrant(SPACE, "", ALICE);
    assertExists(server.userLaneGrant(SPACE, "", ALICE));

    // The lane fence must land under the lease drain's awaited
    // publish-before-response discipline: the demand republish (and the
    // fence it reports) completes before the ACL writer sees its response.
    const order: string[] = [];
    const gate = Promise.withResolvers<void>();
    const unsubscribe = server.subscribeExecutionDemands(() => {
      order.push("publish");
      assertEquals(
        server.userLaneGrant(SPACE, "", ALICE),
        null,
        "the lane is already fenced when the reconciliation publishes",
      );
      return gate.promise;
    });
    const response = owner.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: `of:${SPACE}`,
        value: { value: { [BOB]: "OWNER", [ALICE]: "READ" } },
      }],
    }).then(() => {
      order.push("response");
    });
    // The response may not release while the demand publish barrier is held.
    await Promise.resolve();
    gate.resolve();
    await response;
    unsubscribe();
    assertEquals(order[0], "publish");
    assertEquals(order.at(-1), "response");
    assertEquals(server.userLaneGrant(SPACE, "", ALICE), null);
  } finally {
    await aliceClient.close();
    await ownerClient.close();
    await server.close();
  }
});
