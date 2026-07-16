import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { toFileUrl } from "@std/path";
import * as MemoryClient from "../v2/client.ts";
import * as Engine from "../v2/engine.ts";
import { Server } from "../v2/server.ts";
import * as MemoryV2 from "../v2.ts";
import type {
  ExecutionClaim as WireExecutionClaim,
  ExecutionLease,
} from "../v2.ts";
import type {
  SchedulerActionObservation,
  SchedulerExecutionContextKey,
  SchedulerObservationAddress,
} from "../v2/engine.ts";

const LANE_SPACE = "did:key:z6Mk-lane-grant-space";
// Colon-bearing DIDs exercise the canonical percent-encoded lane keys.
const ALICE = "did:key:z6Mk-lane-grant-alice";
const BOB = "did:key:z6Mk-lane-grant-bob";

type LaneGrant = Readonly<{
  space: string;
  branch: string;
  contextKey: `user:${string}`;
  principal: string;
  laneGeneration: number;
  anchorSessionId: string;
  anchorConnectionId: string;
}>;

type ActionClaimKey = {
  branch: string;
  space: string;
  contextKey: "space" | `user:${string}` | `session:${string}:${string}`;
  pieceId: string;
  actionId: string;
  actionKind: "computation" | "effect" | "event-handler";
  implementationFingerprint: string;
  runtimeFingerprint: string;
};

type ExecutionClaim = ActionClaimKey & {
  leaseGeneration: number;
  claimGeneration: number;
  expiresAt: number;
};

type ExecutionControlEvent =
  | { type: "session.execution.claim.set"; claim: ExecutionClaim }
  | {
    type: "session.execution.claim.revoke";
    branch: string;
    claim: ActionClaimKey;
    leaseGeneration: number;
    claimGeneration: number;
  }
  | { type: "session.execution.settlement"; settlement: unknown };

type ExecutionSession = MemoryClient.SpaceSession & {
  setExecutionDemand(branch: string, pieces: readonly string[]): Promise<
    boolean
  >;
  subscribeExecutionControl(
    listener: (event: ExecutionControlEvent) => void,
  ): () => void;
};

type LaneServer = Server & {
  acquireExecutionLease(
    space: string,
    branch: string,
  ): Promise<ExecutionLeaseHandle | null>;
  setExecutionClaim(
    lease: ExecutionLeaseHandle,
    claim: ActionClaimKey,
  ): Promise<ExecutionClaim>;
  trySetExecutionClaim(
    lease: ExecutionLeaseHandle,
    claim: ActionClaimKey,
  ): Promise<ExecutionClaim | null>;
  renewExecutionClaim(
    lease: ExecutionLeaseHandle,
    claim: ExecutionClaim,
  ): Promise<ExecutionClaim | null>;
  revokeExecutionClaim(claim: ExecutionClaim): boolean;
  listExecutionClaims(space: string): readonly ExecutionClaim[];
  openUserLaneGrant(
    space: string,
    branch: string,
    principal: string,
  ): Promise<LaneGrant>;
  renewUserLaneGrant(grant: LaneGrant): Promise<LaneGrant | null>;
  userLaneGrant(
    space: string,
    branch: string,
    principal: string,
  ): LaneGrant | null;
};

type ExecutionLeaseHandle = ExecutionLease & { readonly __brand?: unknown };

const LANE_AUDIENCE = "did:key:z6Mk-lane-grant-audience";

/** Multi-principal session-open: the principal rides the authorization
 * payload, so one server can host alice and bob sessions side by side. */
const createLaneServer = (name: string): LaneServer =>
  new Server(
    {
      store: new URL(`memory://${name}`),
      authorizeSessionOpen: (message: { authorization?: unknown }) => {
        const principal = (message.authorization as { principal?: unknown })
          ?.principal;
        return typeof principal === "string" ? principal : undefined;
      },
      sessionOpenAuth: { audience: LANE_AUDIENCE },
      protocolFlags: {
        serverPrimaryExecutionV1: true,
        serverPrimaryExecutionClaimRoutingV1: true,
        serverPrimaryExecutionBuiltinPassivityV1: true,
      },
      acl: { mode: "off", serviceDids: [] },
    } as unknown as ConstructorParameters<typeof Server>[0],
  ) as LaneServer;

const connectLaneClient = async (
  server: Server,
): Promise<MemoryClient.Client> =>
  await MemoryClient.connect({
    transport: MemoryClient.loopback(server),
    protocolFlags: {
      serverPrimaryExecutionV1: true,
      serverPrimaryExecutionClaimRoutingV1: true,
      serverPrimaryExecutionBuiltinPassivityV1: true,
    },
  } as MemoryClient.ConnectOptions);

const mountAs = async (
  client: MemoryClient.Client,
  principal: string,
  space = LANE_SPACE,
): Promise<ExecutionSession> =>
  await client.mount(space, {}, (_space, _session, context) => ({
    invocation: {
      aud: context.audience,
      challenge: context.challenge.value,
    },
    authorization: { principal },
  })) as ExecutionSession;

/** Empty spaces resolve READ for authenticated principals; the first commit
 * flips the pre-launch compatibility capability to WRITE (server.ts
 * #resolveCapability), which the grant and lease WRITE checks require. */
const seedSpaceWrite = async (session: ExecutionSession): Promise<void> => {
  await session.transact({
    localSeq: 1,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set",
      id: "of:lane-grant-seed",
      value: { value: "seed" },
    }],
  });
};

const laneClaimKey = (
  contextKey: ActionClaimKey["contextKey"],
  actionId = "action:lane-derive",
): ActionClaimKey => ({
  branch: "",
  space: LANE_SPACE,
  contextKey,
  pieceId: "space:piece:lane",
  actionId,
  actionKind: "computation",
  implementationFingerprint: "impl:lane-v1",
  runtimeFingerprint: "runtime:lane-v1",
});

const rankDial = MemoryV2 as unknown as {
  setServerPrimaryExecutionClaimRankConfig(rank?: "space" | "user"): void;
  resetServerPrimaryExecutionClaimRankConfig(): void;
};

const userKeyOf = (principal: string): `user:${string}` =>
  Engine.userExecutionContextKey(principal);

const demandAndAcquireLease = async (
  server: LaneServer,
  session: ExecutionSession,
): Promise<ExecutionLeaseHandle> => {
  await session.setExecutionDemand("", ["space:piece:lane"]);
  const lease = await server.acquireExecutionLease(LANE_SPACE, "");
  assertExists(lease);
  return lease;
};

Deno.test("lane grants require a connected principal session and WRITE", async () => {
  const server = createLaneServer("memory-v2-lane-grant-anchoring");
  const client = await connectLaneClient(server);
  const session = await mountAs(client, ALICE);
  try {
    // Empty space: alice's capability resolves READ, so amendment 2 refuses
    // the grant even though her session is connected.
    await assertRejects(
      () => server.openUserLaneGrant(LANE_SPACE, "", ALICE),
      Error,
      "WRITE",
    );
    await seedSpaceWrite(session);
    const grant = await server.openUserLaneGrant(LANE_SPACE, "", ALICE);
    assertEquals(grant.principal, ALICE);
    assertEquals(grant.contextKey, userKeyOf(ALICE));
    assertEquals(grant.laneGeneration, 1);
    assertEquals(grant.anchorSessionId, session.sessionId);
    assertEquals(server.userLaneGrant(LANE_SPACE, "", ALICE), grant);

    // No connected session for bob: no lane authority to anchor.
    await assertRejects(
      () => server.openUserLaneGrant(LANE_SPACE, "", BOB),
      Error,
      "connected",
    );
  } finally {
    await client.close();
    await server.close();
  }
});

Deno.test("lane generations are monotonic across drains", async () => {
  const server = createLaneServer("memory-v2-lane-grant-generation");
  const firstClient = await connectLaneClient(server);
  const firstSession = await mountAs(firstClient, ALICE);
  try {
    await seedSpaceWrite(firstSession);
    const first = await server.openUserLaneGrant(LANE_SPACE, "", ALICE);
    assertEquals(first.laneGeneration, 1);
    // Re-opening while the anchor lives returns the same live grant.
    assertEquals(
      await server.openUserLaneGrant(LANE_SPACE, "", ALICE),
      first,
    );
    await firstClient.close();
    assertEquals(server.userLaneGrant(LANE_SPACE, "", ALICE), null);

    const secondClient = await connectLaneClient(server);
    await mountAs(secondClient, ALICE);
    try {
      const second = await server.openUserLaneGrant(LANE_SPACE, "", ALICE);
      assertEquals(second.laneGeneration, 2);
      assertEquals(await server.renewUserLaneGrant(second), second);
      // A drained incarnation can never be renewed back to life.
      assertEquals(await server.renewUserLaneGrant(first), null);
    } finally {
      await secondClient.close();
    }
  } finally {
    await server.close();
  }
});

Deno.test("disconnect drains and revokes only that principal's lane", async () => {
  const server = createLaneServer("memory-v2-lane-grant-drain-isolation");
  rankDial.resetServerPrimaryExecutionClaimRankConfig();
  const bobClient = await connectLaneClient(server);
  const bobSession = await mountAs(bobClient, BOB);
  const aliceClient = await connectLaneClient(server);
  await mountAs(aliceClient, ALICE);
  try {
    await seedSpaceWrite(bobSession);
    rankDial.setServerPrimaryExecutionClaimRankConfig("user");
    // Bob sponsors the lease; alice and bob each hold a lane grant, and the
    // same logical action fans out to both lanes (chain-disjoint: no single
    // client matches both claims).
    const lease = await demandAndAcquireLease(server, bobSession);
    const aliceGrant = await server.openUserLaneGrant(LANE_SPACE, "", ALICE);
    const bobGrant = await server.openUserLaneGrant(LANE_SPACE, "", BOB);
    const aliceClaim = await server.setExecutionClaim(
      lease,
      laneClaimKey(userKeyOf(ALICE)),
    );
    const bobClaim = await server.setExecutionClaim(
      lease,
      laneClaimKey(userKeyOf(BOB)),
    );

    const revoked: ActionClaimKey[] = [];
    const unsubscribe = bobSession.subscribeExecutionControl((event) => {
      if (event.type === "session.execution.claim.revoke") {
        revoked.push(event.claim);
      }
    });

    await aliceClient.close();

    // Only alice's lane drained: her grant is fenced and her claim revoked;
    // bob's grant, claim, and the lease survive untouched.
    assertEquals(server.userLaneGrant(LANE_SPACE, "", ALICE), null);
    assertEquals(server.userLaneGrant(LANE_SPACE, "", BOB), bobGrant);
    assertEquals(server.listExecutionClaims(LANE_SPACE), [bobClaim]);
    assertEquals(revoked.length, 1);
    assertEquals(revoked[0].contextKey, userKeyOf(ALICE));
    // The swept claim cannot renew: the executor's next renewal observes the
    // drain instead of resurrecting the lane.
    assertEquals(await server.renewExecutionClaim(lease, aliceClaim), null);
    assertExists(await server.renewExecutionClaim(lease, bobClaim));
    assertEquals(await server.renewUserLaneGrant(aliceGrant), null);
    unsubscribe();
  } finally {
    rankDial.resetServerPrimaryExecutionClaimRankConfig();
    await aliceClient.close();
    await bobClient.close();
    await server.close();
  }
});

Deno.test("chain-compatible double issuance rejects and lane moves publish revoke before issue", async () => {
  const server = createLaneServer("memory-v2-lane-grant-disjointness");
  rankDial.resetServerPrimaryExecutionClaimRankConfig();
  const client = await connectLaneClient(server);
  const session = await mountAs(client, ALICE);
  try {
    await seedSpaceWrite(session);
    rankDial.setServerPrimaryExecutionClaimRankConfig("user");
    const lease = await demandAndAcquireLease(server, session);
    await server.openUserLaneGrant(LANE_SPACE, "", ALICE);

    const events: ExecutionControlEvent[] = [];
    let sawUserClaimSet = () => {};
    const userClaimSet = new Promise<void>((resolve) => {
      sawUserClaimSet = resolve;
    });
    const unsubscribe = session.subscribeExecutionControl((event) => {
      events.push(event);
      if (
        event.type === "session.execution.claim.set" &&
        event.claim.contextKey === userKeyOf(ALICE)
      ) {
        sawUserClaimSet();
      }
    });

    const spaceClaim = await server.setExecutionClaim(
      lease,
      laneClaimKey("space"),
    );
    // ROUTING-DISJOINTNESS (amendment 3): while the space claim lives, a
    // user-rank claim for the same action tuple would let one client match
    // two live claims; issuance rejects, and the race-tolerant path declines.
    await assertRejects(
      () => server.setExecutionClaim(lease, laneClaimKey(userKeyOf(ALICE))),
      Error,
      "chain-compatible",
    );
    assertEquals(
      await server.trySetExecutionClaim(
        lease,
        laneClaimKey(userKeyOf(ALICE)),
      ),
      null,
    );

    // The lane move is revoke-published-before-issue: the executor releases
    // the space claim, then the user-rank issuance succeeds.
    assert(server.revokeExecutionClaim(spaceClaim));
    const userClaim = await server.setExecutionClaim(
      lease,
      laneClaimKey(userKeyOf(ALICE)),
    );
    assertEquals(userClaim.contextKey, userKeyOf(ALICE));
    await userClaimSet;

    const revokeIndex = events.findIndex((event) =>
      event.type === "session.execution.claim.revoke" &&
      event.claim.contextKey === "space"
    );
    const issueIndex = events.findIndex((event) =>
      event.type === "session.execution.claim.set" &&
      event.claim.contextKey === userKeyOf(ALICE)
    );
    assert(revokeIndex >= 0, "space revoke event must be published");
    assert(issueIndex >= 0, "user claim.set event must be published");
    assert(
      revokeIndex < issueIndex,
      "lane moves publish the revoke before the new claim",
    );
    unsubscribe();
  } finally {
    rankDial.resetServerPrimaryExecutionClaimRankConfig();
    await client.close();
    await server.close();
  }
});

Deno.test("issuance racing a lane drain is declined and nothing survives", async () => {
  const server = createLaneServer("memory-v2-lane-grant-drain-race");
  rankDial.resetServerPrimaryExecutionClaimRankConfig();
  const sponsorClient = await connectLaneClient(server);
  const sponsorSession = await mountAs(sponsorClient, BOB);
  const aliceClient = await connectLaneClient(server);
  await mountAs(aliceClient, ALICE);
  try {
    await seedSpaceWrite(sponsorSession);
    rankDial.setServerPrimaryExecutionClaimRankConfig("user");
    const lease = await demandAndAcquireLease(server, sponsorSession);
    const grant = await server.openUserLaneGrant(LANE_SPACE, "", ALICE);

    // Barrier interleave (amendment 12), no timing sleeps: the issuance
    // binds the live grant synchronously, then awaits engine access; the
    // synchronous anchor detach drains the lane — fencing the generation
    // before sweeping claims — so the issuance's post-await re-validation
    // observes the fence and declines.
    const issuance = server.trySetExecutionClaim(
      lease,
      laneClaimKey(userKeyOf(ALICE)),
    );
    server.detachSession(
      LANE_SPACE,
      grant.anchorSessionId,
      grant.anchorConnectionId,
    );
    assertEquals(await issuance, null);
    assertEquals(server.userLaneGrant(LANE_SPACE, "", ALICE), null);
    assertEquals(
      server.listExecutionClaims(LANE_SPACE).filter((claim) =>
        claim.contextKey === userKeyOf(ALICE)
      ),
      [],
    );
  } finally {
    rankDial.resetServerPrimaryExecutionClaimRankConfig();
    await aliceClient.close();
    await sponsorClient.close();
    await server.close();
  }
});

Deno.test("user-rank issuance requires a live lane grant", async () => {
  const server = createLaneServer("memory-v2-lane-grant-required");
  rankDial.resetServerPrimaryExecutionClaimRankConfig();
  const client = await connectLaneClient(server);
  const session = await mountAs(client, ALICE);
  try {
    await seedSpaceWrite(session);
    rankDial.setServerPrimaryExecutionClaimRankConfig("user");
    const lease = await demandAndAcquireLease(server, session);
    await assertRejects(
      () => server.setExecutionClaim(lease, laneClaimKey(userKeyOf(ALICE))),
      Error,
      "lane grant",
    );
    assertEquals(
      await server.trySetExecutionClaim(
        lease,
        laneClaimKey(userKeyOf(ALICE)),
      ),
      null,
    );
  } finally {
    rankDial.resetServerPrimaryExecutionClaimRankConfig();
    await client.close();
    await server.close();
  }
});

// Engine-level: the new named fence cause for stale lane generations. The
// host supplies `laneAuthority` on the commit fence; a claim bound to a
// fenced or superseded lane generation rejects before any row is written.
Deno.test("stale lane generations fence commits with lane-generation-stale", async () => {
  const directory = await Deno.makeTempDir();
  const engine = await Engine.open({
    url: toFileUrl(`${directory}/space.sqlite`),
  });
  const nowMs = 1_800_000_000_000;
  try {
    const lease = Engine.acquireExecutionLease(engine, {
      space: LANE_SPACE,
      branch: "",
      hostId: "host:lane-grant",
      onBehalfOf: ALICE,
      nowMs,
      ttlMs: 60_000,
      authorizeWrite: () => true,
    });
    assertExists(lease);
    const claim: WireExecutionClaim = {
      ...laneClaimKey(userKeyOf(ALICE)),
      contextKey: userKeyOf(ALICE) as SchedulerExecutionContextKey,
      leaseGeneration: lease.leaseGeneration,
      claimGeneration: 1,
      expiresAt: lease.expiresAt,
    };
    const output: SchedulerObservationAddress = {
      space: LANE_SPACE,
      scope: "user",
      id: "of:lane-grant-output",
      path: ["value"],
    };
    const observation: SchedulerActionObservation = {
      version: 2,
      ownerSpace: LANE_SPACE,
      branch: "",
      pieceId: claim.pieceId,
      processGeneration: 1,
      actionId: claim.actionId,
      actionKind: "computation",
      implementationFingerprint: claim.implementationFingerprint,
      runtimeFingerprint: claim.runtimeFingerprint,
      executionClaimAssertion: {
        contextKey: claim.contextKey,
        leaseGeneration: claim.leaseGeneration,
        claimGeneration: claim.claimGeneration,
      },
      observedAtSeq: 0,
      transactionKind: "action-run",
      reads: [],
      shallowReads: [],
      actualChangedWrites: [output],
      currentKnownWrites: [output],
      materializerWriteEnvelopes: [],
      completeActionScopeSummary: {
        version: 1,
        complete: true,
        implementationFingerprint: claim.implementationFingerprint,
        runtimeFingerprint: claim.runtimeFingerprint,
        piece: {
          space: LANE_SPACE,
          scope: "space",
          id: claim.pieceId.slice("space:".length),
          path: [],
        },
        reads: [],
        writes: [output],
        materializerWriteEnvelopes: [],
        directOutputs: [output],
      },
      status: "success",
    };
    const before = Engine.serverSeq(engine);
    const error = assertThrows(
      () =>
        Engine.applyCommit(engine, {
          sessionId: "executor-session",
          scopeSessionId: "executor-session",
          space: LANE_SPACE,
          principal: ALICE,
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: output.id,
              scope: "user",
              value: { value: 1 },
            }],
            schedulerObservation: observation,
          },
          executionClaims: new Map([[1, claim]]),
          executionLeaseFence: {
            lease,
            nowMs: nowMs + 1,
            authorize: () => true,
            laneAuthority: () => false,
          },
        }),
      Engine.ExecutionLeaseFenceError,
    );
    assertEquals(error.fenceCause, "lane-generation-stale");
    assertEquals(Engine.serverSeq(engine), before);
    assertEquals(
      Engine.read(engine, {
        id: output.id,
        scope: "user",
        principal: ALICE,
      }),
      null,
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});
