import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { toFileUrl } from "@std/path";
import {
  type ClientCommit,
  type ExecutionClaim,
  type ExecutionLease,
  type Operation,
  toDocumentPath,
} from "../v2.ts";
import * as Engine from "../v2/engine.ts";
import * as MemoryClient from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import * as MemoryV2 from "../v2.ts";
import type {
  SchedulerActionObservation,
  SchedulerExecutionContextKey,
  SchedulerObservationAddress,
} from "../v2/engine.ts";

const SPACE = "did:key:z6Mk-acting-context-space";
// Colon-bearing DIDs: canonical user context keys percent-encode the
// principal, so lane scope keys never carry the DID raw.
const SPONSOR = "did:key:z6Mk-acting-context-sponsor-bob";
const LANE_PRINCIPAL = "did:key:z6Mk-acting-context-alice";
const OTHER_PRINCIPAL = "did:key:z6Mk-acting-context-carol";
const PIECE_ID = "space:of:acting-context-piece";
const ACTION_ID = "action:acting-context";
const IMPLEMENTATION_FINGERPRINT = "impl:acting-context";
const RUNTIME_FINGERPRINT = "runtime:acting-context";

const LANE_CONTEXT_KEY = Engine.userExecutionContextKey(
  LANE_PRINCIPAL,
) as SchedulerExecutionContextKey;
const OTHER_LANE_CONTEXT_KEY = Engine.userExecutionContextKey(
  OTHER_PRINCIPAL,
) as SchedulerExecutionContextKey;

const openTempEngine = async (): Promise<{
  directory: string;
  engine: Engine.Engine;
}> => {
  const directory = await Deno.makeTempDir();
  const store = toFileUrl(`${directory}/space.sqlite`);
  return { directory, engine: await Engine.open({ url: store }) };
};

const acquire = (
  engine: Engine.Engine,
  nowMs: number,
  onBehalfOf = SPONSOR,
): ExecutionLease => {
  const lease = Engine.acquireExecutionLease(engine, {
    space: SPACE,
    branch: "",
    hostId: "host:acting-context",
    onBehalfOf,
    nowMs,
    ttlMs: 60_000,
    authorizeWrite: () => true,
  });
  assertExists(lease);
  return lease;
};

const claimFor = (
  lease: ExecutionLease,
  contextKey: SchedulerExecutionContextKey,
  actionId = ACTION_ID,
): ExecutionClaim => ({
  branch: "",
  space: SPACE,
  contextKey,
  pieceId: PIECE_ID,
  actionId,
  actionKind: "computation",
  implementationFingerprint: IMPLEMENTATION_FINGERPRINT,
  runtimeFingerprint: RUNTIME_FINGERPRINT,
  leaseGeneration: lease.leaseGeneration,
  claimGeneration: 1,
  expiresAt: lease.expiresAt,
});

const address = (
  scope: "space" | "user" | "session",
  id: string,
  path: readonly string[] = ["value"],
): SchedulerObservationAddress => ({
  space: SPACE,
  scope,
  id,
  path: [...path],
});

const observationFor = (
  claim: ExecutionClaim,
  surfaces: {
    reads?: readonly SchedulerObservationAddress[];
    writes?: readonly SchedulerObservationAddress[];
  },
): SchedulerActionObservation => ({
  version: 2,
  ownerSpace: SPACE,
  branch: "",
  pieceId: claim.pieceId,
  processGeneration: 1,
  actionId: claim.actionId,
  actionKind: "computation",
  implementationFingerprint: IMPLEMENTATION_FINGERPRINT,
  runtimeFingerprint: RUNTIME_FINGERPRINT,
  executionClaimAssertion: {
    contextKey: claim.contextKey,
    leaseGeneration: claim.leaseGeneration,
    claimGeneration: claim.claimGeneration,
  },
  observedAtSeq: 0,
  transactionKind: "action-run",
  reads: [...(surfaces.reads ?? [])],
  shallowReads: [],
  actualChangedWrites: [...(surfaces.writes ?? [])],
  currentKnownWrites: [...(surfaces.writes ?? [])],
  materializerWriteEnvelopes: [],
  completeActionScopeSummary: {
    version: 1,
    complete: true,
    implementationFingerprint: IMPLEMENTATION_FINGERPRINT,
    runtimeFingerprint: RUNTIME_FINGERPRINT,
    piece: {
      space: SPACE,
      scope: "space",
      id: claim.pieceId.slice("space:".length),
      path: [],
    },
    reads: [...(surfaces.reads ?? [])],
    writes: [...(surfaces.writes ?? [])],
    materializerWriteEnvelopes: [],
    directOutputs: [...(surfaces.writes ?? [])],
  },
  status: "success",
});

const USER_INPUT = address("user", "of:acting-input");
const USER_OUTPUT = address("user", "of:acting-output");

const userInstanceOperation: Operation = {
  op: "set",
  id: USER_OUTPUT.id,
  scope: "user",
  value: { value: 7 },
};

type ApplyClaimedOptions = {
  operations?: Operation[];
  surfaces?: {
    reads?: readonly SchedulerObservationAddress[];
    writes?: readonly SchedulerObservationAddress[];
  };
  reads?: ClientCommit["reads"];
  preconditions?: ClientCommit["preconditions"];
  nowMs: number;
  localSeq?: number;
  executionClaims?: ReadonlyMap<number, ExecutionClaim>;
  fence?: Partial<Engine.ExecutionLeaseFence>;
  actingContext?: SchedulerExecutionContextKey;
};

/** Sponsor-bound apply: `principal` is ALWAYS the sponsor; the acting
 * context, when any, derives from the asserted claim's lane. */
const applyClaimed = (
  engine: Engine.Engine,
  lease: ExecutionLease,
  claim: ExecutionClaim,
  options: ApplyClaimedOptions,
) => {
  const localSeq = options.localSeq ?? 1;
  const commit: ClientCommit = {
    localSeq,
    reads: options.reads ?? { confirmed: [], pending: [] },
    operations: options.operations ?? [],
    ...(options.preconditions !== undefined
      ? { preconditions: [...options.preconditions] }
      : {}),
    schedulerObservation: observationFor(claim, options.surfaces ?? {}),
  };
  return Engine.applyCommit(engine, {
    sessionId: "executor-session",
    scopeSessionId: "executor-session",
    space: SPACE,
    principal: SPONSOR,
    commit,
    ...(options.actingContext !== undefined
      ? { actingContext: options.actingContext }
      : {}),
    executionClaims: options.executionClaims ??
      new Map([[localSeq, claim]]),
    executionLeaseFence: {
      lease,
      nowMs: options.nowMs,
      authorize: () => true,
      ...options.fence,
    },
  });
};

const seedSpaceDoc = (engine: Engine.Engine, id: string): number =>
  Engine.applyCommit(engine, {
    sessionId: "seed-session",
    space: SPACE,
    principal: SPONSOR,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id, value: { value: "seed" } }],
    },
  }).seq;

const assertFenceCause = (run: () => unknown, cause: string): void => {
  const error = assertThrows(run, Engine.ExecutionLeaseFenceError);
  assertEquals(error.fenceCause, cause, error.message);
};

Deno.test("user-lane commits act as the lane principal while onBehalfOf stays the sponsor", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, LANE_CONTEXT_KEY);
    const applied = applyClaimed(engine, lease, claim, {
      operations: [userInstanceOperation],
      surfaces: { reads: [USER_INPUT], writes: [USER_OUTPUT] },
      nowMs: nowMs + 1,
    });
    assertExists(applied.schedulerObservationResults);
    const [result] = applied.schedulerObservationResults;
    assert(result.status === "kept");
    // Effective-context resolution follows the ACTING principal: the lane's
    // scoped surfaces resolve to alice's context, never the sponsor's.
    assertEquals(result.executionContextKey, LANE_CONTEXT_KEY);
    // Provenance split (design §3): onBehalfOf records execution authority
    // (the sponsor); the claim's contextKey records the acting context.
    assertEquals(result.executionProvenance?.onBehalfOf, SPONSOR);
    assertEquals(
      result.executionProvenance?.claim.contextKey,
      LANE_CONTEXT_KEY,
    );
    // Scope resolution wrote the LANE principal's instance, not the sponsor's.
    assertEquals(
      Engine.read(engine, {
        id: USER_OUTPUT.id,
        scope: "user",
        principal: LANE_PRINCIPAL,
      }),
      { value: 7 },
    );
    assertEquals(
      Engine.read(engine, {
        id: USER_OUTPUT.id,
        scope: "user",
        principal: SPONSOR,
      }),
      null,
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("an explicit actingContext must match the asserted lane", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, LANE_CONTEXT_KEY);
    // Matching acting context: identical to the derived-lane behavior.
    const applied = applyClaimed(engine, lease, claim, {
      operations: [userInstanceOperation],
      surfaces: { writes: [USER_OUTPUT] },
      nowMs: nowMs + 1,
      actingContext: LANE_CONTEXT_KEY,
    });
    assert(applied.schedulerObservationResults?.[0].status === "kept");

    // A host-supplied acting context naming a DIFFERENT lane is a host bug
    // and rejects before anything is validated or written.
    const before = Engine.serverSeq(engine);
    assertThrows(
      () =>
        applyClaimed(engine, lease, claim, {
          operations: [userInstanceOperation],
          surfaces: { writes: [USER_OUTPUT] },
          nowMs: nowMs + 2,
          localSeq: 2,
          actingContext: OTHER_LANE_CONTEXT_KEY,
        }),
      Engine.ProtocolError,
      "acting context",
    );
    assertEquals(Engine.serverSeq(engine), before);
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("an unbound lane assertion fences before precondition validation", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    seedSpaceDoc(engine, "of:acting-existing");
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, LANE_CONTEXT_KEY);
    const before = Engine.serverSeq(engine);
    // The commit carries BOTH a violated precondition (the entity exists)
    // and an unbound lane assertion (no live claim resolution). The lane
    // fence must surface — constant shape, learning nothing from
    // precondition state (amendment 6).
    assertFenceCause(
      () =>
        applyClaimed(engine, lease, claim, {
          operations: [userInstanceOperation],
          surfaces: { writes: [USER_OUTPUT] },
          preconditions: [{ kind: "entity-absent", id: "of:acting-existing" }],
          nowMs: nowMs + 1,
          localSeq: 2,
          executionClaims: new Map(),
        }),
      "claim-not-live",
    );
    assertEquals(Engine.serverSeq(engine), before);
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a fenced lane generation rejects before stale-read validation", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const baseSeq = seedSpaceDoc(engine, "of:acting-stale-source");
    // Overwrite so a confirmed read at baseSeq is stale.
    Engine.applyCommit(engine, {
      sessionId: "seed-session",
      space: SPACE,
      principal: SPONSOR,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:acting-stale-source",
          value: { value: "current" },
        }],
      },
    });
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, LANE_CONTEXT_KEY);
    const staleRead = address("space", "of:acting-stale-source");
    // A drained lane must fence with its constant-shape cause BEFORE the
    // strict read validation can leak per-address conflict details.
    assertFenceCause(
      () =>
        applyClaimed(engine, lease, claim, {
          surfaces: { reads: [staleRead] },
          reads: {
            confirmed: [{
              id: staleRead.id,
              path: toDocumentPath(["value"]),
              seq: baseSeq,
            }],
            pending: [],
          },
          nowMs: nowMs + 1,
          fence: { laneAuthority: () => false },
        }),
      "lane-generation-stale",
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("one commit may assert claims of exactly one lane", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const aliceClaim = claimFor(lease, LANE_CONTEXT_KEY, "action:lane-a");
    const carolClaim = claimFor(
      lease,
      OTHER_LANE_CONTEXT_KEY,
      "action:lane-b",
    );
    const spaceClaim = claimFor(lease, "space", "action:lane-c");
    const batchCommit = (
      first: ExecutionClaim,
      second: ExecutionClaim,
    ): ClientCommit => ({
      localSeq: 10,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservationBatch: [
        {
          localSeq: 11,
          reads: { confirmed: [], pending: [] },
          schedulerObservation: observationFor(first, {}),
        },
        {
          localSeq: 12,
          reads: { confirmed: [], pending: [] },
          schedulerObservation: observationFor(second, {}),
        },
      ],
    });
    const applyBatch = (first: ExecutionClaim, second: ExecutionClaim) =>
      Engine.applyCommit(engine, {
        sessionId: "executor-session",
        space: SPACE,
        principal: SPONSOR,
        commit: batchCommit(first, second),
        executionClaims: new Map([[11, first], [12, second]]),
        executionLeaseFence: {
          lease,
          nowMs: nowMs + 1,
          authorize: () => true,
        },
      });
    // Two scoped lanes in one observation batch reject host-side.
    assertFenceCause(
      () => applyBatch(aliceClaim, carolClaim),
      "mixed-lane-commit",
    );
    // Mixing the space lane with a scoped lane rejects identically.
    assertFenceCause(
      () => applyBatch(spaceClaim, aliceClaim),
      "mixed-lane-commit",
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("acting-principal WRITE loss at commit time fences lane-write-authority", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, LANE_CONTEXT_KEY);
    const before = Engine.serverSeq(engine);
    const consulted: string[] = [];
    assertFenceCause(
      () =>
        applyClaimed(engine, lease, claim, {
          operations: [userInstanceOperation],
          surfaces: { writes: [USER_OUTPUT] },
          nowMs: nowMs + 1,
          fence: {
            authorizeActingPrincipal: (_engine, principal) => {
              consulted.push(principal);
              return false;
            },
          },
        }),
      "lane-write-authority",
    );
    // The check resolves the DECODED acting principal, not the sponsor.
    assertEquals(consulted, [LANE_PRINCIPAL]);
    assertEquals(Engine.serverSeq(engine), before);
    assertEquals(
      Engine.read(engine, {
        id: USER_OUTPUT.id,
        scope: "user",
        principal: LANE_PRINCIPAL,
      }),
      null,
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("space-lane commits stay byte-identical under the acting-context seam", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    seedSpaceDoc(engine, "of:acting-space-existing");
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, "space");
    // A forged SPACE assertion keeps today's ordering: the precondition
    // error surfaces first (the early lane fence is scoped-lane-only).
    const error = assertThrows(() =>
      applyClaimed(engine, lease, claim, {
        operations: [{
          op: "set",
          id: "of:acting-space-output",
          value: { value: 1 },
        }],
        surfaces: { writes: [address("space", "of:acting-space-output")] },
        preconditions: [{
          kind: "entity-absent",
          id: "of:acting-space-existing",
        }],
        nowMs: nowMs + 1,
        localSeq: 2,
        executionClaims: new Map(),
      })
    );
    assertEquals((error as Error).name, "PreconditionFailedError");

    // The acting-principal WRITE hook is never consulted for space claims,
    // and a normal space-lane commit is unaffected by it.
    const applied = applyClaimed(engine, lease, claim, {
      operations: [{
        op: "set",
        id: "of:acting-space-output",
        value: { value: 1 },
      }],
      surfaces: { writes: [address("space", "of:acting-space-output")] },
      nowMs: nowMs + 2,
      localSeq: 3,
      fence: { authorizeActingPrincipal: () => false },
    });
    assertExists(applied.schedulerObservationResults);
    const [result] = applied.schedulerObservationResults;
    assert(result.status === "kept");
    assertEquals(result.executionContextKey, "space");
    assertEquals(
      Engine.read(engine, { id: "of:acting-space-output" }),
      { value: 1 },
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("exact observation replays stay idempotent after a lane drain", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, LANE_CONTEXT_KEY);
    const apply = (laneLive: boolean) =>
      applyClaimed(engine, lease, claim, {
        surfaces: { reads: [USER_INPUT] },
        nowMs: nowMs + 1,
        fence: { laneAuthority: () => laneLive },
      });
    const first = apply(true);
    assert(first.schedulerObservationResults?.[0].status === "kept");
    // The lane drains; the exact replay of the settled observation still
    // returns its stored result instead of fencing (lost-response replay).
    const replay = apply(false);
    assert(Engine.isAppliedCommitReplay(replay));
    assertEquals(
      replay.schedulerObservationResults?.[0].schedulerObservationId,
      first.schedulerObservationResults?.[0].schedulerObservationId,
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

// WRITER-SESSION POLICY (C1.4, amendment 5): all lanes of one bound executor
// session share the sponsor session's commit sessionKey — one replay and one
// pending-read localSeq namespace per provider session. Cross-lane pending
// references on shared broad documents therefore keep resolving, and echo
// suppression/adoption stay keyed to the provider session (originSessionId);
// lane attribution of sync frames rides the resolved scopeKey (C1.4b), never
// a per-lane writer identity.
Deno.test("lanes share the sponsor session's replay and pending-read namespace", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    // The provider session commits a broad doc as localSeq 1 (space lane).
    Engine.applyCommit(engine, {
      sessionId: "executor-session",
      space: SPACE,
      principal: SPONSOR,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:acting-shared-broad",
          value: { value: "broad" },
        }],
      },
    });
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, LANE_CONTEXT_KEY);
    // The user-lane commit names the space-lane commit as a pending read:
    // one shared localSeq namespace resolves it under the sponsor session.
    const broadRead = address("space", "of:acting-shared-broad");
    const applied = applyClaimed(engine, lease, claim, {
      operations: [userInstanceOperation],
      surfaces: { reads: [broadRead], writes: [USER_OUTPUT] },
      reads: {
        confirmed: [],
        pending: [{
          id: broadRead.id,
          path: toDocumentPath(["value"]),
          localSeq: 1,
        }],
      },
      nowMs: nowMs + 1,
      localSeq: 2,
    });
    assert(applied.schedulerObservationResults?.[0].status === "kept");
    // Exact replay identity also rides the sponsor sessionKey.
    const replay = applyClaimed(engine, lease, claim, {
      operations: [userInstanceOperation],
      surfaces: { reads: [broadRead], writes: [USER_OUTPUT] },
      reads: {
        confirmed: [],
        pending: [{
          id: broadRead.id,
          path: toDocumentPath(["value"]),
          localSeq: 1,
        }],
      },
      nowMs: nowMs + 2,
      localSeq: 2,
    });
    assert(Engine.isAppliedCommitReplay(replay));
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Server-level wiring: one sponsor-bound provider session, acting context
// derived from the host-resolved claim lane, and the transaction-time WRITE
// resolution for the acting principal (#executionLeaseFenceForCommit).
// ---------------------------------------------------------------------------

const SERVER_SPACE = "did:key:z6Mk-acting-context-server-space";
const SERVER_AUDIENCE = "did:key:z6Mk-acting-context-audience";

type ExecutionSession = MemoryClient.SpaceSession & {
  setExecutionDemand(branch: string, pieces: readonly string[]): Promise<
    boolean
  >;
};

type ExecutionLeaseHandle = ExecutionLease & { readonly __brand?: unknown };

type ActingServer = Server & {
  acquireExecutionLease(
    space: string,
    branch: string,
  ): Promise<ExecutionLeaseHandle | null>;
  setExecutionClaim(
    lease: ExecutionLeaseHandle,
    claim: Omit<
      ExecutionClaim,
      "leaseGeneration" | "claimGeneration" | "expiresAt"
    >,
  ): Promise<ExecutionClaim>;
  bindExecutionSession(
    space: string,
    sessionId: string,
    lease: ExecutionLeaseHandle,
  ): () => void;
  openUserLaneGrant(
    space: string,
    branch: string,
    principal: string,
  ): Promise<unknown>;
};

const createActingServer = (name: string): ActingServer =>
  new Server(
    {
      store: new URL(`memory://${name}`),
      authorizeSessionOpen: (message: { authorization?: unknown }) => {
        const principal = (message.authorization as { principal?: unknown })
          ?.principal;
        return typeof principal === "string" ? principal : undefined;
      },
      sessionOpenAuth: { audience: SERVER_AUDIENCE },
      protocolFlags: {
        serverPrimaryExecutionV1: true,
        serverPrimaryExecutionClaimRoutingV1: true,
        serverPrimaryExecutionBuiltinPassivityV1: true,
      },
      acl: { mode: "off", serviceDids: [] },
    } as unknown as ConstructorParameters<typeof Server>[0],
  ) as ActingServer;

const connectActingClient = async (
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
): Promise<ExecutionSession> =>
  await client.mount(SERVER_SPACE, {}, (_space, _session, context) => ({
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

const serverAddress = (
  scope: "space" | "user",
  id: string,
): SchedulerObservationAddress => ({
  space: SERVER_SPACE,
  scope,
  id,
  path: ["value"],
});

const serverObservationFor = (
  claim: ExecutionClaim,
  surfaces: {
    reads?: readonly SchedulerObservationAddress[];
    writes?: readonly SchedulerObservationAddress[];
  },
): SchedulerActionObservation => ({
  version: 2,
  ownerSpace: SERVER_SPACE,
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
  reads: [...(surfaces.reads ?? [])],
  shallowReads: [],
  actualChangedWrites: [...(surfaces.writes ?? [])],
  currentKnownWrites: [...(surfaces.writes ?? [])],
  materializerWriteEnvelopes: [],
  completeActionScopeSummary: {
    version: 1,
    complete: true,
    implementationFingerprint: claim.implementationFingerprint,
    runtimeFingerprint: claim.runtimeFingerprint,
    piece: {
      space: SERVER_SPACE,
      scope: "space",
      id: claim.pieceId.slice("space:".length),
      path: [],
    },
    reads: [...(surfaces.reads ?? [])],
    writes: [...(surfaces.writes ?? [])],
    materializerWriteEnvelopes: [],
    directOutputs: [...(surfaces.writes ?? [])],
  },
  status: "success",
});

const serverLaneClaimKey = (contextKey: SchedulerExecutionContextKey) => ({
  branch: "",
  space: SERVER_SPACE,
  contextKey,
  pieceId: "space:piece:acting",
  actionId: "action:acting-server",
  actionKind: "computation" as const,
  implementationFingerprint: "impl:acting-server",
  runtimeFingerprint: "runtime:acting-server",
});

Deno.test("through a sponsor-bound provider session, a user lane commits as its principal", async () => {
  const server = createActingServer("memory-v2-acting-context-server");
  rankDial.resetServerPrimaryExecutionClaimRankConfig();
  const bobClient = await connectActingClient(server);
  const bobSession = await mountAs(bobClient, SPONSOR);
  const aliceClient = await connectActingClient(server);
  const aliceSession = await mountAs(aliceClient, LANE_PRINCIPAL);
  let unbind = () => {};
  try {
    // Seed so the pre-launch compatibility capability resolves WRITE.
    await bobSession.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:acting-server-seed",
        value: { value: "seed" },
      }],
    });
    rankDial.setServerPrimaryExecutionClaimRankConfig("user");
    await bobSession.setExecutionDemand("", ["space:piece:acting"]);
    const lease = await server.acquireExecutionLease(SERVER_SPACE, "");
    assertExists(lease);
    unbind = server.bindExecutionSession(
      SERVER_SPACE,
      bobSession.sessionId,
      lease,
    );
    await server.openUserLaneGrant(SERVER_SPACE, "", LANE_PRINCIPAL);
    const claim = await server.setExecutionClaim(
      lease,
      serverLaneClaimKey(
        Engine.userExecutionContextKey(
          LANE_PRINCIPAL,
        ) as SchedulerExecutionContextKey,
      ),
    );

    const output = serverAddress("user", "of:acting-server-output");
    const applied = await bobSession.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: output.id,
        scope: "user",
        value: { value: 21 },
      }],
      schedulerObservation: serverObservationFor(claim, { writes: [output] }),
    }) as Engine.AppliedCommit;
    assertExists(applied.schedulerObservationResults);
    const [result] = applied.schedulerObservationResults;
    assert(result.status === "kept");
    assertEquals(
      result.executionContextKey,
      Engine.userExecutionContextKey(LANE_PRINCIPAL),
    );
    assertEquals(result.executionProvenance?.onBehalfOf, SPONSOR);

    // Alice's own (unbound) session reads HER user-scoped instance.
    const aliceView = await aliceSession.queryGraph({
      roots: [{
        id: output.id,
        scope: "user",
        selector: { path: [], schema: false },
      }],
    });
    assertEquals(
      aliceView.entities.find((entity) => entity.id === output.id)?.document,
      { value: 21 },
    );
    // The sponsor's user-scoped instance stays empty: the lane never wrote
    // under the executing session's own principal.
    const bobView = await bobSession.queryGraph({
      roots: [{
        id: output.id,
        scope: "user",
        selector: { path: [], schema: false },
      }],
    });
    assertEquals(
      bobView.entities.find((entity) => entity.id === output.id)?.document ??
        null,
      null,
    );
  } finally {
    rankDial.resetServerPrimaryExecutionClaimRankConfig();
    unbind();
    await aliceClient.close();
    await bobClient.close();
    await server.close();
  }
});

Deno.test("acting-principal WRITE loss fences the provider commit as lane-write-authority", async () => {
  const server = createActingServer("memory-v2-acting-context-write-loss");
  rankDial.resetServerPrimaryExecutionClaimRankConfig();
  const bobClient = await connectActingClient(server);
  const bobSession = await mountAs(bobClient, SPONSOR);
  // A second sponsor session stays UNBOUND so it can commit the ACL change
  // (a lease-bound session may only commit claimed action transactions).
  const adminClient = await connectActingClient(server);
  const adminSession = await mountAs(adminClient, SPONSOR);
  const aliceClient = await connectActingClient(server);
  await mountAs(aliceClient, LANE_PRINCIPAL);
  let unbind = () => {};
  try {
    await bobSession.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:acting-write-loss-seed",
        value: { value: "seed" },
      }],
    });
    rankDial.setServerPrimaryExecutionClaimRankConfig("user");
    await bobSession.setExecutionDemand("", ["space:piece:acting"]);
    const lease = await server.acquireExecutionLease(SERVER_SPACE, "");
    assertExists(lease);
    unbind = server.bindExecutionSession(
      SERVER_SPACE,
      bobSession.sessionId,
      lease,
    );
    await server.openUserLaneGrant(SERVER_SPACE, "", LANE_PRINCIPAL);
    const claim = await server.setExecutionClaim(
      lease,
      serverLaneClaimKey(
        Engine.userExecutionContextKey(
          LANE_PRINCIPAL,
        ) as SchedulerExecutionContextKey,
      ),
    );

    // A valid ACL granting only the sponsor OWNER revokes alice's implicit
    // WRITE mid-run (the lane grant itself is not yet reconciled — C1.8).
    await adminSession.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: `of:${SERVER_SPACE}`,
        value: { value: { [SPONSOR]: "OWNER" } },
      }],
    });

    const output = serverAddress("user", "of:acting-write-loss-output");
    const before =
      server.executionStats.leaseFenceRejectCauses["lane-write-authority"] ??
        0;
    await assertRejects(
      () =>
        bobSession.transact({
          localSeq: 2,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: output.id,
            scope: "user",
            value: { value: "must-not-land" },
          }],
          schedulerObservation: serverObservationFor(claim, {
            writes: [output],
          }),
        }),
      Error,
      "WRITE",
    );
    assertEquals(
      server.executionStats.leaseFenceRejectCauses["lane-write-authority"],
      before + 1,
    );
  } finally {
    rankDial.resetServerPrimaryExecutionClaimRankConfig();
    unbind();
    await aliceClient.close();
    await adminClient.close();
    await bobClient.close();
    await server.close();
  }
});
