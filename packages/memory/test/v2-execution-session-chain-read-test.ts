// CA3 (engine half, C2 review): the broader-in-chain READ collapse. A
// session lane's admissible READ surface is its own §2 chain — the shared
// space scope, the LANE principal's user instance, and the lane's own
// session instance — so a session-claimed commit whose read set includes the
// lane principal's user-scoped input passes the per-address firewall and
// resolves HER user instance (the lane principal's, never the sponsor's).
// WRITES never widen (§4): a session lane writing a user-scoped address —
// operations, summary-declared writes, and entity-absent preconditions alike
// — stays rejected exact-lane, and the chain is one-directional (a USER lane
// reading a session-scoped address still rejects). Sponsor identities
// deliberately differ from the lane session everywhere, mirroring
// v2-execution-session-claim-context-test.ts.
import { assert, assertEquals, assertExists, assertThrows } from "@std/assert";
import { toFileUrl } from "@std/path";
import {
  type ClientCommit,
  type ConfirmedRead,
  type ExecutionClaim,
  type ExecutionLease,
  type Operation,
  toDocumentPath,
} from "../v2.ts";
import * as Engine from "../v2/engine.ts";
import type {
  SchedulerActionObservation,
  SchedulerExecutionContextKey,
  SchedulerObservationAddress,
} from "../v2/engine.ts";

const SPACE = "did:key:z6Mk-session-chain-space";
// Colon-bearing DIDs: canonical scope keys percent-encode segments.
const PRINCIPAL = "did:key:z6Mk-session-chain-alice";
const SPONSOR = "did:key:z6Mk-session-chain-sponsor-bob";
const LANE_SESSION_ID = "session-alpha";
// The provider/sponsor session — never the lane session.
const EXECUTOR_SESSION_ID = "executor-session";
const PIECE_ID = "space:of:session-chain-piece";
const ACTION_ID = "action:session-chain";
const IMPLEMENTATION_FINGERPRINT = "impl:session-chain";
const RUNTIME_FINGERPRINT = "runtime:session-chain";

const SESSION_CONTEXT_KEY = Engine.sessionExecutionContextKey(
  PRINCIPAL,
  LANE_SESSION_ID,
) as SchedulerExecutionContextKey;
const USER_CONTEXT_KEY = Engine.userExecutionContextKey(
  PRINCIPAL,
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
    hostId: "host:session-chain",
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

const USER_INPUT = address("user", "of:session-chain-user-input");
const SPACE_INPUT = address("space", "of:session-chain-space-input");
const SESSION_INPUT = address("session", "of:session-chain-session-input");
const SESSION_OUTPUT = address("session", "of:session-chain-output");
const USER_OUTPUT = address("user", "of:session-chain-user-output");

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
  confirmedReads?: ConfirmedRead[];
  preconditions?: ClientCommit["preconditions"];
  surfaces?: {
    reads?: readonly SchedulerObservationAddress[];
    writes?: readonly SchedulerObservationAddress[];
  };
  nowMs: number;
  localSeq?: number;
};

/** Sponsor-bound apply: `principal`/`sessionId` are ALWAYS the sponsor's;
 * the session lane's identity may only enter through the claim contextKey. */
const applyClaimed = (
  engine: Engine.Engine,
  lease: ExecutionLease,
  claim: ExecutionClaim,
  options: ApplyClaimedOptions,
) => {
  const localSeq = options.localSeq ?? 10;
  const commit: ClientCommit = {
    localSeq,
    reads: { confirmed: options.confirmedReads ?? [], pending: [] },
    operations: options.operations ?? [],
    ...(options.preconditions !== undefined
      ? { preconditions: options.preconditions }
      : {}),
    schedulerObservation: observationFor(claim, options.surfaces ?? {}),
  };
  return Engine.applyCommit(engine, {
    sessionId: EXECUTOR_SESSION_ID,
    scopeSessionId: EXECUTOR_SESSION_ID,
    space: SPACE,
    principal: SPONSOR,
    commit,
    executionClaims: new Map([[localSeq, claim]]),
    executionLeaseFence: {
      lease,
      nowMs: options.nowMs,
      authorize: () => true,
    },
  });
};

const seedWrite = (
  engine: Engine.Engine,
  options: {
    sessionId: string;
    principal: string;
    localSeq: number;
    id: string;
    scope?: "user" | "session";
    value: string | number;
  },
): number =>
  Engine.applyCommit(engine, {
    sessionId: options.sessionId,
    space: SPACE,
    principal: options.principal,
    commit: {
      localSeq: options.localSeq,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: options.id,
        ...(options.scope !== undefined ? { scope: options.scope } : {}),
        value: { value: options.value },
      }],
    },
  }).seq;

const assertFirewallCode = (
  fn: () => unknown,
  diagnosticCode: string,
  context?: string,
) => {
  const error = assertThrows(
    fn,
    Engine.ExecutionActionFirewallError,
    "",
    context,
  );
  assertEquals(error.diagnosticCode, diagnosticCode, context);
};

const sessionOutputOperation: Operation = {
  op: "set",
  id: SESSION_OUTPUT.id,
  scope: "session",
  value: { value: 7 },
};

// --- (c) The chain collapse: a session-claimed commit READING the lane
// principal's user-scoped input (beside space and own-session inputs)
// passes the firewall and resolves HER instance. ---

Deno.test("a session-claimed commit reading the lane principal's user-scoped input passes and resolves her instance", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    // Alice's user instance exists BEFORE the sponsor's: a later write to the
    // SPONSOR's user instance must not conflict with the lane's confirmed
    // read — if chain-user resolution ever threads the sponsor principal,
    // the read goes stale against bob's later revision and this test reds.
    const aliceSeq = seedWrite(engine, {
      sessionId: LANE_SESSION_ID,
      principal: PRINCIPAL,
      localSeq: 1,
      id: USER_INPUT.id,
      scope: "user",
      value: 5,
    });
    seedWrite(engine, {
      sessionId: EXECUTOR_SESSION_ID,
      principal: SPONSOR,
      localSeq: 1,
      id: USER_INPUT.id,
      scope: "user",
      value: 6,
    });
    seedWrite(engine, {
      sessionId: EXECUTOR_SESSION_ID,
      principal: SPONSOR,
      localSeq: 2,
      id: SPACE_INPUT.id,
      value: "shared",
    });
    const spaceSeq = Engine.serverSeq(engine);

    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, SESSION_CONTEXT_KEY);
    const applied = applyClaimed(engine, lease, claim, {
      operations: [sessionOutputOperation],
      confirmedReads: [
        {
          id: USER_INPUT.id,
          scope: "user",
          path: toDocumentPath(["value"]),
          seq: aliceSeq,
        },
        { id: SPACE_INPUT.id, path: toDocumentPath(["value"]), seq: spaceSeq },
      ],
      surfaces: {
        reads: [USER_INPUT, SPACE_INPUT, SESSION_INPUT],
        writes: [SESSION_OUTPUT],
      },
      nowMs: nowMs + 1,
    });
    assertExists(applied.schedulerObservationResults);
    const [result] = applied.schedulerObservationResults;
    assert(result.status === "kept");
    // The effective context stays the LANE's session (the chain-user read
    // does not broaden it), and the claim settles.
    assertEquals(result.executionContextKey, SESSION_CONTEXT_KEY);
    // The session output landed at the lane session's instance…
    assertEquals(
      Engine.read(engine, {
        id: SESSION_OUTPUT.id,
        scope: "session",
        principal: PRINCIPAL,
        sessionId: LANE_SESSION_ID,
      }),
      { value: 7 },
    );
    // …and the user input instances are untouched by the read.
    assertEquals(
      Engine.read(engine, {
        id: USER_INPUT.id,
        scope: "user",
        principal: PRINCIPAL,
        sessionId: LANE_SESSION_ID,
      }),
      { value: 5 },
    );
    assertEquals(
      Engine.read(engine, {
        id: USER_INPUT.id,
        scope: "user",
        principal: SPONSOR,
        sessionId: EXECUTOR_SESSION_ID,
      }),
      { value: 6 },
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

// --- (d) WRITES do not widen: a session lane writing (or merely declaring)
// a user-scoped address stays rejected exact-lane, on both commit shapes. ---

Deno.test("a session-claimed commit WRITING the lane principal's user-scoped address stays rejected", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, SESSION_CONTEXT_KEY);
    const before = Engine.serverSeq(engine);
    assertFirewallCode(
      () =>
        applyClaimed(engine, lease, claim, {
          operations: [
            sessionOutputOperation,
            {
              op: "set",
              id: USER_OUTPUT.id,
              scope: "user",
              value: { value: 8 },
            },
          ],
          surfaces: { writes: [SESSION_OUTPUT, USER_OUTPUT] },
          nowMs: nowMs + 1,
        }),
      "non-lane-scope",
    );
    assertEquals(Engine.serverSeq(engine), before);
    assertEquals(
      Engine.read(engine, {
        id: USER_OUTPUT.id,
        scope: "user",
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

Deno.test("a summary-DECLARED user write under a session claim rejects on the observation-only shape too", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    // No semantic operations: the write surface alone (summary +
    // actualChangedWrites) must reject — the write-side per-address checks
    // stay exact-lane even though the READ side admits the chain.
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, SESSION_CONTEXT_KEY);
    assertFirewallCode(
      () =>
        applyClaimed(engine, lease, claim, {
          surfaces: { writes: [SESSION_OUTPUT, USER_OUTPUT] },
          nowMs: nowMs + 1,
        }),
      "non-lane-scope",
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("entity-absent preconditions stay exact-lane under a session claim", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    // The precondition names a NEVER-written user doc, so the commit-level
    // absence check passes and the firewall's per-address precondition
    // check is the one that must reject: creation guards are write-shaped
    // and never widen with the read chain.
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, SESSION_CONTEXT_KEY);
    assertFirewallCode(
      () =>
        applyClaimed(engine, lease, claim, {
          operations: [sessionOutputOperation],
          preconditions: [{
            kind: "entity-absent",
            id: "of:session-chain-never-written",
            scope: "user",
          }],
          surfaces: { writes: [SESSION_OUTPUT] },
          nowMs: nowMs + 1,
        }),
      "non-lane-scope",
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

// --- The chain is one-directional: a USER lane never reads session-scoped
// state (narrower-in-chain never widens downward). ---

Deno.test("a user-claimed commit reading a session-scoped address still rejects", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, USER_CONTEXT_KEY);
    assertFirewallCode(
      () =>
        applyClaimed(engine, lease, claim, {
          operations: [{
            op: "set",
            id: USER_OUTPUT.id,
            scope: "user",
            value: { value: 9 },
          }],
          surfaces: {
            reads: [SESSION_INPUT],
            writes: [USER_OUTPUT],
          },
          nowMs: nowMs + 1,
        }),
      "non-lane-scope",
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

// --- Space lanes keep the pre-lane firewall byte-identically: a scoped
// read under a space claim stays rejected with the non-space cause. ---

Deno.test("a space-claimed commit reading a user-scoped address keeps the non-space rejection", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const claim = claimFor(
      lease,
      "space" as SchedulerExecutionContextKey,
    );
    assertFirewallCode(
      () =>
        applyClaimed(engine, lease, claim, {
          operations: [{
            op: "set",
            id: SPACE_INPUT.id,
            value: { value: "out" },
          }],
          surfaces: {
            reads: [USER_INPUT],
            writes: [address("space", SPACE_INPUT.id)],
          },
          nowMs: nowMs + 1,
        }),
      "non-space-scope",
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});
