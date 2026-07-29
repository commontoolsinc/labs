import { assert, assertEquals, assertExists, assertThrows } from "@std/assert";
import { toFileUrl } from "@std/path";
import type { FabricValue } from "@commonfabric/api";
import type {
  ClientCommit,
  EntityDocument,
  ExecutionClaim,
  ExecutionLease,
} from "../v2.ts";
import { scopeNamingLinkForPath } from "../v2/scope-naming-link.ts";
import * as Engine from "../v2/engine.ts";
import type {
  SchedulerActionObservation,
  SchedulerExecutionContextKey,
  SchedulerObservationAddress,
} from "../v2/engine.ts";

const SPACE = "did:key:z6Mk-claim-context-space";
// Colon-bearing DIDs: the canonical user context key percent-encodes the
// principal, so naive `user:${did}` concatenation never matches it.
const PRINCIPAL = "did:key:z6Mk-claim-context-alice";
const OTHER_PRINCIPAL = "did:key:z6Mk-claim-context-bob";
const PIECE_ID = "space:of:claim-context-piece";
const ACTION_ID = "action:claim-context";
const IMPLEMENTATION_FINGERPRINT = "impl:claim-context";
const RUNTIME_FINGERPRINT = "runtime:claim-context";

const USER_CONTEXT_KEY = Engine.resolveScopeKey("user", {
  principal: PRINCIPAL,
}) as SchedulerExecutionContextKey;
const OTHER_USER_CONTEXT_KEY = Engine.resolveScopeKey("user", {
  principal: OTHER_PRINCIPAL,
}) as SchedulerExecutionContextKey;

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
): ExecutionLease => {
  const lease = Engine.acquireExecutionLease(engine, {
    space: SPACE,
    branch: "",
    hostId: "host:claim-context",
    onBehalfOf: PRINCIPAL,
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
): ExecutionClaim => ({
  branch: "",
  space: SPACE,
  contextKey,
  pieceId: PIECE_ID,
  actionId: ACTION_ID,
  actionKind: "computation",
  implementationFingerprint: IMPLEMENTATION_FINGERPRINT,
  runtimeFingerprint: RUNTIME_FINGERPRINT,
  leaseGeneration: lease.leaseGeneration,
  claimGeneration: 1,
  expiresAt: lease.expiresAt,
});

const spaceAddress = (id: string): SchedulerObservationAddress => ({
  space: SPACE,
  scope: "space",
  id,
  path: ["value"],
});

/** All-space run surfaces: the amendment-20 corner drives the context above
 * space through the durable floor alone, never through the run's surfaces. */
const claimedRunObservation = (
  claim: ExecutionClaim,
  writes: readonly SchedulerObservationAddress[],
): SchedulerActionObservation => ({
  version: 2,
  ownerSpace: SPACE,
  branch: "",
  pieceId: PIECE_ID,
  processGeneration: 1,
  actionId: ACTION_ID,
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
  reads: [],
  shallowReads: [],
  actualChangedWrites: [...writes],
  currentKnownWrites: [...writes],
  materializerWriteEnvelopes: [],
  completeActionScopeSummary: {
    version: 1,
    complete: true,
    implementationFingerprint: IMPLEMENTATION_FINGERPRINT,
    runtimeFingerprint: RUNTIME_FINGERPRINT,
    piece: {
      space: SPACE,
      scope: "space",
      id: PIECE_ID.slice("space:".length),
      path: [],
    },
    reads: [],
    writes: [...writes],
    materializerWriteEnvelopes: [],
    directOutputs: [...writes],
  },
  status: "success",
});

/** Client evidence with a PerUser surface. Committing it unclaimed narrows
 * the durable global context floor for the action to user rank — the one
 * corner (amendment 20) where a later all-space-surface run resolves to a
 * user execution context while the C0 firewall still rejects every
 * user-scoped run surface. */
const narrowFloorToUser = (engine: Engine.Engine): void => {
  const userRead: SchedulerObservationAddress = {
    space: SPACE,
    scope: "user",
    id: "of:claim-context-user-input",
    path: ["value"],
  };
  const observation: SchedulerActionObservation = {
    version: 2,
    ownerSpace: SPACE,
    branch: "",
    pieceId: PIECE_ID,
    processGeneration: 1,
    actionId: ACTION_ID,
    actionKind: "computation",
    implementationFingerprint: IMPLEMENTATION_FINGERPRINT,
    runtimeFingerprint: RUNTIME_FINGERPRINT,
    observedAtSeq: 0,
    transactionKind: "action-run",
    reads: [userRead],
    shallowReads: [],
    actualChangedWrites: [],
    currentKnownWrites: [],
    materializerWriteEnvelopes: [],
    completeActionScopeSummary: {
      version: 1,
      complete: true,
      implementationFingerprint: IMPLEMENTATION_FINGERPRINT,
      runtimeFingerprint: RUNTIME_FINGERPRINT,
      piece: {
        space: SPACE,
        scope: "space",
        id: PIECE_ID.slice("space:".length),
        path: [],
      },
      reads: [userRead],
      writes: [],
      materializerWriteEnvelopes: [],
      directOutputs: [],
    },
    status: "success",
  };
  Engine.applyCommit(engine, {
    sessionId: "client-session",
    space: SPACE,
    principal: PRINCIPAL,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: observation,
    },
  });
};

const applyClaimedObservationOnly = (
  engine: Engine.Engine,
  lease: ExecutionLease,
  claim: ExecutionClaim,
  nowMs: number,
) =>
  Engine.applyCommit(engine, {
    sessionId: "executor-session",
    space: SPACE,
    principal: PRINCIPAL,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: claimedRunObservation(claim, []),
    },
    executionClaims: new Map([[1, claim]]),
    executionLeaseFence: { lease, nowMs, authorize: () => true },
  });

const applyClaimedSemanticCommit = (
  engine: Engine.Engine,
  lease: ExecutionLease,
  claim: ExecutionClaim,
  outputId: string,
  nowMs: number,
  // C1.2: a scoped lane's broad writes must be scope-naming links; only the
  // space lane may commit broad values.
  value: FabricValue = 1,
) => {
  const output = spaceAddress(outputId);
  const commit: ClientCommit = {
    localSeq: 1,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set",
      id: output.id,
      value: { value } as EntityDocument,
    }],
    schedulerObservation: claimedRunObservation(claim, [output]),
  };
  return Engine.applyCommit(engine, {
    sessionId: "executor-session",
    space: SPACE,
    principal: PRINCIPAL,
    commit,
    executionClaims: new Map([[1, claim]]),
    executionLeaseFence: { lease, nowMs, authorize: () => true },
  });
};

Deno.test("user-rank claim commits at the pre-narrowed user context", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    narrowFloorToUser(engine);
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, USER_CONTEXT_KEY);
    // Since C1.2, a scoped lane's broad write is admissible only as the
    // conforming scope-naming link; the corner keeps its all-space run
    // surfaces while the semantic operation carries the link shape.
    const broadLink = scopeNamingLinkForPath([]);
    const applied = applyClaimedSemanticCommit(
      engine,
      lease,
      claim,
      "of:claim-context-output",
      nowMs + 1,
      broadLink,
    );
    assertEquals(
      Engine.read(engine, { id: "of:claim-context-output" }),
      { value: broadLink },
    );
    assertExists(applied.schedulerObservationResults);
    const [result] = applied.schedulerObservationResults;
    assertEquals(result.status, "kept");
    assert(result.status === "kept");
    assertEquals(result.executionContextKey, USER_CONTEXT_KEY);
    assertEquals(
      result.executionProvenance?.claim.contextKey,
      USER_CONTEXT_KEY,
    );
    assertExists(applied.actionAttempts);
    assertEquals(applied.actionAttempts[0].outcome, "committed");
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("effective-context resolution follows the claim's lane, not the sponsor", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    // Pre-C1.4 this fenced claim-context-mismatch: scope resolution rode the
    // sponsor, so bob's claim resolved to user:<alice>. With the C1.4
    // acting-context seam the lane supplies the resolution principal, and
    // the sponsor stays only on onBehalfOf; lane authority is the host's
    // grant registry (laneAuthority / claim issuance), not this equality.
    narrowFloorToUser(engine);
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, OTHER_USER_CONTEXT_KEY);
    const applied = applyClaimedObservationOnly(
      engine,
      lease,
      claim,
      nowMs + 1,
    );
    assertExists(applied.schedulerObservationResults);
    const [result] = applied.schedulerObservationResults;
    assert(result.status === "kept");
    assertEquals(result.executionContextKey, OTHER_USER_CONTEXT_KEY);
    assertEquals(result.executionProvenance?.onBehalfOf, PRINCIPAL);
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("user-rank claim on a run resolving space fences claim-context-mismatch", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, USER_CONTEXT_KEY);
    const error = assertThrows(
      () => applyClaimedObservationOnly(engine, lease, claim, nowMs + 1),
      Engine.ExecutionLeaseFenceError,
    );
    assertEquals(error.fenceCause, "claim-context-mismatch");
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

// C2.1 updated this pin: the admission guard now admits canonical
// session-rank computation claims, so an all-space run under a session claim
// reaches the effective-context fence (claim-context-mismatch) instead of
// the pre-C2 claim-observation-mismatch admission rejection. The session
// lane's own coverage lives in v2-execution-session-claim-context-test.ts.
Deno.test("session-rank claims on space-resolving runs fence claim-context-mismatch", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const sessionKey = Engine.resolveScopeKey("session", {
      principal: PRINCIPAL,
      sessionId: "executor-session",
    }) as SchedulerExecutionContextKey;
    const claim = claimFor(lease, sessionKey);
    const error = assertThrows(
      () => applyClaimedObservationOnly(engine, lease, claim, nowMs + 1),
      Engine.ExecutionLeaseFenceError,
    );
    assertEquals(error.fenceCause, "claim-context-mismatch");
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("scoped-rank effect claims admit and commit under their lane (C2.8 lifts amendment 8)", async () => {
  // C2.8 (2026-07-18, context-lattice OQ6/R12): the computation-only
  // conjunct of `isAdmissibleExecutionClaimContextKey` is lifted — a user-
  // or session-rank EFFECT claim admits exactly like a computation claim.
  // Pre-C2.8 this exact shape fenced `claim-observation-mismatch` on the
  // rank × effect combination alone.
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const claim: ExecutionClaim = {
      ...claimFor(lease, USER_CONTEXT_KEY),
      actionKind: "effect",
    };
    // A user-scoped run surface so the effective context resolves to the
    // claim's own lane: the apply must go all the way through — kept, with
    // provenance under the user context key.
    const userRead: SchedulerObservationAddress = {
      space: SPACE,
      scope: "user",
      id: "of:claim-context-effect-input",
      path: ["value"],
    };
    const base = claimedRunObservation(claim, []);
    const observation: SchedulerActionObservation = {
      ...base,
      actionKind: "effect",
      reads: [userRead],
      completeActionScopeSummary: {
        ...base.completeActionScopeSummary!,
        reads: [userRead],
      },
    };
    const applied = Engine.applyCommit(engine, {
      sessionId: "executor-session",
      space: SPACE,
      principal: PRINCIPAL,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [],
        schedulerObservation: observation,
      },
      executionClaims: new Map([[1, claim]]),
      executionLeaseFence: {
        lease,
        nowMs: nowMs + 1,
        authorize: () => true,
      },
    });
    assertExists(applied.schedulerObservationResults);
    const [result] = applied.schedulerObservationResults;
    assert(result.status === "kept");
    assertEquals(result.executionContextKey, USER_CONTEXT_KEY);
    assertEquals(
      result.executionProvenance?.claim.contextKey,
      USER_CONTEXT_KEY,
    );
    assertEquals(result.executionProvenance?.claim.actionKind, "effect");
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a session-rank effect claim on a space-resolving run reaches the effective-context fence (C2.8)", async () => {
  // Companion to the session-rank computation case above: post-C2.8 the
  // rank × effect combination is admissible, so the mismatch this run DOES
  // have — its surfaces resolve space, the claim names a session lane —
  // fences `claim-context-mismatch`, never the pre-C2.8 admission
  // rejection (`claim-observation-mismatch`).
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const sessionKey = Engine.resolveScopeKey("session", {
      principal: PRINCIPAL,
      sessionId: "executor-session",
    }) as SchedulerExecutionContextKey;
    const claim: ExecutionClaim = {
      ...claimFor(lease, sessionKey),
      actionKind: "effect",
    };
    const observation: SchedulerActionObservation = {
      ...claimedRunObservation(claim, []),
      actionKind: "effect",
    };
    const error = assertThrows(
      () =>
        Engine.applyCommit(engine, {
          sessionId: "executor-session",
          space: SPACE,
          principal: PRINCIPAL,
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [],
            schedulerObservation: observation,
          },
          executionClaims: new Map([[1, claim]]),
          executionLeaseFence: {
            lease,
            nowMs: nowMs + 1,
            authorize: () => true,
          },
        }),
      Engine.ExecutionLeaseFenceError,
    );
    assertEquals(error.fenceCause, "claim-context-mismatch");
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("malformed user-rank claim keys fence claim-observation-mismatch", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    // Empty principal, and a naive un-encoded colon-bearing DID: neither is
    // a well-formed canonical user context key.
    for (
      const malformed of [
        "user:",
        `user:${PRINCIPAL}`,
      ] as SchedulerExecutionContextKey[]
    ) {
      const claim = claimFor(lease, malformed);
      const error = assertThrows(
        () => applyClaimedObservationOnly(engine, lease, claim, nowMs + 1),
        Engine.ExecutionLeaseFenceError,
      );
      assertEquals(error.fenceCause, "claim-observation-mismatch", malformed);
    }
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("space-rank claim behavior is unchanged by user-rank admission", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, "space");
    const applied = applyClaimedSemanticCommit(
      engine,
      lease,
      claim,
      "of:claim-context-space-output",
      nowMs + 1,
    );
    assertEquals(
      Engine.read(engine, { id: "of:claim-context-space-output" }),
      { value: 1 },
    );
    assertExists(applied.schedulerObservationResults);
    const [result] = applied.schedulerObservationResults;
    assert(result.status === "kept");
    assertEquals(result.executionContextKey, "space");
    assertEquals(result.executionProvenance?.claim.contextKey, "space");
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("canonical user context key helpers round-trip colon-bearing DIDs", () => {
  const did = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
  const key = Engine.userExecutionContextKey(did);
  // Construction delegates to the engine's scope-key encoding: colons are
  // percent-encoded, so the canonical key never carries the DID raw.
  assertEquals(key, `user:${encodeURIComponent(did)}`);
  assertEquals(key, Engine.resolveScopeKey("user", { principal: did }));
  assertEquals(Engine.principalOfUserContextKey(key), did);
  // Naive concatenation, empty principals, and foreign ranks do not parse.
  assertEquals(Engine.principalOfUserContextKey(`user:${did}`), undefined);
  assertEquals(Engine.principalOfUserContextKey("user:"), undefined);
  assertEquals(Engine.principalOfUserContextKey("space"), undefined);
  assertEquals(
    Engine.principalOfUserContextKey(
      Engine.resolveScopeKey("session", { principal: did, sessionId: "s" }),
    ),
    undefined,
  );
});

Deno.test("the claim guard admits a helper-built colon-bearing user key", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    narrowFloorToUser(engine);
    const lease = acquire(engine, nowMs);
    const claim = claimFor(
      lease,
      Engine.userExecutionContextKey(
        PRINCIPAL,
      ) as SchedulerExecutionContextKey,
    );
    const applied = applyClaimedObservationOnly(
      engine,
      lease,
      claim,
      nowMs + 1,
    );
    assertExists(applied.schedulerObservationResults);
    const [result] = applied.schedulerObservationResults;
    assert(result.status === "kept");
    assertEquals(result.executionContextKey, USER_CONTEXT_KEY);
    assertEquals(
      result.executionProvenance?.claim.contextKey,
      USER_CONTEXT_KEY,
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("with-operations context mismatch fences claim-context-mismatch", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    // A space claim whose run's durable floor evaluates to user rank is the
    // same semantic condition as the observation-only twin; amendment 14
    // requires it to fence (counted, R7-tolerated) rather than surface as an
    // uncounted ProtocolError.
    narrowFloorToUser(engine);
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, "space");
    const before = Engine.serverSeq(engine);
    const error = assertThrows(
      () =>
        applyClaimedSemanticCommit(
          engine,
          lease,
          claim,
          "of:claim-context-fenced-output",
          nowMs + 1,
        ),
      Engine.ExecutionLeaseFenceError,
    );
    assertEquals(error.fenceCause, "claim-context-mismatch");
    assertEquals(Engine.serverSeq(engine), before);
    assertEquals(
      Engine.read(engine, { id: "of:claim-context-fenced-output" }),
      null,
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// R7: the OTHER direction — a claim BROADER than the action's durable floor.
//
// Every pin above covers a claim NARROWER than the run resolves (a user-rank
// claim on a space-resolving run). The direction that actually fires in
// production is the reverse, and it is the one the C2.10 R7 retirement did
// not cover: an ordinary UNCLAIMED client run reads PerUser/PerSession state
// and durably narrows the action's context floor; the floor is monotonic, so
// every later run of that action resolves at the narrowed rank even when its
// OWN surfaces are entirely space-scoped; and the executor — which classifies
// its candidate from the current observation's surfaces alone and cannot see
// the floor — keeps proposing a space-rank claim that can never match.
//
// Measured on the real group-chat product: a `cf:builtin/map:v1` action
// fenced on every space-rank claim, with staticFloor=space, runtimeFloor=
// space, globalFloor=user, principalFloor=session (client-passivity §5g,
// "R7 diagnosis").
// ---------------------------------------------------------------------------

Deno.test("R7 mechanism: a prior UNCLAIMED client run narrows the floor, and a later space-rank claim on an all-space run fences claim-context-mismatch", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    // The client run that pins the floor. Nothing about it is claimed.
    narrowFloorToUser(engine);
    const lease = acquire(engine, nowMs);
    // A SPACE claim — exactly what the executor proposes for a run whose own
    // surfaces are all-space, because that is all it can see.
    const claim = claimFor(
      lease,
      "space" as SchedulerExecutionContextKey,
    );
    const error = assertThrows(
      () => applyClaimedObservationOnly(engine, lease, claim, nowMs + 1),
      Engine.ExecutionLeaseFenceError,
    );
    assertEquals(error.fenceCause, "claim-context-mismatch");
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("R7: the issuance-side floor consult reports the narrowed floor for the action identity a claim key names", async () => {
  const { directory, engine } = await openTempEngine();
  try {
    const claimKey = {
      branch: "" as const,
      pieceId: PIECE_ID,
      actionId: ACTION_ID,
      implementationFingerprint: IMPLEMENTATION_FINGERPRINT,
      runtimeFingerprint: RUNTIME_FINGERPRINT,
    };
    // Nothing observed yet: no floor, so issuance must not decline anything.
    assertEquals(
      Engine.schedulerClaimContextFloor(engine, claimKey, undefined),
      "space",
    );
    narrowFloorToUser(engine);
    // The GLOBAL row is principal-independent, so a space-rank claim (which
    // names no principal) sees it — this is the row that makes the measured
    // group-chat case decidable at issuance.
    assertEquals(
      Engine.schedulerClaimContextFloor(engine, claimKey, undefined),
      "user",
    );
    // A different action identity is unaffected: the consult must not leak
    // one action's floor onto another's claim.
    assertEquals(
      Engine.schedulerClaimContextFloor(
        engine,
        { ...claimKey, actionId: "action:unrelated" },
        undefined,
      ),
      "space",
    );
    // Nor across a fingerprint change — different code, different shape.
    assertEquals(
      Engine.schedulerClaimContextFloor(
        engine,
        { ...claimKey, implementationFingerprint: "impl:other" },
        undefined,
      ),
      "space",
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});
