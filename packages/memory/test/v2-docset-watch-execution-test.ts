import { assertEquals, assertExists } from "@std/assert";
import * as MemoryClient from "../v2/client.ts";
import * as Engine from "../v2/engine.ts";
import { Server } from "../v2/server.ts";
import { toDirtyKey } from "../v2/query.ts";
import {
  type ExecutionLease,
  setServerPrimaryExecutionGraphRetirementConfig,
  type WatchSpec,
} from "../v2.ts";
import type { SchedulerExecutionContextKey } from "../v2/engine.ts";

// --- FW3: doc-set watches on lease-bound executor sessions — the F4 runner
// population. Covers FB15 (the FA1 stale-binding fail-open must not lose
// member deltas) and FB25 (FA2(c): a lane-registered docs watch keeps its
// acting context, including across a full re-evaluation refresh).

// FW5 (FB9): the F5 rollout dial gates doc-set ADMISSION per space. This
// suite exercises F3/FW3 semantics that are orthogonal to the dial, so admit
// every space via the wildcard for the whole file (module state is
// per-test-file). Dial authority itself is pinned in
// v2-feed-retirement-test.ts.
setServerPrimaryExecutionGraphRetirementConfig(["*"]);

const SPACE = "did:key:z6Mk-docset-exec-space";
const AUDIENCE = "did:key:z6Mk-docset-exec-audience";
// Colon-bearing DIDs exercise the canonical percent-encoded lane keys.
const SPONSOR = "did:key:z6Mk-docset-exec-sponsor-bob";
const LANE_PRINCIPAL = "did:key:z6Mk-docset-exec-alice";

const ALICE_LANE = Engine.userExecutionContextKey(
  LANE_PRINCIPAL,
) as SchedulerExecutionContextKey;

type ExecutionSession = MemoryClient.SpaceSession & {
  setExecutionDemand(
    branch: string,
    pieces: readonly string[],
  ): Promise<boolean>;
};

type ExecutionLeaseHandle = ExecutionLease & { readonly __brand?: unknown };

type ExecutionServer = Server & {
  acquireExecutionLease(
    space: string,
    branch: string,
  ): Promise<ExecutionLeaseHandle | null>;
  bindExecutionSession(
    space: string,
    sessionId: string,
    lease: ExecutionLeaseHandle,
  ): () => void;
  openUserLaneGrant(
    space: string,
    branch: string,
    principal: string,
  ): Promise<{ anchorSessionId: string; anchorConnectionId: string }>;
};

const createServer = (name: string): ExecutionServer =>
  new Server(
    {
      store: new URL(`memory://${name}`),
      // Waves are driven MANUALLY via syncSessionForConnection so every
      // delivery in these fixtures is deterministic; an effectively infinite
      // refresh delay keeps the server's own scheduler out of the way.
      subscriptionRefreshDelayMs: 3_600_000,
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
        serverPrimaryExecutionDocSetWatchV1: true,
      },
      acl: { mode: "off", serviceDids: [] },
    } as unknown as ConstructorParameters<typeof Server>[0],
  ) as ExecutionServer;

const connectClient = (server: Server): Promise<MemoryClient.Client> =>
  MemoryClient.connect({
    transport: MemoryClient.loopback(server),
    protocolFlags: {
      serverPrimaryExecutionV1: true,
      serverPrimaryExecutionClaimRoutingV1: true,
      serverPrimaryExecutionBuiltinPassivityV1: true,
      serverPrimaryExecutionContextLatticeClaimsV1: true,
      serverPrimaryExecutionDocSetWatchV1: true,
    },
  } as MemoryClient.ConnectOptions);

const mountAs = (
  client: MemoryClient.Client,
  principal: string,
  options: MemoryClient.MountOptions = {},
): Promise<ExecutionSession> =>
  client.mount(SPACE, options, (_space, _session, context) => ({
    invocation: { aud: context.audience, challenge: context.challenge.value },
    authorization: { principal },
  })) as Promise<ExecutionSession>;

const docsWatch = (
  id: string,
  docs: Array<{ id: string; scope?: "space" | "user" }>,
): WatchSpec => ({ id, kind: "docs", docs } as unknown as WatchSpec);

const setDoc = (
  session: MemoryClient.SpaceSession,
  localSeq: number,
  id: string,
  value: string,
  scope?: "user",
) =>
  session.transact({
    localSeq,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set",
      id,
      ...(scope !== undefined ? { scope } : {}),
      value: { value },
    }],
  });

const effectUpserts = (
  message: { effect: { type: string } } | null,
): Array<{ id: string; doc?: unknown; scopeKey?: string }> => {
  if (message === null) return [];
  const effect = message.effect as {
    type: string;
    upserts?: Array<{ id: string; doc?: unknown; scopeKey?: string }>;
  };
  return effect.type === "sync" ? effect.upserts ?? [] : [];
};

Deno.test("FA1 stale-binding fail-open: a skipped member delta is re-staged and delivered on the next wave, never silently lost (FB15)", async () => {
  const server = createServer("memory-v2-docset-stale-binding");
  const writerClient = await connectClient(server);
  const bobClient = await connectClient(server);
  try {
    const writer = await mountAs(writerClient, SPONSOR);
    const bob = await mountAs(bobClient, SPONSOR);

    // Seed the branch (lease acquisition needs an existing commit history).
    await setDoc(writer, 1, "of:seed", "seed");

    // Bob's session holds one doc-set member.
    await bob.watchSet([docsWatch("m", [{ id: "of:m" }])]);

    // Lease-bind bob's session — the F4 runner population, precisely the
    // sessions that hold docs watches at tip.
    await bob.setExecutionDemand("", ["space:piece:docset-stale"]);
    const lease = await server.acquireExecutionLease(SPACE, "");
    assertExists(lease);
    server.bindExecutionSession(SPACE, bob.sessionId, lease);

    // Make the binding stale: a same-connection session re-open rotates the
    // registry's session token while #boundExecutionSessions keeps the token
    // captured at bind time, so the session's scope context is unresolvable —
    // the stale-binding window the fail-open covers. (The re-open itself
    // fails on the resume catch-up's unguarded scope resolution; the registry
    // token has already rotated by then, which is what creates the window.)
    let reopenFailure: unknown;
    try {
      await mountAs(bobClient, SPONSOR, {
        sessionId: bob.sessionId,
        sessionToken: bob.sessionToken,
      });
    } catch (error) {
      reopenFailure = error;
    }
    assertExists(reopenFailure, "re-opening a lease-bound session goes stale");

    // A commit dirties the member DURING the stale window: the wave's member
    // point read is skipped by the fail-open while the session watermark
    // advances to the wave's toSeq.
    await setDoc(writer, 2, "of:m", "M2");
    const skipped = await server.syncSessionForConnection(
      SPACE,
      bob.sessionId,
      new Set([toDirtyKey("of:m")]),
    );
    assertEquals(
      effectUpserts(skipped),
      [],
      "the stale-binding wave must not deliver member deltas",
    );

    // The stale window ends: the connection disconnects, taking its
    // execution binding with it. The session itself survives to its TTL
    // (detached), so the server still owes it the skipped delta.
    await bobClient.close();

    // FA1: the next wave — dirtying something else entirely — must retry the
    // skipped member and deliver the missed delta. The watermark already
    // advanced past it, so losing it here would be permanent (no future
    // write to of:m, no reconnect — the delta would simply never arrive).
    const retried = await server.syncSessionForConnection(
      SPACE,
      bob.sessionId,
      new Set([toDirtyKey("of:unrelated")]),
    );
    assertExists(
      retried,
      "the skipped member delta must be retried on the next wave",
    );
    assertEquals(
      effectUpserts(retried).map((upsert) => ({
        id: upsert.id,
        doc: upsert.doc,
      })),
      [{ id: "of:m", doc: { value: "M2" } }],
    );

    // Nothing is owed after the retry: an identical follow-up wave is empty.
    const settled = await server.syncSessionForConnection(
      SPACE,
      bob.sessionId,
      new Set([toDirtyKey("of:unrelated")]),
    );
    assertEquals(
      effectUpserts(settled),
      [],
      "a delivered retry must not repeat",
    );
  } finally {
    await writerClient.close();
    await bobClient.close();
    await server.close();
  }
});

Deno.test("a lane-registered docs watch keeps its acting context — membership resolves the LANE principal's instance across waves and full re-evaluation (FA2(c), FB25)", async () => {
  const server = createServer("memory-v2-docset-lane-context");
  const bobClient = await connectClient(server);
  const bobWriterClient = await connectClient(server);
  const aliceClient = await connectClient(server);
  try {
    // Bob (the sponsor) holds the lease-bound executor session; a second
    // sponsor session writes bob's own user instances; alice anchors a lane.
    const bob = await mountAs(bobClient, SPONSOR);
    const bobWriter = await mountAs(bobWriterClient, SPONSOR);
    const alice = await mountAs(aliceClient, LANE_PRINCIPAL);

    // Distinct per-principal instances of the same user-scoped doc.
    await setDoc(bobWriter, 1, "of:u", "SPONSOR-1", "user");
    await setDoc(alice, 1, "of:u", "ALICE-1", "user");

    await bob.setExecutionDemand("", ["space:piece:docset-lane"]);
    const lease = await server.acquireExecutionLease(SPACE, "");
    assertExists(lease);
    server.bindExecutionSession(SPACE, bob.sessionId, lease);
    await server.openUserLaneGrant(SPACE, "", LANE_PRINCIPAL);

    // Register the docs watch UNDER THE LANE acting context (the C1.4b read
    // seam). Membership must resolve under the LANE principal at
    // registration: the seed is alice's instance, not the sponsor's.
    const registered = await bob.watchSetSync(
      [docsWatch("lane-docs", [{ id: "of:u", scope: "user" }])],
      { actingContext: ALICE_LANE },
    );
    assertEquals(
      registered.sync.upserts.map((upsert) => ({
        id: upsert.id,
        doc: upsert.doc,
        scopeKey: upsert.scopeKey,
      })),
      [{ id: "of:u", doc: { value: "ALICE-1" }, scopeKey: ALICE_LANE }],
    );

    // A SPONSOR-instance write never reaches the lane-registered member —
    // the per-wave point read resolves the lane principal's instance, which
    // is unchanged.
    await setDoc(bobWriter, 2, "of:u", "SPONSOR-2", "user");
    const sponsorWave = await server.syncSessionForConnection(
      SPACE,
      bob.sessionId,
      new Set([toDirtyKey("of:u", "user")]),
    );
    assertEquals(
      effectUpserts(sponsorWave),
      [],
      "a sponsor-instance write must not deliver to a lane-registered member",
    );

    // The lane principal's own write delivers, still attributed to the lane.
    await setDoc(alice, 2, "of:u", "ALICE-2", "user");
    const laneWave = await server.syncSessionForConnection(
      SPACE,
      bob.sessionId,
      new Set([toDirtyKey("of:u", "user")]),
    );
    assertEquals(
      effectUpserts(laneWave).map((upsert) => ({
        id: upsert.id,
        doc: upsert.doc,
        scopeKey: upsert.scopeKey,
      })),
      [{ id: "of:u", doc: { value: "ALICE-2" }, scopeKey: ALICE_LANE }],
    );

    // Full re-evaluation (a resume with no dirty set wipes and rebuilds the
    // watch surface): the registration's acting context survives — the
    // member is still point-read under the LANE principal, never silently
    // flipped back to the sponsor's instance.
    await setDoc(alice, 3, "of:u", "ALICE-3", "user");
    const resumed = await server.syncSessionForConnection(
      SPACE,
      bob.sessionId,
    );
    assertExists(resumed);
    assertEquals(
      effectUpserts(resumed).map((upsert) => ({
        id: upsert.id,
        doc: upsert.doc,
        scopeKey: upsert.scopeKey,
      })),
      [{ id: "of:u", doc: { value: "ALICE-3" }, scopeKey: ALICE_LANE }],
    );
  } finally {
    await bobClient.close();
    await bobWriterClient.close();
    await aliceClient.close();
    await server.close();
  }
});
