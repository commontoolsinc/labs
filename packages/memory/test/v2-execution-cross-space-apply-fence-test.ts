// C3.8 — the home-apply authorization-epoch fence (the cross-space TOCTOU
// close), in-process transport only (C3A8).
//
// The fence re-validates every carried FOREIGN authorization epoch — C3.5's
// per-component read-time stamp — by EQUALITY against the CURRENT effective
// epoch, inside the accept transaction, BEFORE any row of a claimed attempt
// applies. A stale component settles the WHOLE attempt canonically unserved
// with the new fence-error-family cause `foreign-authorization-stale`, no
// partial apply; the client reruns fail-open.
//
// These fixtures follow the C1.10 injectable-fence discipline (see
// `v2-execution-acting-context-test.ts` "a commit racing the reconciliation
// fences lane-write-authority"): wire ordering CANNOT force the read-to-apply
// interleaving, so the fence's epoch resolver is injected directly at the
// engine seam (`ApplyCommitOptions.resolveForeignAuthorizationEpoch`), driving
// the exact TOCTOU the co-hosted medium can only approximate. Over the
// in-process transport the bump and the read sit on ONE ordered path, so the
// fence is EXACT — option (ii) with a zero-width residual window (the C3A7
// arm; see the engine docblock at `assertForeignAuthorizationEpochsCurrent`).
// The co-hosted arm (residual window / synchronous RPC) is C3.10b's; C3.11
// folds this fixture in over both transports.
//
// Fixture map (plan row C3.8):
//  (a) THE TOCTOU fixture — bump N→N+1 between the stamped read and the home
//      apply ⇒ the whole attempt is unserved, NO row applies, rerun fail-open.
//  (b) happy path — no bump ⇒ the attempt applies committed WITH its vector.
//  (c) multi-component — one of several foreign components stale ⇒ the WHOLE
//      attempt is unserved (whole-action, not partial).
//  (d) fail-closed — an unknown / evicted epoch at apply ⇒ stale.
//  (e) idle-vs-apply — the apply gate fires on a bump that landed AFTER the
//      read while the claim/lease/lane were all still LIVE (never idle-
//      revoked), the distinct §7 read-to-apply gate C3.7's idle gate cannot
//      cover; and the equality-is-load-bearing note (a monotone `>=` would
//      wrongly pass this stale-lower carried epoch).
//  (f) regression — a same-space attempt carries no foreign component, so the
//      fence is dormant and byte-identical (a resolver that would THROW is
//      never consulted); both the semantic-write and observation-only paths.
//  (g) observation-only served no-op — the SECOND apply locus
//      (`applySchedulerObservationOnlyCommit`) fences identically.
import { assert, assertEquals, assertExists, assertThrows } from "@std/assert";
import { toFileUrl } from "@std/path";
import {
  type ClientCommit,
  type ExecutionClaim,
  type ExecutionLease,
  type Operation,
  type ProvenanceInputBasisComponent,
  toInputBasisSeq,
} from "../v2.ts";
import * as Engine from "../v2/engine.ts";
import type {
  SchedulerActionObservation,
  SchedulerObservationAddress,
} from "../v2/engine.ts";

const HOME_SPACE = "did:key:z6Mk-xsp-apply-fence-home";
const READ_SPACE = "did:key:z6Mk-xsp-apply-fence-read";
const READ_SPACE_2 = "did:key:z6Mk-xsp-apply-fence-read-two";
const SPONSOR = "did:key:z6Mk-xsp-apply-fence-sponsor";

const PIECE_ID = "space:of:xsp-apply-fence-piece";
const ACTION_ID = "action:xsp-apply-fence";
const IMPL_FP = "impl:xsp-apply-fence";
const RUNTIME_FP = "runtime:xsp-apply-fence";

const FOREIGN_DOC = "of:xsp-apply-fence-source";
const FOREIGN_DOC_2 = "of:xsp-apply-fence-source-two";
const HOME_OUTPUT = "of:xsp-apply-fence-output";

const NOW = 1_800_000_000_000;

const openTempEngine = async (): Promise<{
  directory: string;
  engine: Engine.Engine;
}> => {
  const directory = await Deno.makeTempDir();
  const store = toFileUrl(`${directory}/space.sqlite`);
  return { directory, engine: await Engine.open({ url: store }) };
};

const acquire = (engine: Engine.Engine, nowMs: number): ExecutionLease => {
  const lease = Engine.acquireExecutionLease(engine, {
    space: HOME_SPACE,
    branch: "",
    hostId: "host:xsp-apply-fence",
    onBehalfOf: SPONSOR,
    nowMs,
    ttlMs: 60_000,
    authorizeWrite: () => true,
  });
  assertExists(lease);
  return lease;
};

/** A SPACE-rank claim: the acting principal is the sponsor, foreign reads are
 *  space-scoped (decision #3), and no lane machinery complicates the fence. */
const spaceClaim = (lease: ExecutionLease): ExecutionClaim => ({
  branch: "",
  space: HOME_SPACE,
  contextKey: "space",
  pieceId: PIECE_ID,
  actionId: ACTION_ID,
  actionKind: "computation",
  implementationFingerprint: IMPL_FP,
  runtimeFingerprint: RUNTIME_FP,
  leaseGeneration: lease.leaseGeneration,
  claimGeneration: 1,
  expiresAt: lease.expiresAt,
});

const homeAddress = (
  id: string,
  path: readonly string[] = ["value"],
): SchedulerObservationAddress => ({
  space: HOME_SPACE,
  scope: "space",
  id,
  path: [...path],
});

/** A space-scoped read address naming a FOREIGN space (the relaxed fourth
 *  reject site admits exactly this — C3.5). */
const foreignAddress = (
  space: string,
  id: string,
  path: readonly string[] = ["value"],
): SchedulerObservationAddress => ({
  space,
  scope: "space",
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
  ownerSpace: HOME_SPACE,
  branch: "",
  pieceId: claim.pieceId,
  processGeneration: 1,
  actionId: claim.actionId,
  actionKind: "computation",
  implementationFingerprint: IMPL_FP,
  runtimeFingerprint: RUNTIME_FP,
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
    implementationFingerprint: IMPL_FP,
    runtimeFingerprint: RUNTIME_FP,
    piece: {
      space: HOME_SPACE,
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

/** One host-validated foreign component carrying C3.5's read-time epoch
 *  stamp (the value C3.8 re-validates by equality). */
const foreignComponent = (
  space: string,
  seq: number,
  principal: string,
  epoch: number,
): ProvenanceInputBasisComponent => ({
  space,
  seq: toInputBasisSeq(seq),
  authorizationEpoch: { principal, epoch },
});

type ApplyOptions = {
  operations?: Operation[];
  surfaces?: {
    reads?: readonly SchedulerObservationAddress[];
    writes?: readonly SchedulerObservationAddress[];
  };
  nowMs: number;
  localSeq?: number;
  foreignInputBases?: ReadonlyMap<
    number,
    readonly ProvenanceInputBasisComponent[]
  >;
  resolveForeignAuthorizationEpoch?: (
    space: string,
    principal: string,
  ) => number | undefined;
};

const applyClaimed = (
  engine: Engine.Engine,
  lease: ExecutionLease,
  claim: ExecutionClaim,
  options: ApplyOptions,
): Engine.AppliedCommit => {
  const localSeq = options.localSeq ?? 1;
  const commit: ClientCommit = {
    localSeq,
    reads: { confirmed: [], pending: [] },
    operations: options.operations ?? [],
    schedulerObservation: observationFor(claim, options.surfaces ?? {}),
  };
  return Engine.applyCommit(engine, {
    sessionId: "executor-session",
    scopeSessionId: "executor-session",
    space: HOME_SPACE,
    principal: SPONSOR,
    commit,
    executionClaims: new Map([[localSeq, claim]]),
    executionLeaseFence: {
      lease,
      nowMs: options.nowMs,
      authorize: () => true,
    },
    ...(options.foreignInputBases !== undefined
      ? { foreignInputBases: options.foreignInputBases }
      : {}),
    ...(options.resolveForeignAuthorizationEpoch !== undefined
      ? {
        resolveForeignAuthorizationEpoch:
          options.resolveForeignAuthorizationEpoch,
      }
      : {}),
  });
};

const assertForeignAuthStale = (run: () => unknown): void => {
  const error = assertThrows(run, Engine.ExecutionLeaseFenceError);
  assertEquals(error.fenceCause, "foreign-authorization-stale", error.message);
};

const readForeignComponent = (
  applied: Engine.AppliedCommit,
): ProvenanceInputBasisComponent | undefined => {
  const provenance = applied.actionAttempts?.[0]?.provenance;
  return provenance?.inputBasis?.find((c) => c.space === READ_SPACE);
};

// (a) THE TOCTOU fixture. The foreign read stamped epoch 3; between that read
// and this home apply, B's ACL bumped to 4 (injected: the resolver reports the
// bumped table). The whole claimed attempt settles unserved
// `foreign-authorization-stale` — NO row applies (serverSeq unchanged, the home
// output absent), and the client reruns fail-open.
Deno.test("C3.8 (a): a bump between the stamped read and the home apply settles the whole attempt unserved, no row applies", async () => {
  const { directory, engine } = await openTempEngine();
  try {
    const lease = acquire(engine, NOW);
    const claim = spaceClaim(lease);
    const before = Engine.serverSeq(engine);
    const consulted: Array<[string, string]> = [];
    assertForeignAuthStale(() =>
      applyClaimed(engine, lease, claim, {
        operations: [{ op: "set", id: HOME_OUTPUT, value: { value: 42 } }],
        surfaces: {
          reads: [foreignAddress(READ_SPACE, FOREIGN_DOC)],
          writes: [homeAddress(HOME_OUTPUT)],
        },
        nowMs: NOW + 1,
        // Read-time stamp: epoch 3.
        foreignInputBases: new Map([
          [1, [foreignComponent(READ_SPACE, 5, SPONSOR, 3)]],
        ]),
        // Apply-time table: bumped to 4 (the ACL moved on).
        resolveForeignAuthorizationEpoch: (space, principal) => {
          consulted.push([space, principal]);
          return space === READ_SPACE && principal === SPONSOR ? 4 : undefined;
        },
      })
    );
    // The fence consulted exactly the stamped foreign (space, principal).
    assertEquals(consulted, [[READ_SPACE, SPONSOR]]);
    // No partial apply: no seq consumed, the home output never landed.
    assertEquals(Engine.serverSeq(engine), before);
    assertEquals(Engine.read(engine, { id: HOME_OUTPUT }), null);
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

// (b) The happy path. The authority is stable between read and apply (the
// resolver reports the SAME epoch the read stamped), so the attempt serves —
// committed WITH its vector basis (the C3.6 served path stays served).
Deno.test("C3.8 (b): a stable foreign epoch applies the claimed attempt with its vector", async () => {
  const { directory, engine } = await openTempEngine();
  try {
    const lease = acquire(engine, NOW);
    const claim = spaceClaim(lease);
    const before = Engine.serverSeq(engine);
    const applied = applyClaimed(engine, lease, claim, {
      operations: [{ op: "set", id: HOME_OUTPUT, value: { value: 42 } }],
      surfaces: {
        reads: [foreignAddress(READ_SPACE, FOREIGN_DOC)],
        writes: [homeAddress(HOME_OUTPUT)],
      },
      nowMs: NOW + 1,
      foreignInputBases: new Map([
        [1, [foreignComponent(READ_SPACE, 5, SPONSOR, 3)]],
      ]),
      // Unchanged since the read.
      resolveForeignAuthorizationEpoch: () => 3,
    });
    // Served committed, the home output landed, a seq consumed.
    assertEquals(applied.actionAttempts?.[0]?.outcome, "committed");
    assert(Engine.serverSeq(engine) > before);
    assertEquals(Engine.read(engine, { id: HOME_OUTPUT }), { value: 42 });
    // The vector carries the foreign component with the (validated) stamp.
    const component = readForeignComponent(applied);
    assertExists(component);
    assertEquals(component.seq, toInputBasisSeq(5));
    assertEquals(component.authorizationEpoch, { principal: SPONSOR, epoch: 3 });
    // The home component rides too (no epoch stamp — fenced by the lease).
    const home = applied.actionAttempts?.[0]?.provenance.inputBasis?.find((c) =>
      c.space === HOME_SPACE
    );
    assertExists(home);
    assertEquals(home.authorizationEpoch, undefined);
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

// (c) Multi-component: two foreign reads, one stale. The whole attempt is
// unserved — the whole-action rule (§B.2) admits no partial apply, so a single
// stale component discards the entire attempt even though the other is current.
Deno.test("C3.8 (c): one stale component among several settles the WHOLE attempt unserved (whole-action)", async () => {
  const { directory, engine } = await openTempEngine();
  try {
    const lease = acquire(engine, NOW);
    const claim = spaceClaim(lease);
    const before = Engine.serverSeq(engine);
    assertForeignAuthStale(() =>
      applyClaimed(engine, lease, claim, {
        operations: [{ op: "set", id: HOME_OUTPUT, value: { value: 42 } }],
        surfaces: {
          reads: [
            foreignAddress(READ_SPACE, FOREIGN_DOC),
            foreignAddress(READ_SPACE_2, FOREIGN_DOC_2),
          ],
          writes: [homeAddress(HOME_OUTPUT)],
        },
        nowMs: NOW + 1,
        foreignInputBases: new Map([[
          1,
          [
            foreignComponent(READ_SPACE, 5, SPONSOR, 3),
            foreignComponent(READ_SPACE_2, 9, SPONSOR, 7),
          ],
        ]]),
        // READ_SPACE current (3 == 3); READ_SPACE_2 bumped (7 -> 8).
        resolveForeignAuthorizationEpoch: (space) =>
          space === READ_SPACE ? 3 : space === READ_SPACE_2 ? 8 : undefined,
      })
    );
    assertEquals(Engine.serverSeq(engine), before);
    assertEquals(Engine.read(engine, { id: HOME_OUTPUT }), null);
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

// (d) Fail-closed: an epoch the host cannot resolve at all at apply time
// (cache eviction / host restart / a peer arm C3.10b hasn't wired yet) is
// STALE — undefined = unknown = fail closed (C3A3). Over-revoke, never under.
Deno.test("C3.8 (d): an unknown / evicted epoch at apply is stale (fail closed)", async () => {
  const { directory, engine } = await openTempEngine();
  try {
    const lease = acquire(engine, NOW);
    const claim = spaceClaim(lease);
    const before = Engine.serverSeq(engine);
    assertForeignAuthStale(() =>
      applyClaimed(engine, lease, claim, {
        operations: [{ op: "set", id: HOME_OUTPUT, value: { value: 42 } }],
        surfaces: {
          reads: [foreignAddress(READ_SPACE, FOREIGN_DOC)],
          writes: [homeAddress(HOME_OUTPUT)],
        },
        nowMs: NOW + 1,
        foreignInputBases: new Map([
          [1, [foreignComponent(READ_SPACE, 5, SPONSOR, 3)]],
        ]),
        // Cannot resolve the (space, principal) at all.
        resolveForeignAuthorizationEpoch: () => undefined,
      })
    );
    assertEquals(Engine.serverSeq(engine), before);
    assertEquals(Engine.read(engine, { id: HOME_OUTPUT }), null);
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

// (e) The idle-vs-apply distinction and the equality proof. C3.7 covers the
// bump that arrives WHILE THE CLAIM IS IDLE; C3.8 covers the bump that lands in
// the read-to-apply window with the claim NEVER idle. Here the lease is live,
// the fence's own lease `authorize` passes, and the claim is exactly the one
// bound — every liveness gate is green — yet the apply fence still fires
// because the foreign epoch moved (3 -> 4) after the read stamped it. This is
// the distinct §7 read-to-apply gate (C3A7/§7): a monotone `>=` check ("current
// is at least as new as the stamp": 4 >= 3) would WRONGLY pass this
// stale-lower carried epoch — equality is load-bearing.
Deno.test("C3.8 (e): the apply fence fires on a read-to-apply bump while the claim is still live (not idle-revoked)", async () => {
  const { directory, engine } = await openTempEngine();
  try {
    const lease = acquire(engine, NOW);
    const claim = spaceClaim(lease);
    const before = Engine.serverSeq(engine);
    let leaseAuthorizeConsulted = false;
    assertForeignAuthStale(() =>
      Engine.applyCommit(engine, {
        sessionId: "executor-session",
        scopeSessionId: "executor-session",
        space: HOME_SPACE,
        principal: SPONSOR,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{ op: "set", id: HOME_OUTPUT, value: { value: 42 } }],
          schedulerObservation: observationFor(claim, {
            reads: [foreignAddress(READ_SPACE, FOREIGN_DOC)],
            writes: [homeAddress(HOME_OUTPUT)],
          }),
        },
        executionClaims: new Map([[1, claim]]),
        executionLeaseFence: {
          lease,
          nowMs: NOW + 1,
          // The claim/lease are live: the sponsor authority passes. The ONLY
          // gate that stops this commit is the foreign-epoch fence.
          authorize: () => {
            leaseAuthorizeConsulted = true;
            return true;
          },
        },
        foreignInputBases: new Map([
          [1, [foreignComponent(READ_SPACE, 5, SPONSOR, 3)]],
        ]),
        // The bump landed after the read (3 -> 4); a monotone 4 >= 3 would
        // wrongly pass — the fence uses equality.
        resolveForeignAuthorizationEpoch: () => 4,
      })
    );
    // The lease authority was consulted and PASSED — the attempt was fenced
    // strictly by C3.8, not by any claim/lease liveness gate.
    assert(leaseAuthorizeConsulted);
    assertEquals(Engine.serverSeq(engine), before);
    assertEquals(Engine.read(engine, { id: HOME_OUTPUT }), null);
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

// (f) Regression: a same-space attempt carries no foreign components, so the
// fence is dormant and byte-identical to pre-C3.8. A resolver that would THROW
// if consulted proves the fence never runs. Both the semantic-write path and
// the observation-only (no-op) path.
Deno.test("C3.8 (f): a same-space attempt is dormant — the fence resolver is never consulted", async () => {
  const { directory, engine } = await openTempEngine();
  try {
    const lease = acquire(engine, NOW);
    const claim = spaceClaim(lease);
    const trap = (): number => {
      throw new Error("the fence must not consult the resolver for a " +
        "same-space attempt");
    };
    // Semantic-write path: no foreignInputBases at all.
    const written = applyClaimed(engine, lease, claim, {
      operations: [{ op: "set", id: HOME_OUTPUT, value: { value: 7 } }],
      surfaces: { writes: [homeAddress(HOME_OUTPUT)] },
      nowMs: NOW + 1,
      resolveForeignAuthorizationEpoch: trap,
    });
    assertEquals(written.actionAttempts?.[0]?.outcome, "committed");
    assertEquals(Engine.read(engine, { id: HOME_OUTPUT }), { value: 7 });
    // No inputBasis anywhere (scalar-only, byte-identical).
    assertEquals(written.actionAttempts?.[0]?.provenance.inputBasis, undefined);

    // Observation-only (no-op) path: still dormant.
    const noop = applyClaimed(engine, lease, claim, {
      surfaces: { reads: [homeAddress("of:xsp-apply-fence-home-input")] },
      nowMs: NOW + 2,
      localSeq: 2,
      resolveForeignAuthorizationEpoch: trap,
    });
    assertEquals(noop.actionAttempts?.[0]?.outcome, "no-op");
    assertEquals(noop.actionAttempts?.[0]?.provenance.inputBasis, undefined);
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

// (g) The SECOND apply locus: a served observation-only attempt (a no-op that
// consumed a foreign read) fences identically in
// `applySchedulerObservationOnlyCommit`. Stale ⇒ unserved, no observation row;
// stable ⇒ the no-op settles with its vector.
Deno.test("C3.8 (g): the observation-only apply path fences a stale foreign epoch and serves a stable one", async () => {
  const { directory, engine } = await openTempEngine();
  try {
    const lease = acquire(engine, NOW);
    const claim = spaceClaim(lease);
    const before = Engine.serverSeq(engine);
    // Stale ⇒ the whole no-op attempt is unserved, no row upserted.
    assertForeignAuthStale(() =>
      applyClaimed(engine, lease, claim, {
        surfaces: { reads: [foreignAddress(READ_SPACE, FOREIGN_DOC)] },
        nowMs: NOW + 1,
        foreignInputBases: new Map([
          [1, [foreignComponent(READ_SPACE, 5, SPONSOR, 3)]],
        ]),
        resolveForeignAuthorizationEpoch: () => 4,
      })
    );
    assertEquals(Engine.serverSeq(engine), before);

    // Stable ⇒ the no-op serves with its vector.
    const served = applyClaimed(engine, lease, claim, {
      surfaces: { reads: [foreignAddress(READ_SPACE, FOREIGN_DOC)] },
      nowMs: NOW + 2,
      localSeq: 2,
      foreignInputBases: new Map([
        [2, [foreignComponent(READ_SPACE, 5, SPONSOR, 3)]],
      ]),
      resolveForeignAuthorizationEpoch: () => 3,
    });
    assertEquals(served.actionAttempts?.[0]?.outcome, "no-op");
    const component = readForeignComponent(served);
    assertExists(component);
    assertEquals(component.authorizationEpoch, { principal: SPONSOR, epoch: 3 });
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});
