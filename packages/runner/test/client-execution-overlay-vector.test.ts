// C3.9 — the client VECTOR overlay basis + cross-replica confirmation
// correlation. A claimed cross-space-read overlay carries a per-space input
// basis (home component as pre-C3.9 plus one component per foreign read space,
// captured at overlay creation from that space's OWN replica). The drop rule
// generalizes per component under the C3A15 coverage relation: the overlay
// drops only when EVERY component of the settlement's vector covers the
// overlay's basis for that space — an absent settlement component vacuously
// covers (a rerun that dropped a foreign read still drops on home coverage),
// a present-but-older foreign component blocks (C3A15). The §5 vector
// divergence window (settlement.component(S) > overlay.component(S) at drop
// time) is ACCEPTED and COUNTED via a routeDiagnostics comparand (C3A19),
// never blocked. Scalar-only settlements stay byte-identical (regression).
//
// These fixtures drive REAL interleavings (C3A14 discipline): both delivery
// orders, reconnect-snapshot and early-settlement-cache carriers, exactly-once
// drops with double-drop and premature-drop both pinned negative — no vacuous
// pins (the FB4/FB5 lesson).
import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import type { FabricValue } from "@commonfabric/api";
import type { MemorySpace, Signer, URI } from "@commonfabric/memory/interface";
import {
  type AcceptedCommitSeq,
  type ActionSettlement,
  type ExecutionClaim,
  type InputBasisSeq,
  resetServerPrimaryExecutionConfig,
  type SessionSync,
  setServerPrimaryExecutionConfig,
  toInputBasisSeq,
} from "@commonfabric/memory/v2";
import type { AppliedCommit } from "@commonfabric/memory/v2/engine";
import type {
  ReplicaSession,
  ReplicaSessionHandle,
  ReplicaWatchView,
} from "../src/storage/v2-replica-session.ts";
import { type SessionFactory, StorageManager } from "../src/storage/v2.ts";
import type { StorageNotification } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("c3.9 vector overlay principal");
const bSigner = await Identity.fromPassphrase("c3.9 vector overlay space b");
const SPACE = signer.did() as MemorySpace;
const SPACE_B = bSigner.did() as MemorySpace;
const INPUT = "of:vector-overlay-input" as URI;
const OUTPUT = "of:vector-overlay-output" as URI;
const B_INPUT = "of:vector-overlay-b-input" as URI;
const sourceAction = {};

const crossSpaceClaim: ExecutionClaim = {
  branch: "",
  space: SPACE,
  contextKey: "space",
  pieceId: "space:of:vector-overlay-piece",
  actionId: "action:vector-overlay",
  actionKind: "computation",
  implementationFingerprint: "impl:vector-overlay",
  runtimeFingerprint: "runtime:vector-overlay",
  leaseGeneration: 2,
  claimGeneration: 3,
  expiresAt: 100_000,
  crossSpaceReadSpaces: [SPACE_B],
};

// A cross-space observation: reads the home INPUT and the FOREIGN B_INPUT,
// writes the home OUTPUT. The foreign read is what makes the overlay carry a
// B component; the home read is the scalar (home) basis.
const crossSpaceObservation = () => {
  const homeRead = {
    space: SPACE,
    scope: "space" as const,
    id: INPUT,
    path: ["value"],
  };
  const foreignRead = {
    space: SPACE_B,
    scope: "space" as const,
    id: B_INPUT,
    path: ["value"],
  };
  const write = {
    space: SPACE,
    scope: "space" as const,
    id: OUTPUT,
    path: ["value"],
  };
  return {
    version: 2 as const,
    ownerSpace: SPACE,
    branch: "",
    pieceId: crossSpaceClaim.pieceId,
    processGeneration: 1,
    actionId: crossSpaceClaim.actionId,
    actionKind: "computation" as const,
    implementationFingerprint: crossSpaceClaim.implementationFingerprint,
    runtimeFingerprint: crossSpaceClaim.runtimeFingerprint,
    observedAtSeq: 0,
    transactionKind: "action-run" as const,
    reads: [homeRead, foreignRead],
    shallowReads: [],
    actualChangedWrites: [write],
    currentKnownWrites: [write],
    materializerWriteEnvelopes: [],
    completeActionScopeSummary: {
      version: 1 as const,
      complete: true as const,
      implementationFingerprint: crossSpaceClaim.implementationFingerprint,
      runtimeFingerprint: crossSpaceClaim.runtimeFingerprint,
      piece: {
        space: SPACE,
        scope: "space" as const,
        id: "of:vector-overlay-piece",
        path: ["value"],
      },
      reads: [homeRead, foreignRead],
      writes: [write],
      materializerWriteEnvelopes: [],
      directOutputs: [write],
    },
    status: "success" as const,
  };
};

const emptySync = (overrides: Partial<SessionSync> = {}): SessionSync => ({
  type: "sync",
  fromSeq: 0,
  toSeq: 0,
  upserts: [],
  removes: [],
  ...overrides,
});

class PushView implements ReplicaWatchView {
  #pending: PromiseWithResolvers<IteratorResult<SessionSync>>[] = [];
  #queued: {
    sync: SessionSync;
    delivered: PromiseWithResolvers<void>;
    processed: PromiseWithResolvers<void>;
  }[] = [];
  #inFlight: PromiseWithResolvers<void> | undefined;
  #closed = false;

  close(): void {
    this.#closed = true;
    this.#inFlight?.resolve();
    this.#inFlight = undefined;
    for (const queued of this.#queued.splice(0)) {
      queued.delivered.resolve();
      queued.processed.resolve();
    }
    for (const pending of this.#pending.splice(0)) {
      pending.resolve({ done: true, value: undefined });
    }
  }

  push(sync: SessionSync): Promise<void> {
    return this.enqueue(sync).processed;
  }

  enqueue(sync: SessionSync): {
    delivered: Promise<void>;
    processed: Promise<void>;
  } {
    const delivered = Promise.withResolvers<void>();
    const processed = Promise.withResolvers<void>();
    const pending = this.#pending.shift();
    if (pending) {
      this.#inFlight = processed;
      delivered.resolve();
      pending.resolve({ done: false, value: sync });
    } else {
      this.#queued.push({ sync, delivered, processed });
    }
    return { delivered: delivered.promise, processed: processed.promise };
  }

  subscribeSync(): AsyncIterator<SessionSync> {
    return {
      next: () => {
        this.#inFlight?.resolve();
        this.#inFlight = undefined;
        const queued = this.#queued.shift();
        if (queued) {
          this.#inFlight = queued.processed;
          queued.delivered.resolve();
          return Promise.resolve({ done: false, value: queued.sync });
        }
        if (this.#closed) {
          return Promise.resolve({ done: true, value: undefined });
        }
        const pending = Promise.withResolvers<IteratorResult<SessionSync>>();
        this.#pending.push(pending);
        return pending.promise;
      },
    };
  }
}

/** Per-space session state — one "lane" of the single-space overlay harness,
 *  so the home (A) and foreign (B) replicas never share a view or claims. */
class SpaceLane {
  readonly commits: ClientCommitLike[] = [];
  readonly view = new PushView();
  claims: ExecutionClaim[] = [];
  executionFeedSeq = 0;
  onTransact?: (
    commit: ClientCommitLike,
    attempt: number,
  ) => Promise<AppliedCommit>;
  seq = 0;
  #commitWaiters: { count: number; pending: PromiseWithResolvers<void> }[] = [];

  /** Resolves once `count` commits have reached transact — i.e. their
   *  optimistic versions have landed in this replica's #docs. */
  waitForCommitCount(count: number): Promise<void> {
    if (this.commits.length >= count) return Promise.resolve();
    const pending = Promise.withResolvers<void>();
    this.#commitWaiters.push({ count, pending });
    return pending.promise;
  }

  notifyCommit(): void {
    this.#commitWaiters = this.#commitWaiters.filter((waiter) => {
      if (this.commits.length < waiter.count) return true;
      waiter.pending.resolve();
      return false;
    });
  }
}

type ClientCommitLike = { localSeq: number } & Record<string, unknown>;

class CrossSpaceSessionFactory implements SessionFactory {
  readonly lanes = new Map<MemorySpace, SpaceLane>();

  lane(space: MemorySpace): SpaceLane {
    let lane = this.lanes.get(space);
    if (lane === undefined) {
      lane = new SpaceLane();
      this.lanes.set(space, lane);
    }
    return lane;
  }

  create(space: MemorySpace, _signer?: Signer): Promise<ReplicaSessionHandle> {
    const lane = this.lane(space);
    const executionClaims = () => [...lane.claims];
    const executionFeedSeq = () => lane.executionFeedSeq;
    const session = {
      sessionId: `session:vector-${space}`,
      sessionToken: undefined,
      serverSeq: 0,
      get executionClaims() {
        return executionClaims();
      },
      get executionFeedSeq() {
        return executionFeedSeq();
      },
      transact: async (commit: ClientCommitLike): Promise<AppliedCommit> => {
        lane.commits.push(structuredClone(commit));
        lane.notifyCommit();
        if (lane.onTransact) {
          return await lane.onTransact(commit, lane.commits.length);
        }
        return { seq: ++lane.seq, branch: "", revisions: [] };
      },
      watchAddSync: () =>
        Promise.resolve({
          view: lane.view,
          sync: emptySync({
            execution: {
              fromFeedSeq: 0,
              toFeedSeq: 1,
              snapshot: { claims: [...lane.claims] },
              events: [],
            },
          }),
        }),
    } as unknown as ReplicaSession;
    return Promise.resolve({
      client: {
        serverFlags: {
          serverPrimaryExecutionV1: true,
          serverPrimaryExecutionClaimRoutingV1: true,
          serverPrimaryExecutionBuiltinPassivityV1: false,
        },
        close: () => Promise.resolve(),
      } as ReplicaSessionHandle["client"],
      session,
    });
  }
}

class VectorStorageManager extends StorageManager {
  static connect(factory: SessionFactory): VectorStorageManager {
    return new VectorStorageManager({
      as: signer,
      memoryHost: new URL("memory://vector-overlay"),
    }, factory);
  }
}

function notificationCondition(
  storage: StorageManager,
  check: () => boolean,
): Promise<void> {
  if (check()) return Promise.resolve();
  const observed = Promise.withResolvers<void>();
  const subscription = {
    next(_notification: StorageNotification) {
      if (check()) observed.resolve();
      return { done: false as const };
    },
  };
  storage.subscribe(subscription);
  if (check()) observed.resolve();
  return observed.promise.finally(() => storage.unsubscribe(subscription));
}

function visibleValue(
  storage: StorageManager,
  space: MemorySpace,
  id: URI,
): unknown {
  const document = storage.open(space).replica.get({
    id,
    type: "application/json",
  })?.is as { value?: unknown } | undefined;
  return document?.value;
}

/** Establish a confirmed foreign (B) value at `seq` by pushing a sync into B's
 *  replica — the foreign confirmed state the overlay basis captures. */
async function pushForeignConfirmed(
  factory: CrossSpaceSessionFactory,
  seq: number,
  value: FabricValue,
): Promise<void> {
  await factory.lane(SPACE_B).view.push(emptySync({
    toSeq: seq,
    upserts: [{ branch: "", id: B_INPUT, seq, doc: { value } }],
  }));
}

/** Run the claimed cross-space action: reads home INPUT + foreign B_INPUT,
 *  writes home OUTPUT. With the delivered claim naming SPACE_B, the client
 *  suppresses its own foreign-read run and holds a cross-space overlay whose
 *  vector basis captures B's confirmed seq. */
async function runClaimedCrossSpaceAction(
  storage: StorageManager,
  value: FabricValue,
): Promise<void> {
  const tx = storage.edit();
  tx.sourceAction = sourceAction;
  tx.setSchedulerObservation?.(crossSpaceObservation());
  const read = tx.read({
    space: SPACE,
    id: INPUT,
    type: "application/json",
    path: ["value"],
  });
  if (read.error) throw read.error;
  const writer = tx.writer(SPACE);
  if (writer.error) throw writer.error;
  const written = writer.ok.write({
    id: OUTPUT,
    type: "application/json",
    path: ["value"],
  }, value);
  if (written.error) throw written.error;
  const result = await tx.commit();
  if (result.error) throw new Error(result.error.message);
}

const seq = (value: number): InputBasisSeq => toInputBasisSeq(value);

/** A settlement carrying a vector basis (home component + optional foreign
 *  components). `no-op` by default so the pure basis-coverage fixtures skip the
 *  accepted-data barrier; pass `accepted` for a committed settlement whose
 *  home-space data-application gate is exercised. */
function vectorSettlement(options: {
  homeSeq: number;
  foreign?: readonly { space: string; seq: number }[];
  accepted?: number;
}): ActionSettlement {
  const inputBasis = [
    { space: SPACE, seq: seq(options.homeSeq) },
    ...(options.foreign ?? []).map((c) => ({
      space: c.space,
      seq: seq(c.seq),
    })),
  ];
  if (options.accepted === undefined) {
    return {
      branch: "",
      claim: crossSpaceClaim,
      inputBasisSeq: seq(options.homeSeq),
      inputBasis,
      outcome: "no-op",
    };
  }
  return {
    branch: "",
    claim: crossSpaceClaim,
    inputBasisSeq: seq(options.homeSeq),
    inputBasis,
    outcome: "committed",
    acceptedCommitSeq: options.accepted as AcceptedCommitSeq,
  };
}

/** Monotone execution-feed cursor: the client ignores a batch whose
 *  `fromFeedSeq` does not equal its current cursor, so every settlement rides a
 *  strictly-advancing feed window (like the server's real feed). */
class FeedCursor {
  constructor(private value: number) {}
  next(): { fromFeedSeq: number; toFeedSeq: number } {
    const fromFeedSeq = this.value;
    this.value += 1;
    return { fromFeedSeq, toFeedSeq: this.value };
  }
}

function deliverSettlement(
  factory: CrossSpaceSessionFactory,
  cursor: FeedCursor,
  settlement: ActionSettlement,
): Promise<void> {
  return factory.lane(SPACE).view.push(emptySync({
    execution: {
      ...cursor.next(),
      events: [{ type: "session.execution.settlement", settlement }],
    },
  }));
}

const query = { space: SPACE, branch: "", pieceId: crossSpaceClaim.pieceId };

/** Authoritative (basis-covered) overlay drops for the action — the
 *  exactly-once counter. */
function authoritativeDrops(storage: StorageManager): number {
  return storage.getExecutionRoutingDiagnostics(query).actions[0]
    ?.basisCoveredOverlayDrops ?? 0;
}

function divergenceCount(storage: StorageManager): number {
  return storage.getExecutionRoutingDiagnostics(query).branchTotals
    .routeDiagnostics["cross-space-basis-divergence"] ?? 0;
}

function overlayCount(storage: StorageManager): number {
  return storage.getExecutionRoutingDiagnostics(query).actions[0]
    ?.pendingOverlayCount ?? 0;
}

/** Boot the harness with a confirmed foreign B value and a captured
 *  cross-space overlay in A. Returns after the overlay is live. */
async function setupCrossSpace(options: {
  bSeq: number;
  homeInputSeq?: number;
  seedB?: boolean;
}): Promise<{
  factory: CrossSpaceSessionFactory;
  storage: VectorStorageManager;
}> {
  const factory = new CrossSpaceSessionFactory();
  factory.lane(SPACE).claims = [crossSpaceClaim];
  const storage = VectorStorageManager.connect(factory);
  // Start B's watch, then seed its confirmed value (the captured basis). The
  // (b) pending-source fixture skips the seed so its foreign read consumes a
  // client-local pending B write rather than a confirmed value.
  await storage.open(SPACE_B).sync(B_INPUT);
  if (options.seedB !== false) {
    await pushForeignConfirmed(factory, options.bSeq, "b-value");
  }
  // Seed the home input at a confirmed seq so the overlay's home (scalar) basis
  // is non-trivial and the drop rule's home component has teeth.
  const homeInputSeq = options.homeInputSeq ?? 4;
  await storage.open(SPACE).sync(INPUT);
  await factory.lane(SPACE).view.push(emptySync({
    toSeq: homeInputSeq,
    upserts: [{
      branch: "",
      id: INPUT,
      seq: homeInputSeq,
      doc: { value: "home-input" },
    }],
  }));
  return { factory, storage };
}

async function bootCrossSpaceOverlay(options: {
  bSeq: number;
  homeInputSeq?: number;
}): Promise<{
  factory: CrossSpaceSessionFactory;
  storage: VectorStorageManager;
}> {
  const { factory, storage } = await setupCrossSpace(options);
  await runClaimedCrossSpaceAction(storage, "speculative-output");
  return { factory, storage };
}

Deno.test("C3.9 capture: a claimed cross-space action holds a vector overlay carrying the foreign B basis", async () => {
  setServerPrimaryExecutionConfig(true);
  const { factory, storage } = await bootCrossSpaceOverlay({ bSeq: 9 });
  try {
    // The overlay is held locally (no wire commit — the client suppressed its
    // own foreign-read run) and its output is visible optimistically.
    assertEquals(visibleValue(storage, SPACE, OUTPUT), "speculative-output");
    assertEquals(factory.lane(SPACE).commits, []);
    assertEquals(overlayCount(storage), 1);
  } finally {
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

// (a) drop-exactly-once — HOME component covers first, foreign lags. The
// partial settlement covers home but carries a present-but-older B component,
// which BLOCKS (C3A15); only when a later settlement's B component also covers
// does the overlay drop, exactly once. Discrimination: a home-only drop rule
// (ignoring foreign components) would PREMATURELY drop on the partial (reds).
Deno.test("C3.9 (a/C3A14): home-first — a present-but-older foreign component blocks until it covers, drop exactly once", async () => {
  setServerPrimaryExecutionConfig(true);
  const { factory, storage } = await bootCrossSpaceOverlay({ bSeq: 9 }); // {home:4, B:9}
  const cursor = new FeedCursor(1);
  try {
    // Partial: home covers (4<=5) but B is present-but-older (9>4) → BLOCK.
    await deliverSettlement(
      factory,
      cursor,
      vectorSettlement({ homeSeq: 5, foreign: [{ space: SPACE_B, seq: 4 }] }),
    );
    assertEquals(authoritativeDrops(storage), 0);
    assertEquals(overlayCount(storage), 1);

    // Full: home covers AND B now covers (9<=9) → drop exactly once. B==9 is
    // not STRICTLY newer than the overlay's B basis, so no divergence.
    await deliverSettlement(
      factory,
      cursor,
      vectorSettlement({ homeSeq: 5, foreign: [{ space: SPACE_B, seq: 9 }] }),
    );
    assertEquals(authoritativeDrops(storage), 1);
    assertEquals(overlayCount(storage), 0);
    assertEquals(divergenceCount(storage), 0);

    // Redundant covering settlement after the drop — no double-drop.
    await deliverSettlement(
      factory,
      cursor,
      vectorSettlement({ homeSeq: 6, foreign: [{ space: SPACE_B, seq: 12 }] }),
    );
    assertEquals(authoritativeDrops(storage), 1);
  } finally {
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

// (a) drop-exactly-once — FOREIGN component covers first, home lags. The
// partial covers B but the home component is older, so it BLOCKS on home; the
// overlay drops only when a later settlement's home component covers too.
Deno.test("C3.9 (a/C3A14): foreign-first — home lagging blocks until it covers, drop exactly once", async () => {
  setServerPrimaryExecutionConfig(true);
  const { factory, storage } = await bootCrossSpaceOverlay({ bSeq: 9 }); // {home:4, B:9}
  const cursor = new FeedCursor(1);
  try {
    // Partial: B covers (9<=9) but home is older (4>3) → BLOCK on home.
    await deliverSettlement(
      factory,
      cursor,
      vectorSettlement({ homeSeq: 3, foreign: [{ space: SPACE_B, seq: 9 }] }),
    );
    assertEquals(authoritativeDrops(storage), 0);
    assertEquals(overlayCount(storage), 1);

    // Full: home now covers (4<=5) AND B covers → drop exactly once.
    await deliverSettlement(
      factory,
      cursor,
      vectorSettlement({ homeSeq: 5, foreign: [{ space: SPACE_B, seq: 9 }] }),
    );
    assertEquals(authoritativeDrops(storage), 1);
    assertEquals(overlayCount(storage), 0);
  } finally {
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

// (e/C3A15): the vacuous rule — a settlement whose authoritative rerun DROPPED
// the foreign read (no B component) still drops the overlay on home coverage.
// An absent settlement component vacuously covers (names no requirement). The
// plan row: "an authoritative rerun that dropped the foreign read ... drops
// under the vacuous rule (C3A15)." Discrimination: a rule that instead iterated
// the OVERLAY's components (treating an absent settlement component as a
// BLOCK) would strand this overlay — pin absent != blocking.
Deno.test("C3.9 (e/C3A15): a settlement missing the foreign component drops the overlay under the vacuous rule", async () => {
  setServerPrimaryExecutionConfig(true);
  const { factory, storage } = await bootCrossSpaceOverlay({ bSeq: 9 }); // {home:4, B:9}
  const cursor = new FeedCursor(1);
  try {
    // Settlement carries ONLY the home component — the rerun read no foreign
    // space. Home covers (4<=5); the absent B is vacuous → drop exactly once.
    await deliverSettlement(factory, cursor, vectorSettlement({ homeSeq: 5 }));
    assertEquals(authoritativeDrops(storage), 1);
    assertEquals(overlayCount(storage), 0);
    // Absent B is not a divergence (nothing to compare) — count stays 0.
    assertEquals(divergenceCount(storage), 0);
  } finally {
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

// (f/C3A19): the divergence window is COUNTED, not blocked. A settlement B
// component STRICTLY newer than the overlay's captured B basis means the
// revealed home value reflects B-state newer than the client's own B replica
// had confirmed at overlay creation. The overlay still drops; the routeDiagnostics
// comparand increments.
Deno.test("C3.9 (f/C3A19): a settlement foreign component newer than the overlay's basis drops AND counts divergence", async () => {
  setServerPrimaryExecutionConfig(true);
  const { factory, storage } = await bootCrossSpaceOverlay({ bSeq: 9 }); // {home:4, B:9}
  const cursor = new FeedCursor(1);
  try {
    // B=12 > overlay B=9 → covers (drops) AND is the divergence window.
    await deliverSettlement(
      factory,
      cursor,
      vectorSettlement({ homeSeq: 5, foreign: [{ space: SPACE_B, seq: 12 }] }),
    );
    assertEquals(authoritativeDrops(storage), 1);
    assertEquals(overlayCount(storage), 0);
    assertEquals(divergenceCount(storage), 1);
  } finally {
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

// (c/C3A14): reconnect-snapshot — the frontier CARRIES the vector basis, so an
// overlay held across a reconnect drops exactly once. Two phases pin that the
// reconnect carrier both preserves AND consumes the vector: a frontier whose B
// component is present-but-older does NOT drop (a scalar-only carrier that lost
// the vector would premature-drop on home coverage); a covering frontier then
// drops exactly once.
function deliverFrontierSnapshot(
  factory: CrossSpaceSessionFactory,
  cursor: FeedCursor,
  frontier: {
    homeSeq: number;
    foreign?: readonly { space: string; seq: number }[];
  },
): Promise<void> {
  const window = cursor.next();
  return factory.lane(SPACE).view.push(emptySync({
    execution: {
      ...window,
      snapshot: {
        claims: [crossSpaceClaim],
        settlementFrontiers: [{
          branch: "",
          claim: crossSpaceClaim,
          inputBasisSeq: seq(frontier.homeSeq),
          inputBasis: [
            { space: SPACE, seq: seq(frontier.homeSeq) },
            ...(frontier.foreign ?? []).map((c) => ({
              space: c.space,
              seq: seq(c.seq),
            })),
          ],
          throughFeedSeq: window.toFeedSeq,
        }],
      },
      events: [],
    },
  }));
}

Deno.test("C3.9 (c/C3A14): a reconnect frontier carries the vector and drops the held overlay exactly once", async () => {
  setServerPrimaryExecutionConfig(true);
  const { factory, storage } = await bootCrossSpaceOverlay({ bSeq: 9 }); // {home:4, B:9}
  const cursor = new FeedCursor(1);
  try {
    // Frontier home covers (4<=5) but B is present-but-older (9>4) → retained.
    await deliverFrontierSnapshot(factory, cursor, {
      homeSeq: 5,
      foreign: [{ space: SPACE_B, seq: 4 }],
    });
    assertEquals(authoritativeDrops(storage), 0);
    assertEquals(overlayCount(storage), 1);

    // Covering frontier (B now 9) → drops exactly once.
    await deliverFrontierSnapshot(factory, cursor, {
      homeSeq: 5,
      foreign: [{ space: SPACE_B, seq: 9 }],
    });
    assertEquals(authoritativeDrops(storage), 1);
    assertEquals(overlayCount(storage), 0);
  } finally {
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

// (d/C3A14): early-settlement-cache — a VECTOR settlement cached before its
// overlay exists (the C3.5 merge path) drops the overlay exactly once when it
// lands. Pins that the cache carries the vector: a present-but-older cached B
// retains; only a covering cached vector drops on overlay creation.
Deno.test("C3.9 (d/C3A14): an early-cached vector settlement drops the later overlay exactly once", async () => {
  setServerPrimaryExecutionConfig(true);
  const { factory, storage } = await setupCrossSpace({ bSeq: 9 });
  const cursor = new FeedCursor(1);
  try {
    // Cache a covering vector settlement BEFORE the overlay exists.
    await deliverSettlement(
      factory,
      cursor,
      vectorSettlement({
        homeSeq: 5,
        foreign: [{ space: SPACE_B, seq: 9 }],
      }),
    );
    assertEquals(overlayCount(storage), 0); // no overlay yet
    assertEquals(authoritativeDrops(storage), 0);

    // The overlay lands → the cached vector settlement drops it exactly once.
    await runClaimedCrossSpaceAction(storage, "speculative-output");
    assertEquals(authoritativeDrops(storage), 1);
    assertEquals(overlayCount(storage), 0);
  } finally {
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

Deno.test("C3.9 (d/C3A14): an early-cached settlement with a present-but-older foreign component does NOT drop the overlay", async () => {
  setServerPrimaryExecutionConfig(true);
  const { factory, storage } = await setupCrossSpace({ bSeq: 9 });
  const cursor = new FeedCursor(1);
  try {
    // Cache a settlement whose B component is present-but-older (4 < overlay 9).
    await deliverSettlement(
      factory,
      cursor,
      vectorSettlement({
        homeSeq: 5,
        foreign: [{ space: SPACE_B, seq: 4 }],
      }),
    );
    // The overlay lands → the cached vector does NOT cover (present-but-older B).
    await runClaimedCrossSpaceAction(storage, "speculative-output");
    assertEquals(authoritativeDrops(storage), 0);
    assertEquals(overlayCount(storage), 1);
  } finally {
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

// (b): the unresolvedBasisLocalSeqs pending-source translation across a FOREIGN
// component. The overlay's B basis is unresolved because the run read a PENDING
// (client-local, unconfirmed) B write; a settlement covering the resolved
// components is RETAINED until StorageManager correlates B's OWN confirmation
// stream in — then the overlay drops exactly once.
Deno.test("C3.9 (b): a foreign pending-source translation retains the settlement until cross-replica confirmation resolves it", async () => {
  setServerPrimaryExecutionConfig(true);
  const { factory, storage } = await setupCrossSpace({ bSeq: 0, seedB: false });
  const cursor = new FeedCursor(1);
  // Hold B's next commit so its optimistic write stays a PENDING B source.
  const bHeld = Promise.withResolvers<AppliedCommit>();
  factory.lane(SPACE_B).onTransact = () => bHeld.promise;
  try {
    // A client-local pending B write on B_INPUT (never confirmed yet).
    const bStarted = factory.lane(SPACE_B).waitForCommitCount(1);
    const bTx = storage.edit();
    const bWriter = bTx.writer(SPACE_B);
    if (bWriter.error) throw bWriter.error;
    bWriter.ok.write(
      { id: B_INPUT, type: "application/json", path: ["value"] },
      "b-pending",
    );
    const bCommit = bTx.commit(); // stays pending (held)
    // Wait until the B commit reaches transact — its optimistic version has
    // landed in B's replica #docs, so the run reads the PENDING B value.
    await bStarted;

    // The overlay captures B as UNRESOLVED (its basis is the pending write).
    await runClaimedCrossSpaceAction(storage, "speculative-output");
    assertEquals(overlayCount(storage), 1);

    // A settlement whose home + B components would cover is RETAINED while the
    // foreign component is unresolved — the overlay must NOT drop yet.
    await deliverSettlement(
      factory,
      cursor,
      vectorSettlement({
        homeSeq: 5,
        foreign: [{ space: SPACE_B, seq: 9 }],
      }),
    );
    assertEquals(authoritativeDrops(storage), 0);
    assertEquals(overlayCount(storage), 1);

    // B's host confirms the pending write at seq 9 → StorageManager correlates
    // it into the A-overlay's B component → the retained settlement now covers
    // → drop exactly once.
    bHeld.resolve({ seq: 9, branch: "", revisions: [] });
    await bCommit;
    await notificationCondition(storage, () => overlayCount(storage) === 0);
    assertEquals(authoritativeDrops(storage), 1);
  } finally {
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

// (h) regression: a scalar-only settlement (no inputBasis) against a VECTOR
// overlay behaves byte-identically to the pre-C3.9 scalar rule — home coverage
// alone drops it (the foreign component imposes no requirement the settlement
// never names). Guards the "scalar-only settlements keep today's behavior
// byte-identically" contract from the row.
Deno.test("C3.9 (h): a scalar-only settlement drops a vector overlay on home coverage (byte-identical scalar rule)", async () => {
  setServerPrimaryExecutionConfig(true);
  const { factory, storage } = await bootCrossSpaceOverlay({ bSeq: 9 }); // {home:4, B:9}
  const cursor = new FeedCursor(1);
  try {
    // A scalar-only settlement carries NO inputBasis vector at all.
    await factory.lane(SPACE).view.push(emptySync({
      execution: {
        ...cursor.next(),
        events: [{
          type: "session.execution.settlement",
          settlement: {
            branch: "",
            claim: crossSpaceClaim,
            inputBasisSeq: seq(5),
            outcome: "no-op",
          },
        }],
      },
    }));
    assertEquals(authoritativeDrops(storage), 1);
    assertEquals(overlayCount(storage), 0);
    assertEquals(divergenceCount(storage), 0);
  } finally {
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});
