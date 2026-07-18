// C2.1 (session lanes, engine half): the claim-rank admission guard
// (`isAdmissibleExecutionClaimContextKey`), the commit-lane resolution
// (`admitExecutionCommitLanes` — amendment CA1's second and third seams),
// the canonical session-key parse (CA12), and the session leg of the
// commit-fence WRITE re-check (CA7). Sponsor identities deliberately differ
// from the lane session everywhere, so any path that leaks the sponsor's
// sessionId into session-scope resolution fails these fixtures.
import { assert, assertEquals, assertExists, assertThrows } from "@std/assert";
import { toFileUrl } from "@std/path";
import type {
  ClientCommit,
  ExecutionClaim,
  ExecutionLease,
  Operation,
} from "../v2.ts";
import * as Engine from "../v2/engine.ts";
import type {
  SchedulerActionObservation,
  SchedulerExecutionContextKey,
  SchedulerObservationAddress,
} from "../v2/engine.ts";

const SPACE = "did:key:z6Mk-session-claim-space";
// Colon-bearing DIDs: canonical session context keys percent-encode both
// segments, so naive `session:${did}:${sessionId}` concatenation never
// matches a canonical key.
const PRINCIPAL = "did:key:z6Mk-session-claim-alice";
const SPONSOR = "did:key:z6Mk-session-claim-sponsor-bob";
const LANE_SESSION_ID = "session-alpha";
const SIBLING_SESSION_ID = "session-beta";
// The provider/sponsor session — never the lane session.
const EXECUTOR_SESSION_ID = "executor-session";
const PIECE_ID = "space:of:session-claim-piece";
const ACTION_ID = "action:session-claim";
const IMPLEMENTATION_FINGERPRINT = "impl:session-claim";
const RUNTIME_FINGERPRINT = "runtime:session-claim";

const SESSION_CONTEXT_KEY = Engine.sessionExecutionContextKey(
  PRINCIPAL,
  LANE_SESSION_ID,
) as SchedulerExecutionContextKey;
const SIBLING_CONTEXT_KEY = Engine.sessionExecutionContextKey(
  PRINCIPAL,
  SIBLING_SESSION_ID,
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
): ExecutionLease => {
  const lease = Engine.acquireExecutionLease(engine, {
    space: SPACE,
    branch: "",
    hostId: "host:session-claim",
    onBehalfOf: SPONSOR,
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

const address = (
  scope: "space" | "user" | "session",
  id: string,
): SchedulerObservationAddress => ({
  space: SPACE,
  scope,
  id,
  path: ["value"],
});

const SESSION_OUTPUT = address("session", "of:session-claim-output");

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
  actionKind: claim.actionKind,
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

type ApplyClaimedOptions = {
  operations?: Operation[];
  surfaces?: {
    reads?: readonly SchedulerObservationAddress[];
    writes?: readonly SchedulerObservationAddress[];
  };
  nowMs: number;
  localSeq?: number;
  fence?: Partial<Engine.ExecutionLeaseFence>;
  /** Override the per-localSeq live-claim map (defaults to the asserted
   * claim itself). */
  executionClaims?: ReadonlyMap<number, ExecutionClaim>;
};

/** Sponsor-bound apply: `principal`/`sessionId` are ALWAYS the sponsor's;
 * the session lane's identity may only enter through the claim contextKey. */
const applyClaimed = (
  engine: Engine.Engine,
  lease: ExecutionLease,
  claim: ExecutionClaim,
  options: ApplyClaimedOptions,
) => {
  const localSeq = options.localSeq ?? 1;
  const commit: ClientCommit = {
    localSeq,
    reads: { confirmed: [], pending: [] },
    operations: options.operations ?? [],
    schedulerObservation: observationFor(claim, options.surfaces ?? {}),
  };
  return Engine.applyCommit(engine, {
    sessionId: EXECUTOR_SESSION_ID,
    scopeSessionId: EXECUTOR_SESSION_ID,
    space: SPACE,
    principal: SPONSOR,
    commit,
    executionClaims: options.executionClaims ?? new Map([[localSeq, claim]]),
    executionLeaseFence: {
      lease,
      nowMs: options.nowMs,
      authorize: () => true,
      ...options.fence,
    },
  });
};

const assertFenceCause = (
  fn: () => unknown,
  cause: string,
  context?: string,
) => {
  const error = assertThrows(fn, Engine.ExecutionLeaseFenceError, "", context);
  assertEquals(error.fenceCause, cause, context);
};

const sessionInstanceOperation: Operation = {
  op: "set",
  id: SESSION_OUTPUT.id,
  scope: "session",
  value: { value: 7 },
};

Deno.test("a session-rank claim commits at ITS OWN session context, never the sponsor's", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, SESSION_CONTEXT_KEY);
    const applied = applyClaimed(engine, lease, claim, {
      operations: [sessionInstanceOperation],
      surfaces: { writes: [SESSION_OUTPUT] },
      nowMs: nowMs + 1,
    });
    assertExists(applied.schedulerObservationResults);
    const [result] = applied.schedulerObservationResults;
    assert(result.status === "kept");
    // The effective context is the LANE's session — resolved from the claim
    // contextKey — although the committing (sponsor) session is
    // executor-session. A build that threads the sponsor's sessionId into
    // session-scope resolution fences claim-context-mismatch here instead.
    assertEquals(result.executionContextKey, SESSION_CONTEXT_KEY);
    assertEquals(
      result.executionProvenance?.claim.contextKey,
      SESSION_CONTEXT_KEY,
    );
    assertEquals(result.executionProvenance?.onBehalfOf, SPONSOR);
    // The semantic write landed at the lane session's instance…
    assertEquals(
      Engine.read(engine, {
        id: SESSION_OUTPUT.id,
        scope: "session",
        principal: PRINCIPAL,
        sessionId: LANE_SESSION_ID,
      }),
      { value: 7 },
    );
    // …and nowhere else: not the sponsor session's, not a sibling's.
    assertEquals(
      Engine.read(engine, {
        id: SESSION_OUTPUT.id,
        scope: "session",
        principal: SPONSOR,
        sessionId: EXECUTOR_SESSION_ID,
      }),
      null,
    );
    assertEquals(
      Engine.read(engine, {
        id: SESSION_OUTPUT.id,
        scope: "session",
        principal: PRINCIPAL,
        sessionId: SIBLING_SESSION_ID,
      }),
      null,
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a session-rank claim on a run resolving space fences claim-context-mismatch", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    // All-space surfaces: the effective context resolves `space`, so the
    // session claim mismatches — the C2.1 commit-lane fence is a REAL check
    // (pre-C2.1 this fenced claim-observation-mismatch at the admission
    // guard instead; the guard now admits canonical session keys).
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, SESSION_CONTEXT_KEY);
    assertFenceCause(
      () => applyClaimed(engine, lease, claim, { nowMs: nowMs + 1 }),
      "claim-context-mismatch",
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("session-rank effect claims fence claim-observation-mismatch (amendment 8 holds until C2.8)", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const claim: ExecutionClaim = {
      ...claimFor(lease, SESSION_CONTEXT_KEY),
      actionKind: "effect",
    };
    // Matching effect observation: the guard must reject the session-rank ×
    // effect combination itself, not a claim/observation kind mismatch.
    assertFenceCause(
      () =>
        applyClaimed(engine, lease, claim, {
          surfaces: { writes: [SESSION_OUTPUT] },
          nowMs: nowMs + 1,
        }),
      "claim-observation-mismatch",
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("malformed session-rank claim keys fence claim-observation-mismatch", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    for (
      const malformed of [
        // Naive un-encoded colon-bearing DID: ambiguous segmentation — the
        // canonical parse sees five segments, not a (did, sessionId) pair.
        `session:${PRINCIPAL}:${LANE_SESSION_ID}`,
        // The generic ambiguous shape from the CA12 red case.
        "session:a:b:c",
        // Empty segments.
        "session::",
        // A did with no session id.
        `session:${encodeURIComponent(PRINCIPAL)}`,
        // Non-canonical percent-encoding (decodes, but does not re-encode
        // byte-exactly through the single construction site).
        "session:a%2fb:s",
      ] as SchedulerExecutionContextKey[]
    ) {
      const claim = claimFor(lease, malformed);
      assertFenceCause(
        () => applyClaimed(engine, lease, claim, { nowMs: nowMs + 1 }),
        "claim-observation-mismatch",
        malformed,
      );
    }
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("the commit-lane fence rejects a session assertion whose live claim names another session", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    // The commit asserts the s1 lane while the host-resolved live claim for
    // that attempt names the sibling s2 lane: pre-C2.1 the session
    // early-return made this throw unreachable; it is now a real fence.
    const lease = acquire(engine, nowMs);
    const asserted = claimFor(lease, SESSION_CONTEXT_KEY);
    const live = claimFor(lease, SIBLING_CONTEXT_KEY);
    assertFenceCause(
      () =>
        applyClaimed(engine, lease, asserted, {
          nowMs: nowMs + 1,
          executionClaims: new Map([[1, live]]),
        }),
      "claim-observation-mismatch",
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("stale session lane generations fence commits with lane-generation-stale", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, SESSION_CONTEXT_KEY);
    const before = Engine.serverSeq(engine);
    assertFenceCause(
      () =>
        applyClaimed(engine, lease, claim, {
          operations: [sessionInstanceOperation],
          surfaces: { writes: [SESSION_OUTPUT] },
          nowMs: nowMs + 1,
          fence: { laneAuthority: () => false },
        }),
      "lane-generation-stale",
    );
    assertEquals(Engine.serverSeq(engine), before);
    assertEquals(
      Engine.read(engine, {
        id: SESSION_OUTPUT.id,
        scope: "session",
        principal: PRINCIPAL,
        sessionId: LANE_SESSION_ID,
      }),
      null,
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("session acting-principal WRITE loss at commit time fences lane-write-authority (CA7)", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    // The session commit-fence WRITE re-check must fail CLOSED: the acting
    // principal decodes from the canonical session key (never the sponsor),
    // and losing WRITE fences the commit before any row lands.
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, SESSION_CONTEXT_KEY);
    const consulted: string[] = [];
    const before = Engine.serverSeq(engine);
    assertFenceCause(
      () =>
        applyClaimed(engine, lease, claim, {
          operations: [sessionInstanceOperation],
          surfaces: { writes: [SESSION_OUTPUT] },
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
    assertEquals(consulted, [PRINCIPAL]);
    assertEquals(Engine.serverSeq(engine), before);
    assertEquals(
      Engine.read(engine, {
        id: SESSION_OUTPUT.id,
        scope: "session",
        principal: PRINCIPAL,
        sessionId: LANE_SESSION_ID,
      }),
      null,
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("exact session observation replays stay idempotent after a lane drain (mid-settle)", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    // Host-side drain on disconnect includes mid-settle: the settlement that
    // raced the drain replays its stored result instead of fencing, so a
    // lost-response retry settles clean (design §3).
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, SESSION_CONTEXT_KEY);
    const apply = (laneLive: boolean) =>
      applyClaimed(engine, lease, claim, {
        surfaces: { writes: [SESSION_OUTPUT] },
        nowMs: nowMs + 1,
        fence: { laneAuthority: () => laneLive },
      });
    const first = apply(true);
    assert(first.schedulerObservationResults?.[0].status === "kept");
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

Deno.test("canonical session context key helpers round-trip colon-bearing DIDs (CA12)", () => {
  const did = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
  const sessionId = "session:with:colons";
  const key = Engine.sessionExecutionContextKey(did, sessionId);
  assertEquals(
    key,
    `session:${encodeURIComponent(did)}:${encodeURIComponent(sessionId)}`,
  );
  assertEquals(
    key,
    Engine.resolveScopeKey("session", { principal: did, sessionId }),
  );
  assertEquals(Engine.parseSessionExecutionContextKey(key), {
    principal: did,
    sessionId,
  });
  // Naive concatenation, empty/missing segments, over-segmented shapes,
  // non-canonical escapes, and foreign ranks do not parse.
  for (
    const malformed of [
      `session:${did}:${sessionId}`,
      "session::",
      "session:a:b:c",
      `session:${encodeURIComponent(did)}`,
      "session:a%2fb:s",
      "session:",
      "space",
      Engine.userExecutionContextKey(did),
    ]
  ) {
    assertEquals(
      Engine.parseSessionExecutionContextKey(malformed),
      undefined,
      malformed,
    );
  }
});
