// C2.8 (scoped-lane builtin egress under the lane grant, context-lattice
// OQ6/R12), host half: the issuance rank dial admits scoped-rank EFFECT
// claims (amendment 8's computation-only conjunct lifted), and the read-only
// broker gate `hasLiveExecutionClaim` — the brokered-egress execution
// point's authority consult — validates the LIVE lane grant for scoped
// claims exactly as commits do (#liveLaneGrantForKey at the bound
// generation): a drained lane's in-flight builtin must not egress. Space
// behavior stays byte-identical at every step. Mirrors the C2.1/C2.3
// harness in v2-execution-session-lane-grant-test.ts.
import { assertEquals, assertExists, assertRejects } from "@std/assert";
import * as MemoryClient from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import * as MemoryV2 from "../v2.ts";
import * as Engine from "../v2/engine.ts";
import type { ExecutionLease } from "../v2.ts";

const SPACE = "did:key:z6Mk-scoped-egress-space";
const ALICE = "did:key:z6Mk-scoped-egress-alice";
const AUDIENCE = "did:key:z6Mk-scoped-egress-audience";

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

type ExecutionSession = MemoryClient.SpaceSession & {
  setExecutionDemand(branch: string, pieces: readonly string[]): Promise<
    boolean
  >;
};

type ExecutionLeaseHandle = ExecutionLease & { readonly __brand?: unknown };

type SessionGrant = Readonly<{
  contextKey: `session:${string}:${string}`;
  laneGeneration: number;
}>;

type UserGrant = Readonly<{
  contextKey: `user:${string}`;
  laneGeneration: number;
}>;

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
  revokeExecutionClaim(claim: ExecutionClaim): boolean;
  hasLiveExecutionClaim(claim: ExecutionClaim): boolean;
  listExecutionClaims(space: string): readonly ExecutionClaim[];
  openUserLaneGrant(
    space: string,
    branch: string,
    principal: string,
  ): Promise<UserGrant>;
  closeUserLaneGrant(grant: UserGrant): boolean;
  openSessionLaneGrant(
    space: string,
    branch: string,
    principal: string,
    sessionId: string,
  ): Promise<SessionGrant>;
  closeSessionLaneGrant(grant: SessionGrant): boolean;
};

const createLaneServer = (name: string): LaneServer =>
  new Server(
    {
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
      serverPrimaryExecutionContextLatticeClaimsV1: true,
    },
  } as MemoryClient.ConnectOptions);

const mountAs = async (
  client: MemoryClient.Client,
  principal: string,
): Promise<ExecutionSession> =>
  await client.mount(SPACE, {}, (_space, _session, context) => ({
    invocation: {
      aud: context.audience,
      challenge: context.challenge.value,
    },
    authorization: { principal },
  })) as ExecutionSession;

const seedSpaceWrite = async (session: ExecutionSession): Promise<void> => {
  await session.transact({
    localSeq: 1,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set",
      id: "of:scoped-egress-seed",
      value: { value: "seed" },
    }],
  });
};

/** A supported-builtin-shaped EFFECT claim key at the given lane. */
const effectClaimKey = (
  contextKey: ActionClaimKey["contextKey"],
  actionId = "action:scoped-egress-fetch",
): ActionClaimKey => ({
  branch: "",
  space: SPACE,
  contextKey,
  pieceId: "space:piece:scoped-egress",
  actionId,
  actionKind: "effect",
  implementationFingerprint: "impl:cf:builtin/fetchText:server-v1",
  runtimeFingerprint: "runtime:scoped-egress-v1",
});

const rankDial = MemoryV2 as unknown as {
  setServerPrimaryExecutionClaimRankConfig(
    rank?: "space" | "user" | "session",
  ): void;
  resetServerPrimaryExecutionClaimRankConfig(): void;
};

const sessionKeyOf = (
  principal: string,
  sessionId: string,
): `session:${string}:${string}` =>
  Engine.sessionExecutionContextKey(principal, sessionId);

const userKeyOf = (principal: string): `user:${string}` =>
  Engine.userExecutionContextKey(principal);

const demandAndAcquireLease = async (
  server: LaneServer,
  session: ExecutionSession,
): Promise<ExecutionLeaseHandle> => {
  await session.setExecutionDemand("", ["space:piece:scoped-egress"]);
  const lease = await server.acquireExecutionLease(SPACE, "");
  assertExists(lease);
  return lease;
};

// ---------------------------------------------------------------------------
// (1) The issuance lift: at the session dial stage, scoped-rank EFFECT
// claims issue under a live lane grant — session and user rank alike.
// ---------------------------------------------------------------------------

Deno.test("session- and user-rank effect claims issue under live lane grants (C2.8 lifts amendment 8)", async () => {
  const server = createLaneServer("memory-v2-scoped-egress-issuance");
  rankDial.resetServerPrimaryExecutionClaimRankConfig();
  const client = await connectLaneClient(server);
  const session = await mountAs(client, ALICE);
  try {
    await seedSpaceWrite(session);
    rankDial.setServerPrimaryExecutionClaimRankConfig("session");
    const lease = await demandAndAcquireLease(server, session);
    await server.openSessionLaneGrant(SPACE, "", ALICE, session.sessionId);
    const sessionClaim = await server.setExecutionClaim(
      lease,
      effectClaimKey(sessionKeyOf(ALICE, session.sessionId)),
    );
    assertEquals(sessionClaim.actionKind, "effect");
    assertEquals(
      sessionClaim.contextKey,
      sessionKeyOf(ALICE, session.sessionId),
    );
    assertEquals(server.hasLiveExecutionClaim(sessionClaim), true);

    await server.openUserLaneGrant(SPACE, "", ALICE);
    const userClaim = await server.setExecutionClaim(
      lease,
      effectClaimKey(userKeyOf(ALICE), "action:scoped-egress-fetch-user"),
    );
    assertEquals(userClaim.actionKind, "effect");
    assertEquals(userClaim.contextKey, userKeyOf(ALICE));
    assertEquals(server.hasLiveExecutionClaim(userClaim), true);
  } finally {
    rankDial.resetServerPrimaryExecutionClaimRankConfig();
    await client.close();
    await server.close();
  }
});

Deno.test("below their dial stage, scoped-rank effect claims keep rejecting at issuance (regression)", async () => {
  // The C2.8 lift is dial-gated exactly like scoped computations: the
  // ladder's lower stages keep refusing scoped effect claims byte-
  // identically, and the passivity flag still gates every effect rank.
  const server = createLaneServer("memory-v2-scoped-egress-dial-off");
  rankDial.resetServerPrimaryExecutionClaimRankConfig();
  const client = await connectLaneClient(server);
  const session = await mountAs(client, ALICE);
  try {
    await seedSpaceWrite(session);
    const lease = await demandAndAcquireLease(server, session);
    for (const stage of ["space", "user"] as const) {
      rankDial.setServerPrimaryExecutionClaimRankConfig(stage);
      await assertRejects(
        () =>
          server.setExecutionClaim(
            lease,
            effectClaimKey(sessionKeyOf(ALICE, session.sessionId)),
          ),
        Error,
        "rank is not enabled",
        `session-rank effect below the session stage (${stage})`,
      );
    }
    // User-rank effects need at least the user stage.
    rankDial.setServerPrimaryExecutionClaimRankConfig("space");
    await assertRejects(
      () => server.setExecutionClaim(lease, effectClaimKey(userKeyOf(ALICE))),
      Error,
      "rank is not enabled",
      "user-rank effect below the user stage",
    );
  } finally {
    rankDial.resetServerPrimaryExecutionClaimRankConfig();
    await client.close();
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// (2) Fixture (c)/(d) host half — the brokered-egress authority consult: a
// drained lane's claim is not live for broker work. The drain fences the
// generation and sweeps the lane's claims synchronously; the broker gate
// additionally consults the live lane grant at the bound generation (the
// same #liveLaneGrantForKey consult commits use), so a scoped claim can
// never authorize egress across a drain, and a reopened lane (bumped
// generation) never revives an old incarnation.
// ---------------------------------------------------------------------------

Deno.test("a drained session lane's effect claim stops authorizing broker egress (C2.8 fixture c, host half)", async () => {
  const server = createLaneServer("memory-v2-scoped-egress-drain");
  rankDial.resetServerPrimaryExecutionClaimRankConfig();
  const client = await connectLaneClient(server);
  const session = await mountAs(client, ALICE);
  try {
    await seedSpaceWrite(session);
    rankDial.setServerPrimaryExecutionClaimRankConfig("session");
    const lease = await demandAndAcquireLease(server, session);
    const grant = await server.openSessionLaneGrant(
      SPACE,
      "",
      ALICE,
      session.sessionId,
    );
    const claim = await server.setExecutionClaim(
      lease,
      effectClaimKey(sessionKeyOf(ALICE, session.sessionId)),
    );
    assertEquals(server.hasLiveExecutionClaim(claim), true);

    // Drain: fence the generation, sweep the lane's claims. The broker gate
    // must observe the fence — no egress after this point.
    assertEquals(server.closeSessionLaneGrant(grant), true);
    assertEquals(server.hasLiveExecutionClaim(claim), false);
    assertEquals(
      server.listExecutionClaims(SPACE).filter((live) =>
        live.contextKey === claim.contextKey
      ),
      [],
      "the drain must revoke the lane's claims",
    );

    // Reopen the lane (bumped generation) and reissue: the NEW incarnation
    // authorizes; the drained incarnation stays dead.
    await server.openSessionLaneGrant(SPACE, "", ALICE, session.sessionId);
    const reissued = await server.setExecutionClaim(
      lease,
      effectClaimKey(sessionKeyOf(ALICE, session.sessionId)),
    );
    assertEquals(server.hasLiveExecutionClaim(reissued), true);
    assertEquals(server.hasLiveExecutionClaim(claim), false);
  } finally {
    rankDial.resetServerPrimaryExecutionClaimRankConfig();
    await client.close();
    await server.close();
  }
});

Deno.test("a re-anchor-drained user lane's effect claim stops authorizing broker egress (C2.8 fixture d, host half)", async () => {
  const server = createLaneServer("memory-v2-scoped-egress-user-drain");
  rankDial.resetServerPrimaryExecutionClaimRankConfig();
  const client = await connectLaneClient(server);
  const session = await mountAs(client, ALICE);
  try {
    await seedSpaceWrite(session);
    rankDial.setServerPrimaryExecutionClaimRankConfig("session");
    const lease = await demandAndAcquireLease(server, session);
    const grant = await server.openUserLaneGrant(SPACE, "", ALICE);
    const claim = await server.setExecutionClaim(
      lease,
      effectClaimKey(userKeyOf(ALICE)),
    );
    assertEquals(server.hasLiveExecutionClaim(claim), true);
    // Anchor loss and re-anchor both run through the same fence-then-sweep
    // drain; the broker gate observes it identically.
    assertEquals(server.closeUserLaneGrant(grant), true);
    assertEquals(server.hasLiveExecutionClaim(claim), false);
  } finally {
    rankDial.resetServerPrimaryExecutionClaimRankConfig();
    await client.close();
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// (3) Fixture (e) host half — offline egress does not exist: with the lane
// principal's sessions gone, the lane grant cannot open and a scoped-rank
// effect claim never issues. Emergent from C2.3's session-anchored grants;
// pinned here so the C2.8 lift can never silently widen into OQ1 territory.
// ---------------------------------------------------------------------------

Deno.test("a scoped-lane effect with zero connected sessions never claims (C2.8 fixture e — OQ1 stays unbuilt)", async () => {
  const server = createLaneServer("memory-v2-scoped-egress-offline");
  rankDial.resetServerPrimaryExecutionClaimRankConfig();
  const sponsorClient = await connectLaneClient(server);
  const sponsor = await mountAs(sponsorClient, ALICE);
  const laneClient = await connectLaneClient(server);
  const laneSession = await mountAs(laneClient, "did:key:z6Mk-egress-carol");
  try {
    await seedSpaceWrite(sponsor);
    rankDial.setServerPrimaryExecutionClaimRankConfig("session");
    const lease = await demandAndAcquireLease(server, sponsor);
    const carolSessionKey = sessionKeyOf(
      "did:key:z6Mk-egress-carol",
      laneSession.sessionId,
    );
    // Carol disconnects: her lane can never open, and no grant means no
    // scoped-rank claim — computation or effect alike.
    await laneClient.close();
    await assertRejects(
      () =>
        server.openSessionLaneGrant(
          SPACE,
          "",
          "did:key:z6Mk-egress-carol",
          laneSession.sessionId,
        ),
      Error,
      "live connected session",
    );
    assertEquals(
      await server.trySetExecutionClaim(
        lease,
        effectClaimKey(carolSessionKey),
      ),
      null,
      "an offline principal's session-rank effect claim must never issue",
    );
    assertEquals(
      await server.trySetExecutionClaim(
        lease,
        effectClaimKey(userKeyOf("did:key:z6Mk-egress-carol")),
      ),
      null,
      "an offline principal's user-rank effect claim must never issue",
    );
  } finally {
    rankDial.resetServerPrimaryExecutionClaimRankConfig();
    await sponsorClient.close();
    await server.close();
  }
});
