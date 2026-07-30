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

/**
 * Client evidence whose runtime writes ESCAPE the action's declared write
 * envelope — the measured `cf:builtin/map:v1` shape (client-passivity §5h.3
 * follow-up, 2026-07-29): a first reconcile instantiates the element
 * sub-patterns, so the run's `actualChangedWrites` carry a whole child document
 * that the action's three declared envelopes never named. NOTHING here is
 * session-scoped; the only scoped surface is one PerUser read.
 */
const narrowFloorByEnvelopeEscape = (engine: Engine.Engine): void => {
  const userRead: SchedulerObservationAddress = {
    space: SPACE,
    scope: "user",
    id: "of:claim-context-user-input",
    path: ["value"],
  };
  const declaredOutput = spaceAddress("of:claim-context-output");
  // The child sub-pattern document map mints during reconcile. Outside every
  // declared envelope, exactly as measured.
  const childDocumentWrite: SchedulerObservationAddress = {
    space: SPACE,
    scope: "space",
    id: "of:claim-context-child-instantiated",
    path: ["argument"],
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
    actualChangedWrites: [declaredOutput, childDocumentWrite],
    currentKnownWrites: [declaredOutput],
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
      writes: [declaredOutput],
      materializerWriteEnvelopes: [],
      directOutputs: [declaredOutput],
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
  localSeq = 1,
) =>
  Engine.applyCommit(engine, {
    sessionId: "executor-session",
    space: SPACE,
    principal: PRINCIPAL,
    commit: {
      localSeq,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: claimedRunObservation(claim, []),
    },
    executionClaims: new Map([[localSeq, claim]]),
    executionLeaseFence: { lease, nowMs, authorize: () => true },
  });

/** The context an all-space claimed run RESOLVES to under `lane` — the
 * durable floor's only observable consequence now that the issuance-side
 * reader is deleted. */
const resolvedContextUnderLane = (
  engine: Engine.Engine,
  lease: ExecutionLease,
  lane: SchedulerExecutionContextKey,
  nowMs: number,
  localSeq: number,
): SchedulerExecutionContextKey | undefined =>
  applyClaimedObservationOnly(
    engine,
    lease,
    claimFor(lease, lane),
    nowMs,
    localSeq,
  ).schedulerObservationResults?.[0]?.executionContextKey;

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

// RE-EXPECTED by slice 1 of the claim deletion (was: "user-rank claim on a
// run resolving space fences claim-context-mismatch"). The fence compared the
// context the run RESOLVED to against the context the claim was issued at and
// refused the commit when they disagreed. A rank the run resolves to
// differently is an observation, never a refusal (D11 / client-passivity
// §5h.4), so the commit is KEPT and the resolved context is recorded as-is.
Deno.test("a user-rank lane whose run resolves space commits at the RESOLVED context", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, USER_CONTEXT_KEY);
    const applied = applyClaimedObservationOnly(
      engine,
      lease,
      claim,
      nowMs + 1,
    );
    assertExists(applied.schedulerObservationResults);
    const [result] = applied.schedulerObservationResults;
    assert(result.status === "kept");
    // The run's own surfaces are all-space and no floor narrows it, so the
    // effective context is `space` even though the lane is user rank.
    assertEquals(result.executionContextKey, "space");
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

// C2.1 updated this pin: the admission guard admits canonical session-rank
// computation claims, so an all-space run under a session lane passes
// admission rather than rejecting `claim-observation-mismatch`. RE-EXPECTED
// by slice 1 (was: "…fence claim-context-mismatch"): past admission there is
// no longer an effective-context fence to reach — the resolved context is the
// context. The session lane's own coverage lives in
// v2-execution-session-claim-context-test.ts.
Deno.test("session-rank lanes on space-resolving runs commit at the RESOLVED context", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const sessionKey = Engine.resolveScopeKey("session", {
      principal: PRINCIPAL,
      sessionId: "executor-session",
    }) as SchedulerExecutionContextKey;
    const claim = claimFor(lease, sessionKey);
    const applied = applyClaimedObservationOnly(
      engine,
      lease,
      claim,
      nowMs + 1,
    );
    assertExists(applied.schedulerObservationResults);
    const [result] = applied.schedulerObservationResults;
    assert(result.status === "kept");
    assertEquals(result.executionContextKey, "space");
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

// RE-EXPECTED by slice 1 (was: "…reaches the effective-context fence (C2.8)").
Deno.test("a session-rank effect lane on a space-resolving run commits (C2.8)", async () => {
  // Companion to the session-rank computation case above: post-C2.8 the
  // rank × effect combination is admissible, so this run passes admission
  // rather than rejecting `claim-observation-mismatch`. What it used to hit
  // next — `claim-context-mismatch`, because its surfaces resolve space while
  // the lane names a session — is deleted, so it commits.
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
    assertEquals(result.executionContextKey, "space");
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

// RE-EXPECTED by slice 1 (was: "with-operations context mismatch fences
// claim-context-mismatch"). This is the R7 shape and it is the one the owner
// ruled on directly: a SPACE-acting run whose action identity carries a
// durable floor another observer narrowed to user.
//
// It writes a broad VALUE and that is not a cross-principal leak. A
// space-acting commit cannot consume scoped state at all: with no lane scope
// key `assertLaneScopedAddress` rejects every user/session-scoped read AND
// write surface `non-space-scope` before this point. So the value is derived
// from all-space inputs whatever the durable floor of the action IDENTITY
// says — the floor is monotonic bookkeeping about the identity, not evidence
// about this run.
Deno.test("a space-acting run commits its broad value even when the durable floor resolves user", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    narrowFloorToUser(engine);
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, "space");
    const applied = applyClaimedSemanticCommit(
      engine,
      lease,
      claim,
      "of:claim-context-fenced-output",
      nowMs + 1,
    );
    assertExists(applied.schedulerObservationResults);
    const [result] = applied.schedulerObservationResults;
    assert(result.status === "kept");
    // The resolved context is the narrowed one, and it is RECORDED, not
    // refused — that is the whole content of "a rank changing is not a reason
    // to decline".
    assertEquals(result.executionContextKey, USER_CONTEXT_KEY);
    assertEquals(
      Engine.read(engine, { id: "of:claim-context-fenced-output" }),
      { value: 1 },
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

// RE-EXPECTED by slice 1 (was: "…fences claim-context-mismatch"). The R7
// MECHANISM is unchanged and still worth pinning — a prior unclaimed client
// run durably narrows the floor and every later run of that identity resolves
// at the narrowed rank. What changed is the CONSEQUENCE: the narrowed
// resolution is recorded, not refused, so the run that used to burn itself
// against the fence now serves.
Deno.test("R7 mechanism: a prior UNCLAIMED client run narrows the floor, and a later space-lane run on all-space surfaces still commits at the narrowed context", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    // The client run that pins the floor. Nothing about it is claimed.
    narrowFloorToUser(engine);
    const lease = acquire(engine, nowMs);
    // A SPACE lane — exactly what the executor acts as for a run whose own
    // surfaces are all-space, because that is all it can see.
    const claim = claimFor(
      lease,
      "space" as SchedulerExecutionContextKey,
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
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

// DELETED by slice 1 (was: "R7: the issuance-side floor consult reports the
// narrowed floor for the action identity a claim key names"). The consult
// (`Engine.schedulerClaimContextFloor`) and its only caller
// (`#assertExecutionClaimContextFloorAdmits`) existed for exactly one job —
// declining a claim at ISSUANCE because the engine would later fence it
// `claim-context-mismatch`. With no fence there is nothing to decline in
// advance of. The floor READER the engine's own resolution uses
// (`schedulerContextFloor`) is untouched and is pinned by the durable-floor
// tests below.

// ---------------------------------------------------------------------------
// The durable floor must record what an action's DECLARED SHAPE forces on
// every principal — never a transient, run-order-dependent property of one
// observation.
//
// `schedulerRuntimeContextFloor` returns "session" for four different reasons,
// and only one of them is a genuine session scope. One of the other three —
// "this run's writes escaped its declared envelope"
// (`schedulerRuntimeWritesExceedSummary`) — is a fail-closed sentinel meaning
// "not bounded by its summary", and it is OBSERVER-SPECIFIC: whether a
// materializer instantiates its children on a given run depends on WHEN that
// run happened, not on the action's shape. Writing that sentinel to the
// durable per-principal row makes it permanent and monotonic, so one first
// reconcile starves the action forever at every rank: broader claims are
// declined by the R7 issuance consult, and any claim that is somehow issued
// fences `claim-context-mismatch`.
//
// C3.11 established exactly this rule for the sibling disjunct (the
// cross-space-read demotion, engine.ts `resolveSchedulerExecutionContext`):
// observer-specific narrowing stays in the observation's OWN effective floor
// and is exempt from the durable global/principal write.
//
// Measured on the flagship group-chat probe (client-passivity §5h.3
// follow-up, 2026-07-29): `cf:builtin/map:v1` carries ZERO session-scoped
// addresses in every summary and every observation, yet its durable
// per-principal floor is `session` — 5-9 resolutions per action of
// staticFloor=space / runtimeFloor=space resolving to `session` purely from
// the poisoned row, producing `claim-authority-lost` x4 and
// `claim-key-mismatch` x2 in the user and session arms and
// `commit-rejected:ExecutionLeaseFenceError` x2 in the space arm.
// ---------------------------------------------------------------------------

// Slice 1 re-pointed this test's INSTRUMENT, not its subject: the
// issuance-side reader it used to call (`Engine.schedulerClaimContextFloor`)
// is deleted with the claim gate, so the floor is asserted through its only
// remaining observable — the context a later run resolves to.
Deno.test("an envelope-escaping client run does not durably narrow the floor to session", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    narrowFloorByEnvelopeEscape(engine);
    const lease = acquire(engine, nowMs);
    // The PerUser read is real evidence and floors the action at user rank.
    // The envelope escape is not evidence of ANY scope, so it must not add a
    // session row on top — a session floor would resolve a `session:` key.
    assertEquals(
      resolvedContextUnderLane(engine, lease, USER_CONTEXT_KEY, nowMs + 1, 1),
      USER_CONTEXT_KEY,
    );
    // And no other principal inherits anything narrower either.
    assertEquals(
      resolvedContextUnderLane(
        engine,
        lease,
        OTHER_USER_CONTEXT_KEY,
        nowMs + 2,
        2,
      ),
      OTHER_USER_CONTEXT_KEY,
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a later in-envelope run stays servable at user rank after an envelope-escaping client run", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    narrowFloorByEnvelopeEscape(engine);
    const lease = acquire(engine, nowMs);
    // The rank the executor classifies from this action's surfaces, and the
    // rank the PerUser read genuinely forces: user. It must commit.
    const claim = claimFor(lease, USER_CONTEXT_KEY);
    const applied = applyClaimedObservationOnly(
      engine,
      lease,
      claim,
      nowMs + 1,
    );
    assertEquals(
      applied.schedulerObservationResults?.[0]?.executionContextKey,
      USER_CONTEXT_KEY,
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a genuine PerSession surface still narrows the durable floor to session", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const sessionRead: SchedulerObservationAddress = {
      space: SPACE,
      scope: "session",
      id: "of:claim-context-session-input",
      path: ["value"],
    };
    Engine.applyCommit(engine, {
      sessionId: "client-session",
      space: SPACE,
      principal: PRINCIPAL,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [],
        schedulerObservation: {
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
          reads: [sessionRead],
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
            reads: [sessionRead],
            writes: [],
            materializerWriteEnvelopes: [],
            directOutputs: [],
          },
          status: "success",
        },
      },
    });
    // A later all-space run of the same identity resolves at the narrowed
    // floor: the sponsor session's own session context, not user rank.
    const lease = acquire(engine, nowMs);
    assertEquals(
      resolvedContextUnderLane(engine, lease, USER_CONTEXT_KEY, nowMs + 1, 2),
      Engine.resolveScopeKey("session", {
        principal: PRINCIPAL,
        sessionId: "executor-session",
      }),
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});
