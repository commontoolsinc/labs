// C3.5 — the vector input basis + the engine-side read relax (blocker
// C3A2 rides here; amendments C3A13/C3A14/C3A15/C3A16).
//
// Fixture map (plan row C3.5):
//  (u) unit: `mergeInputBasisVectors` is the C3A15 vacuous union (absent
//      rides through, per-component max, sorted, both-undefined stays
//      undefined); `actionSettlementFromFrontier` carries the vector in
//      both arms (C3A14); `inputBasisComponentForSpace` lookup.
//  (a) engine-level served-with-vector: a hand-built claimed commit whose
//      space-scoped foreign read is backed by a host-served stamped point
//      read PASSES the relaxed fourth reject site and settles committed
//      with {home scalar ≡ home component, B component = the stamped
//      seq}; provenance carries the per-component authorization-epoch
//      stamp equal to the served outcome's (C3.8's consumption seam);
//      a Worker-forged provenance vector on the wire observation is
//      ignored. Discrimination: un-relaxing `assertLaneScopedAddress`
//      reds this fixture.
//  (b) strips: an asserted stamp the host NEVER served (fabricated seq)
//      is dropped — the settlement is scalar-only and the strip counter
//      increments; a stamp for a doc served at a DIFFERENT seq likewise.
//      Discrimination: passing asserted stamps through without the
//      host-record validation reds this fixture.
//  (c) C3A13 leg: a validated stamp whose space the commit declares NO
//      read for is dropped by the ENGINE's declared-read restriction
//      (the settlement is scalar-only). (The peer-impersonation leg — a
//      stamp from a non-authoritative link — is pinned at the pending
//      map by the C3.4 point-read suite; the ledger only records past
//      that gate.)
//  (m) regression matrix (C3A2): under a live claim, observation-side
//      foreign WRITES still reject `foreign-space-surface`
//      byte-identically; user- and session-scoped foreign READS still
//      reject `foreign-space-surface` (decision #3); a wire observation
//      naming the reserved top-level `inputBasis` is malformed; a
//      CLIENT observation with a foreign read keeps flooring at the
//      committing session's context (the floor relax is
//      provenance-gated). Preconditions carry no space field — there is
//      no foreign-precondition case to relax or regress.
//  (e) scalar-only byte-identity: a claimed attempt with no foreign
//      reads settles WITHOUT the `inputBasis` field anywhere (event,
//      provenance, frontier).
//  (v) publishActionSettlement validation: vector coherence (home
//      component present and ≡ scalar, no duplicate spaces, positive
//      foreign seqs) — incoherent vectors refuse to publish.
//  (h+g) the composed wake → read → serve loop at the memory level
//      (C3.4's flagged e2e, now assertable): B commits → the demanded
//      home action's foreign wake fires → a fresh stamped point read
//      lands → the rerun's claimed commit serves WITH the vector; and
//      the C3A16 red-green leg on the SAME harness: a B-space cause row
//      newer than the attempt's B component survives the provenance-
//      carrying mirror upsert even though the HOME scalar is numerically
//      larger (inheriting the home scalar — the pre-C3.5 behavior —
//      consumes it), while causes at-or-below the B component are
//      consumed.
//
// Barrier-driven throughout: every await is a transact response, a host
// API result, the server's cross-space settle barriers, or a bounded
// microtask spin on synchronous state — no sleeps.
import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import * as MemoryClient from "../v2/client.ts";
import * as Engine from "../v2/engine.ts";
import { Server } from "../v2/server.ts";
import type { ForeignWakeEvent } from "../v2/server.ts";
import type {
  SchedulerActionObservation,
  SchedulerExecutionContextKey,
  SchedulerObservationAddress,
} from "../v2/engine.ts";
import {
  type ActionSettlement,
  actionSettlementFromFrontier,
  type ExecutionClaim,
  type ExecutionSettlementFrontier,
  type InputBasisComponent,
  inputBasisComponentForSpace,
  mergeInputBasisVectors,
  toAcceptedCommitSeq,
  toDocumentPath,
  toInputBasisSeq,
} from "../v2.ts";

const HOME_SPACE = "did:key:z6Mk-xsp-vector-home";
const READ_SPACE = "did:key:z6Mk-xsp-vector-read";
const ADMIN = "did:key:z6Mk-xsp-vector-admin";
const SPONSOR = "did:key:z6Mk-xsp-vector-sponsor";
const OTHER = "did:key:z6Mk-xsp-vector-writer";
const AUDIENCE = "did:key:z6Mk-xsp-vector-audience";

const PIECE_ROOT = "of:xsp-vector:piece";
const SCHEDULER_PIECE_ID = `space:${PIECE_ROOT}`;
const ACTION_ID = "action:xsp-vector-reader";
const FOREIGN_DOC = "of:xsp-vector:source";
const HOME_SOURCE = "of:xsp-vector:home-source";
const HOME_OUTPUT = "of:xsp-vector:output";

type ExecutionSession = MemoryClient.SpaceSession & {
  setExecutionDemand(
    branch: string,
    pieces: readonly string[],
  ): Promise<boolean>;
  subscribeExecutionControl(
    listener: (event: {
      type: string;
      settlement?: ActionSettlement;
    }) => void,
  ): () => void;
  noteAppliedCommit(seq: number): void;
  listSchedulerActionSnapshots(query: {
    pieceId?: string;
    actionId?: string;
    processGeneration?: number;
  }): Promise<{
    snapshots: {
      executionContextKey: SchedulerExecutionContextKey;
      observation: SchedulerActionObservation;
    }[];
  }>;
};

type ExecutionLeaseHandle = { leaseGeneration: number };

type HostClaim = {
  contextKey: SchedulerExecutionContextKey;
  pieceId: string;
  actionId: string;
  actionKind: "computation";
  implementationFingerprint: string;
  runtimeFingerprint: string;
  leaseGeneration: number;
  claimGeneration: number;
};

type LiveClaim = ExecutionClaim;

type VectorServer = Server & {
  acquireExecutionLease(
    space: string,
    branch: string,
  ): Promise<ExecutionLeaseHandle | null>;
  setExecutionClaim(
    lease: ExecutionLeaseHandle,
    claim: {
      branch: string;
      space: string;
      contextKey: SchedulerExecutionContextKey;
      pieceId: string;
      actionId: string;
      actionKind: "computation";
      implementationFingerprint: string;
      runtimeFingerprint: string;
    },
  ): Promise<LiveClaim>;
  bindExecutionSession(
    space: string,
    sessionId: string,
    lease: ExecutionLeaseHandle,
  ): () => void;
  publishActionSettlement(settlement: ActionSettlement): boolean;
  executorForeignPointRead(
    lease: ExecutionLeaseHandle,
    request: {
      readSpace: string;
      claim: HostClaim;
      address: { id: string; scope?: "space" | "user" | "session" };
    },
  ): Promise<
    | {
      status: "served";
      space: string;
      seq: number;
      branch: string;
      document: unknown;
      authorizationEpoch: { space: string; principal: string; epoch: number };
    }
    | { status: "denied" | "failed"; code: string }
  >;
  subscribeForeignWakes(
    space: string,
    listener: (event: ForeignWakeEvent) => void,
  ): () => void;
  executionStats: {
    foreignBasisAssertionsStripped: number;
    foreignBasisComponentsValidated: number;
  };
};

type ServerInternals = {
  settleCrossSpaceDeliveries(): Promise<void>;
  settleForeignReaderSubscriptions(): Promise<void>;
  runPendingPostCommitSchedulerSideEffects?: () => Promise<void>;
  openEngine(space: string): Promise<Engine.Engine>;
};

const internalsOf = (server: Server): ServerInternals =>
  server as unknown as ServerInternals;

const EXECUTION_FLAGS = {
  serverPrimaryExecutionV1: true,
  serverPrimaryExecutionClaimRoutingV1: true,
  serverPrimaryExecutionBuiltinPassivityV1: true,
  serverPrimaryExecutionContextLatticeClaimsV1: true,
};

const createServer = (name: string): VectorServer =>
  new Server(
    {
      store: new URL(`memory://${name}`),
      authorizeSessionOpen: (message: { authorization?: unknown }) => {
        const principal = (message.authorization as { principal?: unknown })
          ?.principal;
        return typeof principal === "string" ? principal : undefined;
      },
      sessionOpenAuth: { audience: AUDIENCE },
      protocolFlags: EXECUTION_FLAGS,
      acl: { mode: "enforce", serviceDids: [ADMIN] },
    } as unknown as ConstructorParameters<typeof Server>[0],
  ) as VectorServer;

const connectClient = async (
  server: Server,
): Promise<MemoryClient.Client> =>
  await MemoryClient.connect({
    transport: MemoryClient.loopback(server),
    protocolFlags: EXECUTION_FLAGS,
  } as MemoryClient.ConnectOptions);

const mountAs = async (
  client: MemoryClient.Client,
  space: string,
  principal: string,
): Promise<ExecutionSession> =>
  await client.mount(space, {}, (_space, _session, context) => ({
    invocation: {
      aud: context.audience,
      challenge: context.challenge.value,
    },
    authorization: { principal },
  })) as ExecutionSession;

const writeAcl = async (
  session: ExecutionSession,
  localSeq: number,
  space: string,
  acl: Record<string, "READ" | "WRITE" | "OWNER">,
): Promise<void> => {
  await session.transact({
    localSeq,
    reads: { confirmed: [], pending: [] },
    operations: [{ op: "set", id: `of:${space}`, value: { value: acl } }],
  });
};

const claimInput = (actionId = ACTION_ID) => ({
  branch: "",
  space: HOME_SPACE,
  contextKey: "space" as SchedulerExecutionContextKey,
  pieceId: SCHEDULER_PIECE_ID,
  actionId,
  actionKind: "computation" as const,
  implementationFingerprint: "impl:xsp-vector",
  runtimeFingerprint: "runtime:xsp-vector",
});

const claimRefOf = (claim: LiveClaim): HostClaim => ({
  contextKey: claim.contextKey,
  pieceId: claim.pieceId,
  actionId: claim.actionId,
  actionKind: "computation",
  implementationFingerprint: claim.implementationFingerprint,
  runtimeFingerprint: claim.runtimeFingerprint,
  leaseGeneration: claim.leaseGeneration,
  claimGeneration: claim.claimGeneration,
});

const homeAddress = (
  id: string,
  path: readonly string[] = ["value"],
  scope: "space" | "user" | "session" = "space",
): SchedulerObservationAddress => ({
  space: HOME_SPACE,
  scope,
  id,
  path: [...path],
});

const foreignAddress = (
  id: string = FOREIGN_DOC,
  scope: "space" | "user" | "session" = "space",
): SchedulerObservationAddress => ({
  space: READ_SPACE,
  scope,
  id,
  path: ["value"],
});

/**
 * A version-2 claimed observation for the space lane: reads HOME_SOURCE
 * plus the given foreign reads, writes HOME_OUTPUT. `processGeneration`
 * is parameterized: the executor's claimed generation must not collide
 * with client-observation floor rows (the context floor keys by it).
 */
const claimedObservation = (
  claim: LiveClaim,
  options: {
    foreignReads?: readonly SchedulerObservationAddress[];
    foreignReadStamps?: readonly { space: string; id: string; seq: number }[];
    processGeneration?: number;
    forgedProvenanceVector?: boolean;
  } = {},
): SchedulerActionObservation => {
  const reads = [
    homeAddress(HOME_SOURCE),
    ...(options.foreignReads ?? []),
  ];
  return {
    version: 2,
    ownerSpace: HOME_SPACE,
    branch: "",
    pieceId: claim.pieceId,
    processGeneration: options.processGeneration ?? 1,
    actionId: claim.actionId,
    actionKind: "computation",
    implementationFingerprint: claim.implementationFingerprint,
    runtimeFingerprint: claim.runtimeFingerprint,
    executionClaimAssertion: {
      contextKey: claim.contextKey,
      leaseGeneration: claim.leaseGeneration,
      claimGeneration: claim.claimGeneration,
    },
    ...(options.foreignReadStamps !== undefined
      ? { foreignReadStamps: options.foreignReadStamps }
      : {}),
    ...(options.forgedProvenanceVector === true
      ? {
        executionProvenance: {
          claim: {
            branch: "",
            space: HOME_SPACE,
            contextKey: "space",
            pieceId: claim.pieceId,
            actionId: claim.actionId,
            actionKind: "computation",
            implementationFingerprint: claim.implementationFingerprint,
            runtimeFingerprint: claim.runtimeFingerprint,
          },
          onBehalfOf: "did:key:forged",
          leaseGeneration: 999,
          claimGeneration: 999,
          causedBy: [],
          inputBasisSeq: toInputBasisSeq(999_999),
          inputBasis: [
            { space: HOME_SPACE, seq: toInputBasisSeq(999_999) },
            { space: READ_SPACE, seq: toInputBasisSeq(999_999) },
          ],
        },
      }
      : {}),
    completeActionScopeSummary: {
      version: 1,
      complete: true,
      implementationFingerprint: claim.implementationFingerprint,
      runtimeFingerprint: claim.runtimeFingerprint,
      piece: { space: HOME_SPACE, scope: "space", id: PIECE_ROOT, path: [] },
      reads: [...reads],
      writes: [homeAddress(HOME_OUTPUT)],
      materializerWriteEnvelopes: [],
      directOutputs: [homeAddress(HOME_OUTPUT)],
    },
    observedAtSeq: 0,
    transactionKind: "action-run",
    reads: [...reads],
    shallowReads: [],
    actualChangedWrites: [homeAddress(HOME_OUTPUT)],
    currentKnownWrites: [homeAddress(HOME_OUTPUT)],
    declaredWrites: [homeAddress(HOME_OUTPUT)],
    materializerWriteEnvelopes: [],
    status: "success",
  };
};

interface Harness {
  server: VectorServer;
  internals: ServerInternals;
  adminClient: MemoryClient.Client;
  sponsorClient: MemoryClient.Client;
  otherClient: MemoryClient.Client;
  sponsor: ExecutionSession;
  reader: ExecutionSession;
  lease: ExecutionLeaseHandle;
  claim: LiveClaim;
  settlements: ActionSettlement[];
  /** Home seq of the seeded HOME_SOURCE write (the scalar basis). */
  homeSourceSeq: number;
  unbind: () => void;
  close(): Promise<void>;
}

/**
 * Enforcing-ACL two-space harness: HOME (sponsor WRITE) and READ_SPACE
 * (sponsor READ, OTHER WRITE — the seeded foreign doc), plus the executor
 * plane on HOME: demand → lease → bound sponsor session → live space-lane
 * claim, with the sponsor session subscribed to execution control.
 */
const setupHarness = async (name: string): Promise<Harness> => {
  const server = createServer(name);
  const internals = internalsOf(server);
  const adminClient = await connectClient(server);
  const sponsorClient = await connectClient(server);
  const otherClient = await connectClient(server);
  const adminHome = await mountAs(adminClient, HOME_SPACE, ADMIN);
  const adminRead = await mountAs(adminClient, READ_SPACE, ADMIN);
  await writeAcl(adminHome, 1, HOME_SPACE, {
    [ADMIN]: "OWNER",
    [SPONSOR]: "WRITE",
  });
  await writeAcl(adminRead, 2, READ_SPACE, {
    [ADMIN]: "OWNER",
    [SPONSOR]: "READ",
    [OTHER]: "WRITE",
  });
  const sponsor = await mountAs(sponsorClient, HOME_SPACE, SPONSOR);
  const reader = await mountAs(otherClient, READ_SPACE, OTHER);
  await reader.transact({
    localSeq: 1,
    reads: { confirmed: [], pending: [] },
    operations: [{ op: "set", id: FOREIGN_DOC, value: { value: 41 } }],
  });
  const seeded = await sponsor.transact({
    localSeq: 1,
    reads: { confirmed: [], pending: [] },
    operations: [{ op: "set", id: HOME_SOURCE, value: { value: 7 } }],
  });
  const settlements: ActionSettlement[] = [];
  sponsor.subscribeExecutionControl((event) => {
    if (event.type === "session.execution.settlement") {
      settlements.push(event.settlement as ActionSettlement);
    }
  });
  await sponsor.setExecutionDemand("", [PIECE_ROOT]);
  const lease = await server.acquireExecutionLease(HOME_SPACE, "");
  assertExists(lease, "sponsor lease");
  const unbind = server.bindExecutionSession(
    HOME_SPACE,
    sponsor.sessionId,
    lease,
  );
  const claim = await server.setExecutionClaim(lease, claimInput());
  return {
    server,
    internals,
    adminClient,
    sponsorClient,
    otherClient,
    sponsor,
    reader,
    lease,
    claim,
    settlements,
    homeSourceSeq: seeded.seq,
    unbind,
    close: async () => {
      unbind();
      await otherClient.close();
      await sponsorClient.close();
      await adminClient.close();
      await server.close();
    },
  };
};

/** Bounded microtask spin (no timers). */
const spinUntil = async (
  predicate: () => boolean,
  what: string,
): Promise<void> => {
  for (let i = 0; i < 10_000; i++) {
    if (predicate()) return;
    await undefined;
  }
  throw new Error(`spinUntil gave up: ${what}`);
};

const confirmedHomeSourceRead = (seq: number) => ({
  id: HOME_SOURCE,
  path: toDocumentPath(["value"]),
  seq,
});

// ---------------------------------------------------------------------------
// (u) unit: the shared vector helpers.
// ---------------------------------------------------------------------------

Deno.test("C3.5 (u): mergeInputBasisVectors is the C3A15 vacuous union", () => {
  const b5: InputBasisComponent = {
    space: "did:b",
    seq: toInputBasisSeq(5),
  };
  const b9: InputBasisComponent = {
    space: "did:b",
    seq: toInputBasisSeq(9),
  };
  const c2: InputBasisComponent = {
    space: "did:c",
    seq: toInputBasisSeq(2),
  };
  // Both undefined stays undefined — scalar-only merges byte-identical.
  assertEquals(mergeInputBasisVectors(undefined, undefined), undefined);
  // One-sided vectors ride through unchanged (absent is never zero).
  assertEquals(mergeInputBasisVectors([b5], undefined), [b5]);
  assertEquals(mergeInputBasisVectors(undefined, [b5]), [b5]);
  // Union + per-component max: a component missing on one side survives
  // from the other; a present-but-older component never wins.
  assertEquals(mergeInputBasisVectors([b5], [b9, c2]), [b9, c2]);
  assertEquals(mergeInputBasisVectors([b9, c2], [b5]), [b9, c2]);
  // Deterministic order: sorted by space.
  assertEquals(mergeInputBasisVectors([c2], [b5]), [b5, c2]);
  // Component lookup: present vs the C3A15-vacuous absent.
  assertEquals(inputBasisComponentForSpace([b5, c2], "did:c"), c2);
  assertEquals(inputBasisComponentForSpace([b5], "did:x"), undefined);
  assertEquals(inputBasisComponentForSpace(undefined, "did:b"), undefined);
});

Deno.test("C3.5 (u): actionSettlementFromFrontier carries the vector in both arms (C3A14)", () => {
  const claim = {
    ...claimInput(),
    leaseGeneration: 1,
    claimGeneration: 1,
    expiresAt: 9_999_999,
  } as unknown as ActionSettlement["claim"];
  const inputBasis: InputBasisComponent[] = [
    { space: HOME_SPACE, seq: toInputBasisSeq(4) },
    { space: READ_SPACE, seq: toInputBasisSeq(9) },
  ];
  const base: Omit<ExecutionSettlementFrontier, "requiredAcceptedCommitSeq"> = {
    branch: "",
    claim,
    inputBasisSeq: toInputBasisSeq(4),
    inputBasis,
    throughFeedSeq: 12,
  };
  assertEquals(actionSettlementFromFrontier(base), {
    branch: "",
    claim,
    inputBasisSeq: toInputBasisSeq(4),
    inputBasis,
    outcome: "no-op",
  });
  assertEquals(
    actionSettlementFromFrontier({
      ...base,
      requiredAcceptedCommitSeq: toAcceptedCommitSeq(6),
    }),
    {
      branch: "",
      claim,
      inputBasisSeq: toInputBasisSeq(4),
      inputBasis,
      outcome: "committed",
      acceptedCommitSeq: toAcceptedCommitSeq(6),
    },
  );
  // Scalar-only frontier reconstructs byte-identically to pre-C3.5 —
  // no inputBasis field appears.
  const scalarOnly = actionSettlementFromFrontier({
    branch: "",
    claim,
    inputBasisSeq: toInputBasisSeq(4),
    throughFeedSeq: 12,
  });
  assertEquals("inputBasis" in scalarOnly, false);
});

// ---------------------------------------------------------------------------
// (a) engine-level served-with-vector + (b)/(c) strips + (m) matrix + (e).
// ---------------------------------------------------------------------------

Deno.test("C3.5 (a): a mount-covered claimed foreign read passes the relaxed firewall and settles with the vector", async () => {
  const harness = await setupHarness("xsp-vector-served");
  const {
    server,
    internals,
    sponsor,
    lease,
    claim,
    settlements,
    homeSourceSeq,
  } = harness;
  try {
    const outcome = await server.executorForeignPointRead(lease, {
      readSpace: READ_SPACE,
      claim: claimRefOf(claim),
      address: { id: FOREIGN_DOC },
    });
    assert(outcome.status === "served", "point read served");
    assertEquals(outcome.space, READ_SPACE);

    const committed = await sponsor.transact({
      localSeq: 2,
      reads: {
        confirmed: [confirmedHomeSourceRead(homeSourceSeq)],
        pending: [],
      },
      operations: [{ op: "set", id: HOME_OUTPUT, value: { value: 42 } }],
      schedulerObservation: claimedObservation(claim, {
        foreignReads: [foreignAddress()],
        foreignReadStamps: [
          { space: READ_SPACE, id: FOREIGN_DOC, seq: outcome.seq },
        ],
        // A forged wire provenance (with a forged vector) must be
        // stripped — the host authors canonically.
        forgedProvenanceVector: true,
      }),
    });

    const expectedVector = [
      { space: HOME_SPACE, seq: homeSourceSeq },
      { space: READ_SPACE, seq: outcome.seq },
    ];
    // The transact response's provenance: home component ≡ scalar (equal
    // by construction), the B component the served stamp, and the
    // per-component epoch stamp equal to the served outcome's (C3.8's
    // consumption seam).
    const result = committed.schedulerObservationResults?.[0];
    assertExists(result);
    assertEquals(result.inputBasisSeq, toInputBasisSeq(homeSourceSeq));
    assertEquals(
      result.executionProvenance?.inputBasisSeq,
      toInputBasisSeq(homeSourceSeq),
    );
    assertEquals(result.executionProvenance?.inputBasis, [
      { space: HOME_SPACE, seq: toInputBasisSeq(homeSourceSeq) },
      {
        space: READ_SPACE,
        seq: toInputBasisSeq(outcome.seq),
        authorizationEpoch: {
          principal: outcome.authorizationEpoch.principal,
          epoch: outcome.authorizationEpoch.epoch,
        },
      },
    ]);
    assertEquals(result.executionProvenance?.onBehalfOf, SPONSOR);
    assertEquals(outcome.authorizationEpoch.principal, SPONSOR);

    // The settlement event carries the {space, seq} projection — no epoch
    // stamps on the client-visible settlement.
    sponsor.noteAppliedCommit(committed.seq);
    await server.flushSessions();
    await spinUntil(() => settlements.length === 1, "committed settlement");
    assertEquals(settlements[0], {
      branch: "",
      claim: {
        ...claimInput(),
        leaseGeneration: claim.leaseGeneration,
        claimGeneration: claim.claimGeneration,
        expiresAt: claim.expiresAt,
      } as unknown as ActionSettlement["claim"],
      inputBasisSeq: toInputBasisSeq(homeSourceSeq),
      inputBasis: expectedVector.map((component) => ({
        space: component.space,
        seq: toInputBasisSeq(component.seq),
      })),
      outcome: "committed",
      acceptedCommitSeq: toAcceptedCommitSeq(committed.seq),
    } as ActionSettlement);

    // The persisted snapshot's provenance carries the vector (with the
    // epoch stamp) under the SPACE context — the provenance-gated floor
    // did not demote the claimed attempt.
    const snapshots = await sponsor.listSchedulerActionSnapshots({
      pieceId: claim.pieceId,
      actionId: claim.actionId,
      processGeneration: 1,
    });
    assertEquals(snapshots.snapshots.length, 1);
    assertEquals(snapshots.snapshots[0].executionContextKey, "space");
    const storedObservation = snapshots.snapshots[0]
      .observation as unknown as SchedulerActionObservation;
    assertEquals(storedObservation.executionProvenance?.inputBasis?.length, 2);
    // The transient stamp assertion never persists.
    assertEquals("foreignReadStamps" in storedObservation, false);
    await internals.settleCrossSpaceDeliveries();
  } finally {
    await harness.close();
  }
});

Deno.test("C3.5 (b): a Worker-asserted stamp the host never served is stripped (scalar-only settlement)", async () => {
  const harness = await setupHarness("xsp-vector-strip");
  const {
    server,
    sponsor,
    lease,
    claim,
    settlements,
    homeSourceSeq,
  } = harness;
  try {
    // Serve ONE stamp so the ledger exists for this claim — then assert a
    // DIFFERENT seq (never served) and a doc never read at all.
    const outcome = await server.executorForeignPointRead(lease, {
      readSpace: READ_SPACE,
      claim: claimRefOf(claim),
      address: { id: FOREIGN_DOC },
    });
    assert(outcome.status === "served");
    const strippedBefore = server.executionStats.foreignBasisAssertionsStripped;

    const committed = await sponsor.transact({
      localSeq: 2,
      reads: {
        confirmed: [confirmedHomeSourceRead(homeSourceSeq)],
        pending: [],
      },
      operations: [{ op: "set", id: HOME_OUTPUT, value: { value: 1 } }],
      schedulerObservation: claimedObservation(claim, {
        foreignReads: [foreignAddress()],
        foreignReadStamps: [
          // Fabricated seq for a genuinely-served doc.
          { space: READ_SPACE, id: FOREIGN_DOC, seq: outcome.seq + 500 },
          // A doc the host never served at all.
          { space: READ_SPACE, id: "of:never-read", seq: 1 },
        ],
      }),
    });
    assertEquals(
      server.executionStats.foreignBasisAssertionsStripped,
      strippedBefore + 2,
    );
    const result = committed.schedulerObservationResults?.[0];
    assertExists(result);
    // The attempt still settles — scalar-only (C3A15: absent component,
    // vacuous coverage), never a fabricated basis.
    assertEquals(result.executionProvenance?.inputBasisSeq, homeSourceSeq);
    assertEquals("inputBasis" in result.executionProvenance!, false);
    sponsor.noteAppliedCommit(committed.seq);
    await server.flushSessions();
    await spinUntil(() => settlements.length === 1, "settlement");
    assertEquals("inputBasis" in settlements[0], false);
  } finally {
    await harness.close();
  }
});

Deno.test("C3.5 (c): a validated stamp for a space the commit declares no read for is dropped by the engine", async () => {
  const harness = await setupHarness("xsp-vector-undeclared");
  const { server, sponsor, lease, claim, homeSourceSeq } = harness;
  try {
    const outcome = await server.executorForeignPointRead(lease, {
      readSpace: READ_SPACE,
      claim: claimRefOf(claim),
      address: { id: FOREIGN_DOC },
    });
    assert(outcome.status === "served");

    // The observation declares NO foreign reads; the asserted stamp is a
    // genuinely-served one. Host validation admits it — the ENGINE's
    // declared-read restriction drops it.
    const committed = await sponsor.transact({
      localSeq: 2,
      reads: {
        confirmed: [confirmedHomeSourceRead(homeSourceSeq)],
        pending: [],
      },
      operations: [{ op: "set", id: HOME_OUTPUT, value: { value: 2 } }],
      schedulerObservation: claimedObservation(claim, {
        foreignReadStamps: [
          { space: READ_SPACE, id: FOREIGN_DOC, seq: outcome.seq },
        ],
      }),
    });
    const result = committed.schedulerObservationResults?.[0];
    assertExists(result?.executionProvenance);
    assertEquals("inputBasis" in result.executionProvenance, false);
  } finally {
    await harness.close();
  }
});

Deno.test("C3.5 (m): the write/scoped-read/reserved-field regression matrix stays byte-identical", async () => {
  const harness = await setupHarness("xsp-vector-matrix");
  const { server, sponsor, claim, homeSourceSeq } = harness;
  try {
    const transactClaimed = (
      localSeq: number,
      observation: SchedulerActionObservation,
    ) =>
      sponsor.transact({
        localSeq,
        reads: {
          confirmed: [confirmedHomeSourceRead(homeSourceSeq)],
          pending: [],
        },
        operations: [{
          op: "set",
          id: HOME_OUTPUT,
          value: { value: "must-not-land" },
        }],
        schedulerObservation: observation,
      });

    // Observation-side foreign WRITE: still foreign-space-surface.
    const base = claimedObservation(claim, {
      foreignReads: [foreignAddress()],
    });
    const foreignWrite = foreignAddress("of:xsp-vector:foreign-out");
    const writeError = await assertRejects(() =>
      transactClaimed(2, {
        ...base,
        actualChangedWrites: [...base.actualChangedWrites, foreignWrite],
        currentKnownWrites: [...base.currentKnownWrites, foreignWrite],
        declaredWrites: [...(base.declaredWrites ?? []), foreignWrite],
      })
    );
    assertEquals((writeError as Error).name, "ExecutionActionFirewallError");
    assertEquals(
      (writeError as Error & { diagnosticCode?: string }).diagnosticCode,
      "foreign-space-surface",
    );

    // User- and session-scoped foreign READS: still foreign-space-surface
    // (decision #3 — the v1 relax admits space-scoped only).
    for (const [localSeq, scope] of [[3, "user"], [4, "session"]] as const) {
      const scopedRead = foreignAddress(FOREIGN_DOC, scope);
      const scopedError = await assertRejects(() =>
        transactClaimed(localSeq, {
          ...base,
          reads: [homeAddress(HOME_SOURCE), scopedRead],
          completeActionScopeSummary: {
            ...base.completeActionScopeSummary!,
            reads: [homeAddress(HOME_SOURCE), scopedRead],
          },
        })
      );
      assertEquals(
        (scopedError as Error).name,
        "ExecutionActionFirewallError",
      );
      assertEquals(
        (scopedError as Error & { diagnosticCode?: string }).diagnosticCode,
        "foreign-space-surface",
      );
    }
    assertEquals(await server.readDocument(HOME_SPACE, HOME_OUTPUT), null);

    // The reserved top-level `inputBasis` field makes the wire observation
    // malformed: the host binds no claim for it, so the claimed attempt
    // dies at the claim fence instead of ever authoring a basis.
    const reservedError = await assertRejects(() =>
      transactClaimed(5, {
        ...base,
        inputBasis: [{ space: READ_SPACE, seq: 1 }],
      } as unknown as SchedulerActionObservation)
    );
    assertEquals(
      (reservedError as Error).name,
      "ExecutionLeaseFenceError",
    );

    // Scalar-only byte-identity (e): a claimed attempt with NO foreign
    // reads settles without any inputBasis field.
    const scalarOnly = await sponsor.transact({
      localSeq: 6,
      reads: {
        confirmed: [confirmedHomeSourceRead(homeSourceSeq)],
        pending: [],
      },
      operations: [{ op: "set", id: HOME_OUTPUT, value: { value: 3 } }],
      schedulerObservation: claimedObservation(claim),
    });
    const scalarResult = scalarOnly.schedulerObservationResults?.[0];
    assertExists(scalarResult?.executionProvenance);
    assertEquals("inputBasis" in scalarResult.executionProvenance, false);
  } finally {
    await harness.close();
  }
});

Deno.test("C3.5 (m): a CLIENT observation with a foreign read keeps flooring at the session context", async () => {
  // The floor relax is provenance-gated: only host-accepted claimed
  // attempts avoid the crossesSpace demotion. A plain client observation
  // (no claim, no provenance) keeps the conservative session floor the
  // C3.3a wake pipeline pins.
  const harness = await setupHarness("xsp-vector-client-floor");
  try {
    // A plain CLIENT session (never lease-bound — a bound executor session
    // must assert a claim for action runs).
    const clientSession = await mountAs(
      harness.adminClient,
      HOME_SPACE,
      ADMIN,
    );
    const observation = claimedObservation(harness.claim, {
      foreignReads: [foreignAddress()],
      processGeneration: 7,
    });
    delete (observation as unknown as Record<string, unknown>)
      .executionClaimAssertion;
    await clientSession.transact({
      localSeq: 5,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: observation,
    });
    const snapshots = await clientSession.listSchedulerActionSnapshots({
      pieceId: harness.claim.pieceId,
      actionId: harness.claim.actionId,
      processGeneration: 7,
    });
    assertEquals(snapshots.snapshots.length, 1);
    assert(
      snapshots.snapshots[0].executionContextKey.startsWith("session:"),
      `client cross-space reader floors at session context, got ${
        snapshots.snapshots[0].executionContextKey
      }`,
    );
  } finally {
    await harness.close();
  }
});

// ---------------------------------------------------------------------------
// (v) publishActionSettlement vector validation.
// ---------------------------------------------------------------------------

Deno.test("C3.5 (v): publishActionSettlement enforces vector coherence", async () => {
  const harness = await setupHarness("xsp-vector-validate");
  const { server, claim } = harness;
  try {
    const liveClaim = claim as unknown as ActionSettlement["claim"];
    const settle = (
      inputBasis: InputBasisComponent[] | undefined,
      inputBasisSeq = toInputBasisSeq(5),
    ): boolean =>
      server.publishActionSettlement({
        branch: "",
        claim: liveClaim,
        inputBasisSeq,
        ...(inputBasis !== undefined ? { inputBasis } : {}),
        outcome: "no-op",
      });
    const home = (seq: number): InputBasisComponent => ({
      space: HOME_SPACE,
      seq: toInputBasisSeq(seq),
    });
    const foreign = (seq: number): InputBasisComponent => ({
      space: READ_SPACE,
      seq: toInputBasisSeq(seq),
    });
    // Coherent vector publishes.
    assertEquals(settle([home(5), foreign(9)]), true);
    // Missing home component refuses.
    assertEquals(settle([foreign(9)]), false);
    // Home component ≠ scalar refuses.
    assertEquals(settle([home(4), foreign(9)]), false);
    // Duplicate spaces refuse.
    assertEquals(settle([home(5), foreign(9), foreign(8)]), false);
    // A zero-seq foreign component refuses (served stamps are positive).
    assertEquals(settle([home(5), foreign(0)]), false);
    // Empty vector refuses (absent ≠ empty — C3A15 vacuous is ABSENT).
    assertEquals(settle([]), false);
    // Scalar-only still publishes byte-identically.
    assertEquals(settle(undefined), true);
  } finally {
    await harness.close();
  }
});

// ---------------------------------------------------------------------------
// (h+g) the composed wake → read → serve loop, with the C3A16 cause legs.
// ---------------------------------------------------------------------------

Deno.test("C3.5 (h+g): B commits wake the home action, the fresh stamped read serves with the vector, and mirror cause consumption stays in the read space's seq domain", async () => {
  const harness = await setupHarness("xsp-vector-composed");
  const {
    server,
    internals,
    sponsor,
    reader,
    lease,
    claim,
    settlements,
    homeSourceSeq,
  } = harness;
  const wakes: ForeignWakeEvent[] = [];
  const unsubscribeWakes = server.subscribeForeignWakes(
    HOME_SPACE,
    (event) => wakes.push(event),
  );
  try {
    // --- serve #1: point read → claimed commit with the vector. Its
    // accepted observation mirrors into B (the sponsor holds B READ —
    // C3.3b's acting-principal gate) and the foreign-reader subscription
    // registers from the sponsor's demand.
    const first = await server.executorForeignPointRead(lease, {
      readSpace: READ_SPACE,
      claim: claimRefOf(claim),
      address: { id: FOREIGN_DOC },
    });
    assert(first.status === "served");
    const committed1 = await sponsor.transact({
      localSeq: 2,
      reads: {
        confirmed: [confirmedHomeSourceRead(homeSourceSeq)],
        pending: [],
      },
      operations: [{ op: "set", id: HOME_OUTPUT, value: { value: 1 } }],
      schedulerObservation: claimedObservation(claim, {
        foreignReads: [foreignAddress()],
        foreignReadStamps: [
          { space: READ_SPACE, id: FOREIGN_DOC, seq: first.seq },
        ],
      }),
    });
    sponsor.noteAppliedCommit(committed1.seq);
    await server.flushSessions();
    await internals.settleCrossSpaceDeliveries();
    await internals.settleForeignReaderSubscriptions();
    await spinUntil(() => settlements.length === 1, "first settlement");
    assertEquals(settlements[0].inputBasis, [
      { space: HOME_SPACE, seq: toInputBasisSeq(homeSourceSeq) },
      { space: READ_SPACE, seq: toInputBasisSeq(first.seq) },
    ]);

    // The mirror landed in B under the SPACE context (provenance-gated
    // floor — the claimed attempt was not demoted).
    const readEngine = await internals.openEngine(READ_SPACE);
    const mirrored = Engine.listSchedulerActionSnapshots(readEngine, {
      branch: "",
      ownerSpace: HOME_SPACE,
      pieceId: claim.pieceId,
      actionId: claim.actionId,
    }).snapshots;
    assertEquals(mirrored.length, 1);
    assertEquals(mirrored[0].executionContextKey, "space");

    // --- B commits: the wake pipeline fires for the demanded reader.
    await reader.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: FOREIGN_DOC, value: { value: 43 } }],
    });
    await internals.settleCrossSpaceDeliveries();
    await internals.settleForeignReaderSubscriptions();
    await spinUntil(() => wakes.length >= 1, "foreign wake");
    assertEquals(wakes[0].readSpace, READ_SPACE);

    // B's commit dirtied the mirrored reader: a READ-space cause row
    // exists in B's seq domain.
    const causesAfterWake = readEngine.database.prepare(`
      SELECT action_id, source_seq FROM scheduler_action_cause
      ORDER BY source_seq
    `).all() as { action_id: string; source_seq: number }[];
    assert(
      causesAfterWake.some((row) => row.action_id === claim.actionId),
      "B-space cause row for the mirrored reader",
    );
    const wakeCauseSeq = causesAfterWake.find((row) =>
      row.action_id === claim.actionId
    )!.source_seq;

    // --- the rerun: fresh point read (stamps the newer B seq), then the
    // claimed rerun serves with the fresh vector component.
    const second = await server.executorForeignPointRead(lease, {
      readSpace: READ_SPACE,
      claim: claimRefOf(claim),
      address: { id: FOREIGN_DOC },
    });
    assert(second.status === "served");
    assert(second.seq > first.seq, "the rerun stamps a newer B seq");
    assert(second.seq >= wakeCauseSeq, "the fresh stamp covers the wake");

    // Pad the home seq domain so the HOME scalar is numerically larger
    // than every B-domain seq in play — the C3A16 red-green needs the
    // domains to disagree numerically. Padding writes ride an UNBOUND
    // client session (a bound executor session's semantic commits demand
    // exact claim assertions).
    const homeWriter = await mountAs(
      harness.adminClient,
      HOME_SPACE,
      ADMIN,
    );
    let homeSeq = homeSourceSeq;
    for (let i = 0; i < 4; i++) {
      const padded = await homeWriter.transact({
        localSeq: 5 + i,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: HOME_SOURCE,
          value: { value: 100 + i },
        }],
      });
      homeSeq = padded.seq;
    }
    assert(homeSeq > second.seq, "home scalar numerically exceeds B's seqs");

    const committed2 = await sponsor.transact({
      localSeq: 20,
      reads: {
        confirmed: [confirmedHomeSourceRead(homeSeq)],
        pending: [],
      },
      operations: [{ op: "set", id: HOME_OUTPUT, value: { value: 2 } }],
      schedulerObservation: claimedObservation(claim, {
        foreignReads: [foreignAddress()],
        foreignReadStamps: [
          { space: READ_SPACE, id: FOREIGN_DOC, seq: second.seq },
        ],
      }),
    });
    const rerunResult = committed2.schedulerObservationResults?.[0];
    assert(second.status === "served");
    assertEquals(rerunResult?.executionProvenance?.inputBasis, [
      { space: HOME_SPACE, seq: toInputBasisSeq(homeSeq) },
      {
        space: READ_SPACE,
        seq: toInputBasisSeq(second.seq),
        authorizationEpoch: {
          principal: SPONSOR,
          epoch: second.authorizationEpoch.epoch,
        },
      },
    ]);
    sponsor.noteAppliedCommit(committed2.seq);
    await server.flushSessions();
    await internals.settleCrossSpaceDeliveries();

    // (g) green leg: the rerun's mirror consumed the B cause rows AT OR
    // BELOW its B component (wakeCauseSeq ≤ second.seq) — in B's domain.
    const causesAfterRerun = readEngine.database.prepare(`
      SELECT source_seq FROM scheduler_action_cause
      WHERE action_id = :action_id
    `).all({ action_id: claim.actionId }) as { source_seq: number }[];
    assertEquals(
      causesAfterRerun.filter((row) => row.source_seq <= second.seq),
      [],
      "causes covered by the B component are consumed",
    );

    // (g) red-green leg: B commits again — the new cause row is NEWER
    // than the rerun's B component while the HOME scalar is numerically
    // LARGER. A stale rerun (same stamps) re-mirrors; inheriting the home
    // scalar would consume the row (the pre-C3.5 cross-domain bug); the
    // vector's read-space component must leave it standing.
    await reader.transact({
      localSeq: 3,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: FOREIGN_DOC, value: { value: 44 } }],
    });
    await internals.settleCrossSpaceDeliveries();
    await internalsSettleAll(internals);
    const staleCause = readEngine.database.prepare(`
      SELECT source_seq FROM scheduler_action_cause
      WHERE action_id = :action_id
      ORDER BY source_seq DESC
    `).all({ action_id: claim.actionId }) as { source_seq: number }[];
    assert(
      staleCause.length >= 1 && staleCause[0].source_seq > second.seq,
      "a fresh B-domain cause row exists beyond the stale component",
    );

    const committed3 = await sponsor.transact({
      localSeq: 21,
      reads: {
        confirmed: [confirmedHomeSourceRead(homeSeq)],
        pending: [],
      },
      operations: [{ op: "set", id: HOME_OUTPUT, value: { value: 3 } }],
      schedulerObservation: claimedObservation(claim, {
        foreignReads: [foreignAddress()],
        // Stale stamps: the run consumed the OLD mount entry.
        foreignReadStamps: [
          { space: READ_SPACE, id: FOREIGN_DOC, seq: second.seq },
        ],
      }),
    });
    assert(
      committed3.seq > staleCause[0].source_seq,
      "home scalar strictly exceeds the surviving cause row numerically",
    );
    sponsor.noteAppliedCommit(committed3.seq);
    await server.flushSessions();
    await internals.settleCrossSpaceDeliveries();
    const survivors = readEngine.database.prepare(`
      SELECT source_seq FROM scheduler_action_cause
      WHERE action_id = :action_id
    `).all({ action_id: claim.actionId }) as { source_seq: number }[];
    assertEquals(
      survivors.map((row) => row.source_seq),
      staleCause.map((row) => row.source_seq),
      "a B-space cause row newer than the attempt's B component survives " +
        "the mirrored upsert whose HOME scalar is numerically larger (C3A16)",
    );
  } finally {
    unsubscribeWakes();
    await harness.close();
  }
});

/** Settle every asynchronous cross-space delivery + side-effect chain the
 * harness can have in flight (mirror upserts run on the inbound apply
 * chain; dirt propagation on the side-effect queue). */
const internalsSettleAll = async (
  internals: ServerInternals,
): Promise<void> => {
  await internals.settleCrossSpaceDeliveries();
  await internals.settleForeignReaderSubscriptions();
  await internals.settleCrossSpaceDeliveries();
};
