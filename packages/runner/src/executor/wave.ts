// The wave accumulator (server-execution v2 Phase 1 stage D,
// docs/specs/server-side-execution/serving-loop.md §3c–§3d): the seal
// destination a serving runtime's action transactions close into, and the
// wave commit step that batches what sealing attached.
//
// One abstraction, two destinations: `action(tx)` keeps its object and
// interface — 1 action run = 1 IExtendedStorageTransaction — and only the
// DESTINATION differs. On a client (the OFF arm always, and ON-arm
// speculation) seal == commit exactly as today. Server-side, under
// EXPERIMENTAL_SERVER_EXECUTION, the tx seals here instead: its writes
// apply to the space replica's optimistic overlay — the accumulator's
// layered view, store snapshot at the wave's input seq + previously
// sealed writes, which later action runs read through the ordinary read
// path — and the store commit is deferred to the wave.
//
// Sealing fires everything commit fires today: the per-action-run CFC
// gates run unchanged in ExtendedStorageTransaction.commit() before the
// destination dispatch (§3c — the unit is the RUN, `action × instance`,
// never the action), the reactivity log keeps feeding the scheduler's
// dependency graph from the tx journal, and the sealed commit's read set
// feeds the wave's per-doc CAS basis and the scheduler_basis rows (§3b).
// Identity annotations attach AT SEAL TIME, when the run still knows who
// it ran as; the wave commit step only batches what sealing attached — by
// then no single "current user" exists to consult, which is the model,
// not a gap (protocol.md §1).
//
// Nothing installs this on main: the serving loop that drives waves is
// Phase 1 stage F. The machinery lands dark, exercised by tests.

import type { CellScope } from "@commonfabric/api";
import {
  type CommitPrecondition,
  type DerivedWriteAnnotation,
  type Operation,
  resolveScopeKey,
  type ScopeKey,
  type ScopeKeyIdentity,
  STREAM_ENTRIES_DOC_PREFIX,
} from "@commonfabric/memory/v2";
import type { OutboxAppendRow } from "@commonfabric/memory/v2/execution-outbox";
import type {
  CommitError,
  IExtendedStorageTransaction,
  ISpaceReplica,
  IStorageTransaction,
  ITransactionSealSink,
  MemorySpace,
  NativeStorageCommit,
  Result,
  SealedCommitVerdict,
  SealedNativeCommit,
  StorageTransactionRejected,
  TransactionSealDestination,
  Unit,
} from "../storage/interface.ts";
import { parsePointer, pathsOverlap } from "../../../memory/v2/path.ts";
import { getLogger } from "@commonfabric/utils/logger";

const logger = getLogger("wave-accumulator", {
  enabled: true,
  level: "warn",
});

/**
 * What kind of run a contribution came from, deciding its writes' conflict
 * class at the wave commit's per-doc CAS (serving-loop.md §3d):
 *
 * - `derivation` writes are PURE — re-derivable, so a write whose doc head
 *   advanced past the wave's basis is DROPPED; the drop re-arms nothing —
 *   recomputation arrives only through the ordinary dependency path
 *   (serving-loop.md §3d, RULED 2026-08-05);
 * - `event-handler` writes are NON-RE-DERIVABLE consequences — rebased and
 *   retried on conflict, and REQUEUED (rolled back to unconsequenced,
 *   never lost) when the rebase conflicts semantically;
 * - `bookkeeping` is the SANCTIONED INTERNAL STAMP KIND stage F names
 *   when it installs the seal destination (serving-loop.md §3d, RULED
 *   2026-08-05: unstamped seals are refused, so the loop's own writes —
 *   the watermark-doc advance today; the acked-effect retirement write
 *   when Phase 4 lands the client-effect channel, protocol.md §5 —
 *   declare this kind; stage G's outbox-ROW retirement is an unstamped
 *   engine-table delete on plane (c), never a commit). Conflict class:
 *   non-re-derivable, so a raced bookkeeping PATCH rebases when it
 *   commutes with the concurrent commit (the loop's steady-state
 *   watermark advance is a key-path patch); a write that cannot rebase
 *   — a whole-doc set (the first-ever watermark write materializing
 *   the doc), or a semantic conflict such as a whole-doc authored
 *   intrusion — DROPS the contribution whole: there is no event to
 *   requeue, and no re-advance is scheduled by the drop itself. The
 *   loop's watermark advance is INPUT-driven, so the dropped doc write
 *   is re-landed only by the next input batch's advance — on a quiet
 *   space the doc simply lags (while the wave's commit metadata and
 *   the loop's in-memory W, decided before the drop, already carry the
 *   advance — see space-server.ts's bookkeeping-write comment).
 *   Watermark forgery is an accepted authored intrusion — protocol.md
 *   §1's threat model.
 *
 * The remaining §3d non-re-derivable members — `eventWatermark` advances
 * and effect intents — are produced by Phase 3 events and the stage-G
 * effect channel; they seal as `event-handler`-class contributions when
 * their producers exist.
 */
export type WaveRunKind = "derivation" | "event-handler" | "bookkeeping";

/**
 * The run identity a seal attaches to its writes (protocol.md §1's
 * transaction identity model). Stamped onto the action's transaction by
 * whatever drives the run — the serving loop knows what it is running
 * (the demand's instance, or the event's server-stamped `firedAt` actor) —
 * and consumed here at seal time.
 */
export interface WaveRunContext {
  /** Durable action identity for basis rows (serving-loop.md §3b):
   * restart-stable, never per-process. */
  actionId: string;
  kind: WaveRunKind;
  /** ATTRIBUTION — the acting identity, one per action run, where the run
   * has one. A run with no acting identity (a space-scope derivation
   * before any narrowing) carries none (protocol.md §1). */
  acting?: { user: string; session?: string };
  /** The event this handler run consequences (`consequenceOf` carriage). */
  eventId?: string;
  /** The durable stream entry this handler run is processing (Phase 3;
   * OW14's source-event carriage): a cross-space append the run emits
   * records `{sidecarId, eventId}` on its outbox row so a
   * deterministic delivery refusal can write its failure notice onto
   * the SOURCE entry (protocol.md §2b's LT4 ruling). */
  streamEntry?: { sidecarId: string; index: number; seq: number };
  /** The same-wave parent event of a cascade-minted event: a requeued
   * parent folds this contribution into the requeue set (§3d; the
   * model's C8d rollback closure). */
  parentEventId?: string;
  /** The scope INSTANCE this run ran as, for basis rows'
   * action_scope_key. Typed as the shared `ScopeKey` vocabulary so a
   * caller cannot hand the basis index a scope NAME or a hand-rolled
   * format (key-vocabulary.md §4). Defaults to `"space"` — the
   * pre-narrowing instance; stage F's serving loop supplies per-run
   * demanded instances. */
  actionScopeKey?: ScopeKey;
  /** M1 — the PER-RUN identity this run's scoped reads and writes
   * resolve their instance keys against (scopes.md §5, §7 M1): the
   * demand-supplied instance identity for a derivation, the event's
   * server-stamped `firedAt` pair for a handler. When absent the
   * accumulator falls back to its wave-level identity (the OFF-arm
   * cardinality-1 posture, and pre-narrowing space-scope runs, which
   * resolve no scoped addresses at all). */
  scopeKeyIdentity?: ScopeKeyIdentity;
  /** The capability grant a provisioning run's FOREIGN writes are
   * admitted under (protocol.md §2's server-produced authored row, §2b):
   * carried with the acting identity into the foreign commit's metadata
   * for the target's delegated-capability admission. */
  capabilityRef?: string;
}

const waveRunContexts = new WeakMap<object, WaveRunContext>();

/**
 * Stamp the run context onto an action's transaction before the run
 * commits. The wave machinery that drives the scheduler owns the stamp,
 * and it is MANDATORY: `seal()` REFUSES an unstamped transaction
 * (serving-loop.md §3d, RULED 2026-08-05) — every server-side commit
 * path declares its run context, and stage F names the sanctioned
 * internal stamp kinds (e.g. a bookkeeping kind) when it installs the
 * seal destination.
 */
export function stampWaveRunContext(
  tx: IExtendedStorageTransaction,
  context: WaveRunContext,
): void {
  waveRunContexts.set(tx, context);
}

export function waveRunContextOf(
  tx: IExtendedStorageTransaction,
): WaveRunContext | undefined {
  // Walk the wrapper chain (review thread r3739139477): the stamp is
  // keyed on the ORIGINAL transaction object, but scoped reads through
  // `Cell.sample()`/`Cell.sink()` arrive on a TransactionWrapper — a
  // different object — so a direct lookup missed the served run's
  // demand-supplied identity and the read resolved against the service
  // session (wrong scope instance, traversal keys recorded under the
  // service session). Duck-typed to avoid a storage-layer value import.
  let current: IExtendedStorageTransaction | undefined = tx;
  while (current !== undefined) {
    const context = waveRunContexts.get(current);
    if (context !== undefined) return context;
    current = (current as {
      wrappedTransaction?: IExtendedStorageTransaction;
    }).wrappedTransaction;
  }
  return undefined;
}

// The DURABLE-acceptance settlement of a tx sealed into a wave: the seal
// resolves the tx's commit() (acceptance into the wave), but the writes
// become durable only at the wave commit — and a conflict there can
// WITHDRAW the contribution after its commit() already resolved ok. A
// caller whose side effects must wait for durability (the pattern swap's
// teardown + reinstantiation, §3e) awaits this instead. Attached by the
// accumulator at seal, same side-table mechanism as the run context.
const waveSettlements = new WeakMap<
  IExtendedStorageTransaction,
  Promise<Result<Unit, StorageTransactionRejected>>
>();

/** The sealed tx's wave settlement: resolves ok when every sealed space
 * PROMOTED (the wave commit accepted the contribution), error when any
 * withdrew (conflict drop, requeue, abort, abandon). Undefined for a tx
 * that did not seal into a wave (the OFF arm) or sealed nothing. */
export function waveSettlementOf(
  tx: IExtendedStorageTransaction,
): Promise<Result<Unit, StorageTransactionRejected>> | undefined {
  return waveSettlements.get(tx);
}

/**
 * The addressing/attribution pair on one batched write is the wire-shape
 * module's `DerivedWriteAnnotation` (protocol.md §1, §7): one shared
 * shape for the runner attaching it at seal time and the engine consuming
 * the addressing half at admission — the LD3 direction of one definition,
 * imported by engine and runner alike.
 */
export type WaveWriteAnnotation = DerivedWriteAnnotation;

/**
 * One scheduler_basis row (serving-loop.md §3b): ids + seqs only, never
 * payloads. `seq: null` means "this wave's own commit seq" — in-wave reads
 * share it, and only the sink knows the number it allocates.
 */
export interface SchedulerBasisRow {
  action: string;
  actionScopeKey: ScopeKey;
  entitySpace: MemorySpace;
  entity: string;
  entityScopeKey: ScopeKey;
  seq: number | null;
}

/** One §3b overwrite unit of the wave's basis-index carriage: the LAST
 * run of (action, actionScopeKey) in the wave, whose rows replace that
 * instance's stored set. */
export interface WaveBasisInstanceRows {
  action: string;
  actionScopeKey: ScopeKey;
  rows: SchedulerBasisRow[];
}

/** The batched commit the wave hands the sink, per space. */
export interface WaveSpaceCommit {
  space: MemorySpace;
  /** Same-space emitted event entries this batch appends (LT1,
   * events.md §2): their declarations, so the engine's event-append
   * admission stamps each entry's stream `seq` (a derived append must
   * be DECLARED — seq stamping cannot be skipped by a plumbing bug). */
  eventAppends?: Array<{ id: string; scope?: CellScope; eventId: string }>;
  /** True for the home space's derived-class commit; false for a foreign
   * space's authored-class provisioning commit (protocol.md §2b). */
  home: boolean;
  /** The wave's read basis: the store seq of the wave's input snapshot.
   * The sink's re-verification compares doc heads against it. */
  basisSeq: number;
  /** Per doc-instance key (`${id} ${scopeKey}`): the head the wave's
   * REBASE decision observed (§3d's "re-CAS against the new head"). The
   * sink's re-verification MUST require these docs' heads to EQUAL the
   * recorded value — a head that moved past the decision invalidates the
   * field-level merge, and the wave re-decides against the new head. */
  rebasedHeads: ReadonlyArray<{ doc: string; head: number }>;
  /** Surviving operations, in seal order — the commit step never reorders
   * (§3's sealing-order MUST binds the loop's processing order; this step
   * preserves what it was handed). */
  operations: Operation[];
  preconditions: CommitPrecondition[];
  /** Owning contribution index per precondition — home batch only; lets a
   * reported precondition failure resolve per write class. */
  preconditionOwners?: number[];
  annotations: WaveWriteAnnotation[];
  /** Every eventId whose handler consequences ride this commit. */
  consequenceOf: string[];
  /** Basis rows to write INSIDE the same store transaction (§3b's
   * carriage rule — never own commits, never commit metadata), already
   * grouped into overwrite units: per (action, instance), the LAST
   * contributing run's set. */
  basisInstances: WaveBasisInstanceRows[];
  /** The DR1 lease holder identity the derived-class admission checks. */
  holder: string | undefined;
  /** The watermark this home commit is current through (protocol.md §4);
   * every split of one wave repeats the same value. Absent for waves
   * driven outside a serving loop (no watermark exists to carry) and on
   * foreign batches. */
  derivedThrough?: number;
  /** Foreign provisioning batches only (protocol.md §2's server-produced
   * authored row, §2b): the ORIGINATING chain actor + the capability
   * grant the target's admission validates — delegation, never
   * session-identity impersonation. */
  delegated?: {
    actingPrincipal: string;
    actingSession?: string;
    capabilityRef: string;
  };
  /** Per-op resolved scope keys for the batch's folded `sqlite` ops
   * (stage G, discharging the stage-D sqlite bound): the accumulator
   * resolves each op's db scope against its RUN's identity (M1 — the
   * wave envelope has no session to resolve scoped files from), and the
   * sink attaches the matching cell-db file(s) before its store
   * transaction. Ops whose db declares the space scope carry `"space"`
   * explicitly — every sqlite op in the batch has an entry. */
  sqliteScopeKeys?: ReadonlyArray<{ op: number; scopeKey: ScopeKey }>;
  /** The wave's outbound cross-space event appends (serving-loop.md §5,
   * FP1): durable rows the sink writes INSIDE the wave's own store
   * transaction, from surviving contributions only — a withdrawn
   * contribution's appends never ride (its event replays and re-emits).
   * Home batch only. */
  outboxAppends?: readonly OutboxAppendRow[];
}

/**
 * Why the sink refused a wave commit. `conflictedDocs` names doc-instance
 * keys whose head moved past the wave's basis after the accumulator's own
 * head query — the race window the resolve loop closes;
 * `failedPreconditions` names indexes into the batch's preconditions
 * array. A rejection naming neither is terminal for the wave.
 */
export interface WaveCommitRejection {
  name: "WaveCommitRejected";
  message: string;
  conflictedDocs?: readonly string[];
  failedPreconditions?: readonly number[];
}

/**
 * Where the wave commit step commits to. Stage F implements this on the
 * loopback plane (serving-loop.md §1 plane (a)) with the derived-class
 * admission of protocol.md §2; tests implement it directly against an
 * engine. The contract the implementations carry:
 *
 * - `commitWave` MUST apply the batch, its basis rows, and its
 *   consequence/annotation carriage in ONE store transaction;
 * - `commitWave` MUST re-verify, inside that transaction, every doc the
 *   batch writes: a doc in `rebasedHeads` must sit at EXACTLY the head
 *   the rebase decision observed, every other doc's head must not have
 *   passed `basisSeq`, and offenders are reported in `conflictedDocs` —
 *   the batch itself carries no store-level read CAS, and §3d forbids
 *   blind derived writes, so this re-verification is the load-bearing
 *   concurrency check;
 * - whole-wave CAS failure is FORBIDDEN (§3d): a rejection must name what
 *   conflicted (or which preconditions failed, by index) so the wave
 *   resolves per doc, per write class, and re-attempts. The loop
 *   converges without timers: drops and requeues are monotone, and a
 *   rebase re-decision happens only when a named doc's head actually
 *   advanced — each re-attempt observes strictly newer store state.
 */
export interface WaveCommitSink {
  /** Current head seq per doc-instance key (`${id} ${scopeKey}`),
   * 0 for a doc never written. */
  currentHeads(
    space: MemorySpace,
    docs: ReadonlyArray<{ id: string; scope?: CellScope; scopeKey: string }>,
  ): Promise<ReadonlyMap<string, number>>;
  /** The value paths written to a doc-instance by commits after `sinceSeq`
   * — the field-level merge input for the rebase of non-re-derivable
   * writes (§3d). */
  concurrentWritePaths(
    space: MemorySpace,
    doc: { id: string; scope?: CellScope; scopeKey: string },
    sinceSeq: number,
  ): Promise<ReadonlyArray<readonly string[]>>;
  commitWave(
    batch: WaveSpaceCommit,
  ): Promise<Result<{ seq: number }, WaveCommitRejection>>;
}

/**
 * The lease view the wave commit step checks (serving-loop.md §2, DR1):
 * work seals under the tenure it read and checks `isCurrentTenure` at its
 * commit step — a lease lost mid-wave aborts the in-flight wave commit.
 * `ExecutionLeaseCycle` satisfies this structurally.
 */
export interface WaveLease {
  readonly holder: string;
  readonly tenure: number;
  isCurrentTenure(sealedTenure: number): boolean;
}

/** One sealed action run held by the accumulator. */
interface WaveContribution {
  index: number;
  context: WaveRunContext;
  /** Per-space sealed commits, in the tx's commit order (children first,
   * home last — protocol.md §2b). */
  spaces: SealedSpaceContribution[];
  /** Doc-instance keys read in spaces this run WROTE NOTHING to (the
   * sealSpaceReads handoff — stage F, discharging the stage-D bound):
   * `${space}\0${docInstanceKey}`, folded into the withdrawn-read
   * closure by DOC IDENTITY. Conservative by design: a reader of a doc
   * some withdrawn contribution wrote folds in even when it read the
   * pre-seal state (layer provenance is replica-internal for unsealed
   * spaces) — over-dropping a derivation is sound, committing one
   * derived from withdrawn state is not (§3d). */
  readOnlyReadKeys: Set<string>;
  /** Cross-space event appends this run emitted (serving-loop.md §5,
   * FP1): folded into the home batch's durable rows iff the
   * contribution survives — a withdrawn contribution's appends never
   * ride (its event replays and re-emits, the model's committed-only
   * `cascadesCross` fold). */
  outboundAppends: OutboxAppendRow[];
}

interface SealedSpaceContribution {
  space: MemorySpace;
  native: NativeStorageCommit;
  sealed: SealedNativeCommit;
  resolveVerdict: (verdict: SealedCommitVerdict) => void;
}

/** How the wave commit step disposed of one contribution. */
export type ContributionDisposition =
  | { kind: "committed" }
  /** Some pure-derivation ops dropped (superseded); survivors rode the
   * wave commit. The sealed commit's local overlay rolls back whole and
   * reconverges from the wave commit arriving as confirmed state. */
  | { kind: "partially-dropped"; droppedOps: number }
  /** All ops withdrawn: a fully superseded derivation, or a derivation
   * that read a withdrawn contribution's sealed writes. */
  | { kind: "dropped" }
  /** A raced non-re-derivable consequence: rolled back to unconsequenced,
   * to be retried in a later wave — never lost, never doubled (§3d; NOT
   * events.md §5's DROP, which is for handlers that cannot run at all). */
  | { kind: "requeued" };

export interface WaveCommitOutcome {
  /** The home commit's store seq; absent when the wave had nothing to
   * commit or aborted. */
  seq?: number;
  aborted?: "lease-lost" | "abandoned" | "foreign-commit-failed" | "rejected";
  /** Superseded pure-derivation writes dropped at the per-doc CAS —
   * §7's `supersededWrites` counter feeds from this. */
  supersededWrites: number;
  /** Pure-derivation ops dropped because they read a withdrawn
   * contribution's sealed writes — re-derivable, and re-run through
   * their own reads when fresh state lands (§3d, RULED 2026-08-05).
   * Counted apart from `supersededWrites` so that counter keeps §3d's
   * exact meaning (doc head advanced past the basis). */
  dependencyDroppedWrites: number;
  /** Events rolled back to unconsequenced, in seal order — the serving
   * loop retries them in a later wave. */
  requeuedEventIds: string[];
  /** Events whose consequences committed (the commit's `consequenceOf`). */
  committedEventIds: string[];
  dispositions: ContributionDisposition[];
}

const docInstanceKey = (id: string, scopeKey: string): string =>
  `${id} ${scopeKey}`;

interface PendingAssembly {
  /** Undefined until the post-seal emptiness check: a tx with writes and
   * no context is refused; an empty tx needs none. */
  context: WaveRunContext | undefined;
  spaces: SealedSpaceContribution[];
  readOnlyReadKeys: Set<string>;
}

/**
 * The wave accumulator: seal destination for one wave's action
 * transactions, and the wave commit step over what they sealed.
 *
 * Actions run serially per space (serving-loop.md §3d) and their commits
 * arrive through `seal()` in the scheduler's order; the accumulator
 * preserves that order end to end. Failure isolation is per action: a tx
 * that aborts, or fails its CFC gates, never reaches `seal()`; a tx whose
 * seal fails mid-way withdraws only its own already-sealed spaces.
 */
export class WaveAccumulator
  implements TransactionSealDestination, ITransactionSealSink {
  readonly #space: MemorySpace;
  readonly #basisSeq: number;
  readonly #scopeKeyIdentity: ScopeKeyIdentity;
  readonly #replicaFor: (space: MemorySpace) => ISpaceReplica;
  readonly #lease: WaveLease | undefined;
  readonly #sealedTenure: number;
  #contributions: WaveContribution[] = [];
  #assembly: PendingAssembly | undefined;
  #closed = false;
  #derivedThrough: number | undefined;
  /** Outbound appends staged per transaction before its seal
   * (enqueueOutboundAppend); folded (by copy) into the contribution at
   * seal so only surviving contributions' appends ride the wave (FP1).
   * A post-seal enqueue on the same tx is refused — it could no longer
   * ride this wave's transaction. */
  readonly #pendingAppendsByTx = new WeakMap<object, OutboxAppendRow[]>();
  readonly #sealedTxs = new WeakSet<object>();
  readonly #onUnstampedSeal: (() => void) | undefined;

  constructor(options: {
    /** The home space this wave derives for. */
    space: MemorySpace;
    /** Store seq of the wave's input snapshot: the per-doc CAS basis
     * (serving-loop.md §3b's snapshot discipline — mid-wave commits are
     * the NEXT wave's input). */
    basisSeq: number;
    /** The acting identity scoped writes resolve their instance keys
     * against, via the shared scope_key constructor — never a caller-
     * supplied format (key-vocabulary.md §3/§4). At OFF-arm cardinality 1
     * this is the runtime's own authenticated session; stage F's serving
     * loop supplies per-run demanded identities when it builds real
     * accumulators. */
    scopeKeyIdentity: ScopeKeyIdentity;
    replicaFor: (space: MemorySpace) => ISpaceReplica;
    lease?: WaveLease;
    /** Counted observation of §3d's unstamped-seal refusal (the
     * serving loop feeds its §7 `unstampedSealRefusals` counter):
     * called once per refused write-carrying transaction, right
     * before the refusal throws. The refusal semantics are unchanged
     * — this only makes the storm a counter fact. */
    onUnstampedSeal?: () => void;
  }) {
    this.#space = options.space;
    this.#basisSeq = options.basisSeq;
    this.#scopeKeyIdentity = options.scopeKeyIdentity;
    this.#replicaFor = options.replicaFor;
    this.#lease = options.lease;
    this.#sealedTenure = options.lease?.tenure ?? 0;
    this.#onUnstampedSeal = options.onUnstampedSeal;
  }

  get space(): MemorySpace {
    return this.#space;
  }

  get basisSeq(): number {
    return this.#basisSeq;
  }

  get contributionCount(): number {
    return this.#contributions.length;
  }

  /** Whether this wave has been committed or abandoned — nothing may
   * seal into it, and effects handed over for it are stragglers (the
   * SpaceServer's park-race drop). */
  get closed(): boolean {
    return this.#closed;
  }

  /** Whether any contribution staged outbound appends — the serving
   * loop's cheap gate on draining the durable outbox after this wave's
   * commit (a pre-disposition upper bound: withdrawn contributions'
   * appends never actually ride). */
  get hasOutboundAppends(): boolean {
    return this.#contributions.some((c) => c.outboundAppends.length > 0);
  }

  /**
   * TransactionSealDestination: an action tx closes into the wave. Runs
   * the tx's own seal machinery (validation, per-space native commits in
   * commit order) with this accumulator as the per-space sink, then
   * records the contribution under the tx's stamped run context.
   */
  async seal(
    tx: IExtendedStorageTransaction,
  ): Promise<Result<Unit, CommitError>> {
    if (this.#closed) {
      return {
        error: {
          name: "StorageTransactionAborted",
          message: "wave already committed or abandoned; nothing may seal " +
            "into it (serving-loop.md §3: mid-wave commits are the next " +
            "wave's input)",
          reason: new Error("wave-closed"),
        },
      };
    }
    const inner = tx.tx;
    if (inner.sealInto === undefined) {
      return {
        error: {
          name: "StorageTransactionAborted",
          message: "storage transaction does not support sealing",
          reason: new Error("seal-unsupported"),
        },
      };
    }
    const context = waveRunContextOf(tx);
    // seal() runs one tx at a time: sealInto hands spaces back through
    // sealSpaceCommit below, and actions run serially per space
    // (serving-loop.md §3d), so a live assembly means interleaved seals —
    // a wave-host bug, not a race to tolerate.
    if (this.#assembly !== undefined) {
      throw new Error(
        "concurrent seal() calls on one wave: actions run serially per " +
          "space (serving-loop.md §3d)",
      );
    }
    this.#assembly = {
      context,
      spaces: [],
      readOnlyReadKeys: new Set(),
    };
    try {
      const result = await inner.sealInto(this);
      const assembly = this.#assembly;
      if (result.error) {
        // Failure isolation is per action (§3d): withdraw only this tx's
        // already-sealed spaces; the wave keeps every other contribution.
        for (const space of assembly.spaces) {
          space.resolveVerdict({
            withdrawn: { message: `seal failed: ${result.error.message}` },
          });
        }
        return result;
      }
      // A transaction with nothing to seal (read-only, or all-no-op)
      // AND no staged appends contributes nothing — same as commit's
      // empty-transaction fast path — and needs no run context: the §3d
      // refusal below guards CONSEQUENCES entering the wave (writes and
      // staged appends alike), and a serving runtime's read probes
      // (piece structure loads, pattern-identity reads) commit nothing.
      // A tx that sealed NOTHING but STAGED APPENDS — the Phase-3
      // pure-forwarding handler, whose only consequence is a
      // cross-space emit — MINTS a zero-write contribution below (the
      // stage-G review's M-A): the model explicitly permits committed
      // contributions with `writes: []` carrying cross-space appends
      // (its cascadesCross/consequenceOf folds run for every committed
      // contribution), and dropping the entry here lost the appends
      // silently.
      const pendingAppends = this.#pendingAppendsByTx.get(tx) ?? [];
      if (assembly.spaces.length === 0 && pendingAppends.length === 0) {
        return result;
      }
      if (context === undefined) {
        // No anonymous fallback (serving-loop.md §3d, RULED 2026-08-05):
        // an unstamped seal WITH WRITES (or staged appends) is a
        // wave-host bug — every server-side commit path stamps its run
        // context before sealing, and stage F names the sanctioned
        // internal stamp kinds ("bookkeeping", for the loop's own
        // writes) when it installs the seal destination. The
        // already-sealed overlay writes are withdrawn before the throw,
        // so nothing anonymous survives in the wave OR the overlay.
        // Unreachable from the OFF arm: without a destination
        // installed, seal == commit and this class never runs.
        for (const space of assembly.spaces) {
          space.resolveVerdict({
            withdrawn: {
              message: "unstamped transaction refused at the seal " +
                "destination (serving-loop.md §3d)",
            },
          });
        }
        this.#onUnstampedSeal?.();
        throw new Error(
          "unstamped transaction sealed into a wave: stamp the run " +
            "context (stampWaveRunContext) before sealing — every " +
            "server-side commit path declares its run context " +
            "(serving-loop.md §3d, RULED 2026-08-05)",
        );
      }
      this.#sealedTxs.add(tx);
      this.#contributions.push({
        index: this.#contributions.length,
        context,
        spaces: assembly.spaces,
        readOnlyReadKeys: assembly.readOnlyReadKeys,
        // Copied: a (refused) post-seal enqueue must not be able to
        // mutate the sealed contribution through the shared array.
        outboundAppends: [...pendingAppends],
      });
      waveSettlements.set(
        tx,
        Promise.all(
          assembly.spaces.map((space) => space.sealed.settled),
        ).then((settled) =>
          settled.find((outcome) => outcome.error !== undefined) ?? { ok: {} }
        ),
      );
      return result;
    } finally {
      this.#assembly = undefined;
    }
  }

  /**
   * Stage a cross-space event append for the run owning `tx`
   * (serving-loop.md §5, FP1): the entry becomes a durable engine-table
   * row written INSIDE the wave's own store transaction — iff the run's
   * contribution survives the wave commit. Phase 3's handler cascades
   * are the production producer; until then tests drive it (the
   * machinery lands dark, like stage D's).
   */
  enqueueOutboundAppend(
    tx: IExtendedStorageTransaction,
    entry: OutboxAppendRow,
  ): void {
    if (this.#closed) {
      throw new Error(
        "wave already committed or abandoned; nothing may stage appends " +
          "into it (serving-loop.md §3)",
      );
    }
    if (this.#sealedTxs.has(tx)) {
      throw new Error(
        "transaction already sealed; its appends rode (or were refused " +
          "with) its contribution — stage appends before the seal " +
          "(serving-loop.md §5)",
      );
    }
    // Fail-closed at the SOURCE, mirroring the delegated admission
    // floor (protocol.md §2): an entry the target would refuse
    // deterministically (the LT4 arm) must never become a durable row.
    // The OW15 carve-out (SHAPE RULED 2026-08-05, implemented with
    // Phase 3): a USERLESS entry stages IFF it is DECLARED
    // sessionless-space-scope — a chain with no actor anywhere, whose
    // delivered entry stamps `firedAt = { session: "server" }`. The
    // floor negatives hold both ways, the declaration alongside a
    // present actor is a refused contradiction, and grant presence
    // stays mandatory throughout.
    if (entry.capabilityRef === "") {
      throw new Error(
        "outbound append refused: the delegated admission floor requires " +
          "the capability grant (protocol.md §2) — the " +
          "sessionless-space-scope carve-out never lifts it",
      );
    }
    const userless = entry.actingPrincipal === undefined ||
      entry.actingPrincipal === "";
    if (userless && entry.sessionlessSpaceScope !== true) {
      throw new Error(
        "outbound append refused: a userless emission stages only under " +
          "the declared sessionless-space-scope carve-out (protocol.md " +
          "§2, SHAPE RULED 2026-08-05; events.md §2)",
      );
    }
    if (!userless && entry.sessionlessSpaceScope === true) {
      throw new Error(
        "outbound append refused: a sessionless-space-scope declaration " +
          "alongside an acting principal is a contradiction — the " +
          "declaration names a chain with NO actor (events.md §2)",
      );
    }
    if (
      userless && entry.actingSession !== undefined &&
      entry.actingSession !== ""
    ) {
      throw new Error(
        "outbound append refused: a sessionless-space-scope declaration " +
          "alongside an acting session is a contradiction (events.md §2)",
      );
    }
    let pending = this.#pendingAppendsByTx.get(tx);
    if (pending === undefined) {
      pending = [];
      this.#pendingAppendsByTx.set(tx, pending);
    }
    pending.push(entry);
  }

  /**
   * Resolves when every sealed commit's local settlement (promotion or
   * rollback) has completed — after commitWave/abandon resolved the
   * verdicts. The serving loop awaits this before treating the replica's
   * overlay as quiescent; tests await it before asserting on replica
   * state.
   */
  async settled(): Promise<void> {
    await Promise.all(
      this.#contributions.flatMap((contribution) =>
        contribution.spaces.map((space) =>
          space.sealed.settled.then(() => undefined, () => undefined)
        )
      ),
    );
  }

  /**
   * ITransactionSealSink: one space of the currently-sealing tx. Applies
   * the native commit to the space replica's optimistic overlay (the
   * layered view later runs read) and holds the verdict open until the
   * wave commit step disposes of it.
   */
  sealSpaceCommit(
    space: MemorySpace,
    native: NativeStorageCommit,
    source: IStorageTransaction,
  ): Promise<Result<Unit, CommitError>> {
    const assembly = this.#assembly;
    if (assembly === undefined) {
      return Promise.resolve({
        error: {
          name: "StorageTransactionAborted",
          message: "sealSpaceCommit outside a seal() call",
          reason: new Error("seal-out-of-order"),
        },
      });
    }
    const replica = this.#replicaFor(space);
    if (replica.sealNative === undefined) {
      return Promise.resolve({
        error: {
          name: "StorageTransactionAborted",
          message: `space replica for ${space} does not support sealing`,
          reason: new Error("seal-unsupported"),
        },
      });
    }
    const { promise, resolve } = Promise.withResolvers<SealedCommitVerdict>();
    const sealed = replica.sealNative(native, source, promise);
    assembly.spaces.push({
      space,
      native,
      sealed,
      resolveVerdict: resolve,
    });
    return Promise.resolve({ ok: {} });
  }

  /**
   * ITransactionSealSink (optional half): the read set of a space the
   * currently-sealing tx read but wrote nothing to. Recorded per
   * contribution and folded into the withdrawn-read closure by doc
   * identity (see WaveContribution.readOnlyReadKeys — the stage-D
   * bound's discharge).
   */
  sealSpaceReads(
    space: MemorySpace,
    reads: readonly { space: MemorySpace; id: string; scope?: CellScope }[],
  ): void {
    const assembly = this.#assembly;
    if (assembly === undefined) return;
    for (const read of reads) {
      assembly.readOnlyReadKeys.add(
        `${space}\0${
          docInstanceKey(
            read.id,
            this.#scopeKeyFor(read.scope, assembly.context ?? undefined),
          )
        }`,
      );
    }
  }

  /**
   * Abandon the wave: every sealed commit's local overlay rolls back, and
   * nothing reaches the store. The caller MUST abandon (or commit) before
   * any replica reset — a reset's local rejections would otherwise race
   * verdicts for a wave that no longer exists.
   */
  abandon(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const contribution of this.#contributions) {
      this.#withdraw(contribution, `wave abandoned: ${reason}`);
    }
  }

  #withdraw(contribution: WaveContribution, message: string): void {
    for (const space of contribution.spaces) {
      space.resolveVerdict({ withdrawn: { message } });
    }
  }

  /**
   * The wave commit step (serving-loop.md §3d): per-doc CAS against the
   * wave's basis with per-WRITE-CLASS conflict handling, then one batched
   * commit per space through the sink — foreign provisioning commits
   * first, home derived commit after success (protocol.md §2b). Whole-wave
   * CAS failure and blind derived writes are forbidden by construction:
   * every conflicted doc is dropped (pure), rebased (non-re-derivable,
   * disjoint fields), or requeues its event (semantic conflict) before the
   * batch is handed to the sink, and the sink re-verifies the remainder
   * inside its store transaction.
   */
  async commitWave(
    sink: WaveCommitSink,
    options: {
      /** The watermark the home commit carries (protocol.md §4's
       * `derivedThrough`). The serving loop passes the post-wave W —
       * unchanged from the current W on a budget-exhausted flush
       * (serving-loop.md §3). Absent for waves driven outside a loop. */
      derivedThrough?: number;
    } = {},
  ): Promise<WaveCommitOutcome> {
    if (this.#closed) {
      throw new Error("wave already committed or abandoned");
    }
    this.#closed = true;
    this.#derivedThrough = options.derivedThrough;
    const outcome: WaveCommitOutcome = {
      supersededWrites: 0,
      dependencyDroppedWrites: 0,
      requeuedEventIds: [],
      committedEventIds: [],
      dispositions: this.#contributions.map(() => ({ kind: "committed" })),
    };

    // The lease check (serving-loop.md §2's stop-committing MUST): work
    // sealed under a lapsed tenure never commits. Recovery: the serving
    // loop PARKS the space on this abort, and re-activation's
    // fresh-runtime recompute-on-demand is the ONLY post-abort arm —
    // the withdrawal below re-arms nothing in place (no revert
    // consumer; inputs unchanged), so a loop that continued after the
    // abort would advance W over derivations that never re-ran
    // (space-server.ts's lease-lost-abort park).
    if (
      this.#lease !== undefined &&
      !this.#lease.isCurrentTenure(this.#sealedTenure)
    ) {
      for (const contribution of this.#contributions) {
        this.#withdraw(
          contribution,
          "lease lost mid-wave; the in-flight wave aborts " +
            "(serving-loop.md §2)",
        );
        outcome.dispositions[contribution.index] =
          contribution.context.kind === "event-handler"
            ? { kind: "requeued" }
            : { kind: "dropped" };
      }
      this.#reportRequeuedEvents(outcome, () => true);
      outcome.aborted = "lease-lost";
      return outcome;
    }

    if (this.#contributions.length === 0) {
      return outcome;
    }

    // ---- per-doc conflict resolution, per write class (§3d) ----

    const homeWrites = this.#contributions.map((contribution) =>
      this.#homeDocInstances(contribution)
    );
    /** Per SPACE: sealed localSeq → contribution index. LocalSeqs are
     * per-space replica counters, so the mapping must be per-space too —
     * a pending read in a FOREIGN sealed commit resolves its layers
     * against that space's seals, which is what folds a reader of a
     * withdrawn foreign write into the withdrawal (the cross-space half
     * of the closure below). */
    const byLocalSeq = new Map<MemorySpace, Map<number, number>>();
    for (const contribution of this.#contributions) {
      for (const sealed of contribution.spaces) {
        let perSpace = byLocalSeq.get(sealed.space);
        if (perSpace === undefined) {
          perSpace = new Map();
          byLocalSeq.set(sealed.space, perSpace);
        }
        perSpace.set(sealed.sealed.localSeq, contribution.index);
      }
    }
    const allDocs = new Map<
      string,
      { id: string; scope?: CellScope; scopeKey: string }
    >();
    for (const docs of homeWrites) {
      for (const [key, doc] of docs) allDocs.set(key, doc);
    }

    const conflicted = new Set<string>();
    const requeued = new Set<number>();
    const droppedWhole = new Set<number>();
    /** per contribution: home doc-instance keys whose ops are dropped */
    const droppedDocs: Set<string>[] = this.#contributions.map(() => new Set());
    /** per contribution: conflicted docs whose non-re-derivable ops
     * rebase — the disposition is PER (contribution, doc): one handler's
     * commuting patches never absolve another contribution's writes to
     * the same doc from their own drop/rebase/requeue check. */
    const rebasedDocs: Set<string>[] = this.#contributions.map(() => new Set());
    /** per rebased doc: the head every rebase decision on it observed
     * (§3d's "re-CAS against the new head" — the sink re-verifies the
     * doc still sits exactly there inside its store transaction). */
    const rebasedHeads = new Map<string, number>();

    const heads = new Map(
      await sink.currentHeads(this.#space, [...allDocs.values()]),
    );
    for (const [key] of allDocs) {
      if ((heads.get(key) ?? 0) > this.#basisSeq) conflicted.add(key);
    }

    const resolveConflicts = async (): Promise<void> => {
      for (const contribution of this.#contributions) {
        if (
          requeued.has(contribution.index) ||
          droppedWhole.has(contribution.index)
        ) {
          continue;
        }
        const docs = homeWrites[contribution.index];
        for (const [key, doc] of docs) {
          if (
            !conflicted.has(key) ||
            droppedDocs[contribution.index].has(key) ||
            rebasedDocs[contribution.index].has(key)
          ) {
            continue;
          }
          if (contribution.context.kind === "derivation") {
            // Pure derivation write superseded: DROP, sound because
            // re-derivable. The drop re-arms nothing — recomputation
            // arrives only through the ordinary dependency path
            // (§3d, RULED 2026-08-05).
            droppedDocs[contribution.index].add(key);
            outcome.supersededWrites += this.#homeOpCountFor(
              contribution,
              doc,
            );
          } else {
            // Non-re-derivable consequence (event-handler and the loop's
            // bookkeeping alike): rebase against the new head —
            // field-level merge for writes that commute with the
            // concurrent commit. A semantic conflict requeues an EVENT
            // contribution whole; a bookkeeping contribution has no
            // event to requeue and DROPS whole instead — the loop
            // re-derives its bookkeeping next wave (WaveRunKind doc).
            const concurrent = await sink.concurrentWritePaths(
              this.#space,
              doc,
              this.#basisSeq,
            );
            if (this.#rebases(contribution, doc, concurrent)) {
              rebasedDocs[contribution.index].add(key);
              rebasedHeads.set(key, heads.get(key) ?? 0);
            } else if (contribution.context.kind === "event-handler") {
              requeued.add(contribution.index);
              break;
            } else {
              droppedWhole.add(contribution.index);
              outcome.dependencyDroppedWrites += this.#homeOpCount(
                contribution,
              );
              break;
            }
          }
        }
      }

      // Requeue closure: same-wave cascade descendants of a requeued
      // event fold in (the model's parent walk), and so does anything
      // that READ a withdrawn sealed write — whether its owner withdrew
      // whole (requeue, dependency drop) or exactly that doc's write was
      // dropped as superseded. A write derived from withdrawn state must
      // not commit. The per-doc droppedDocs clause is scoped to the HOME
      // space: superseded drops are only ever resolved for home docs,
      // and doc-instance keys carry no space component.
      const readSawWithdrawnWrite = (
        ownerIndex: number,
        readDocKey: string,
        readSpace: MemorySpace,
      ): boolean =>
        requeued.has(ownerIndex) || droppedWhole.has(ownerIndex) ||
        (readSpace === this.#space && droppedDocs[ownerIndex].has(readDocKey));
      // Sealed writers per `${space}\0${docInstanceKey}` — the doc-identity
      // index the read-only-space closure folds through (a read handed
      // over by sealSpaceReads carries no layer provenance, so the fold
      // is by doc identity — conservative and sound; see
      // WaveContribution.readOnlyReadKeys).
      const sealedWriters = new Map<string, Set<number>>();
      for (const contribution of this.#contributions) {
        for (const sealed of contribution.spaces) {
          for (const operation of sealed.sealed.commit.operations) {
            if (operation.op === "sqlite") continue;
            const key = `${sealed.space}\0${
              docInstanceKey(
                operation.id,
                this.#scopeKeyFor(operation.scope, contribution.context),
              )
            }`;
            let owners = sealedWriters.get(key);
            if (owners === undefined) {
              owners = new Set();
              sealedWriters.set(key, owners);
            }
            owners.add(contribution.index);
          }
        }
      }
      const readOnlyReadSawWithdrawal = (
        contribution: WaveContribution,
      ): boolean => {
        for (const readKey of contribution.readOnlyReadKeys) {
          const owners = sealedWriters.get(readKey);
          if (owners === undefined) continue;
          const docKey = readKey.slice(readKey.indexOf("\0") + 1);
          const readSpace = readKey.slice(
            0,
            readKey.indexOf("\0"),
          ) as MemorySpace;
          for (const owner of owners) {
            if (
              owner !== contribution.index &&
              readSawWithdrawnWrite(owner, docKey, readSpace)
            ) {
              return true;
            }
          }
        }
        return false;
      };
      let grew = true;
      while (grew) {
        grew = false;
        for (const contribution of this.#contributions) {
          const idx = contribution.index;
          if (requeued.has(idx) || droppedWhole.has(idx)) continue;
          const parent = contribution.context.parentEventId;
          const parentRequeued = parent !== undefined &&
            this.#contributions.some((c) =>
              requeued.has(c.index) && c.context.eventId === parent
            );
          const readWithdrawn = this.#readsWithdrawnContribution(
            contribution,
            byLocalSeq,
            readSawWithdrawnWrite,
          ) || readOnlyReadSawWithdrawal(contribution);
          if (!parentRequeued && !readWithdrawn) continue;
          if (contribution.context.kind === "event-handler") {
            requeued.add(idx);
          } else {
            droppedWhole.add(idx);
            outcome.dependencyDroppedWrites += this.#homeOpCount(
              contribution,
            );
          }
          grew = true;
        }
      }
    };

    await resolveConflicts();

    // ---- foreign provisioning commits FIRST (protocol.md §2b) ----
    //
    // Committed exactly once, before the home commit loop below: a home
    // re-attempt never re-sends them. A contribution that requeues AFTER
    // its foreign commit landed is the §2b replay-convergence case — its
    // event replays, deterministic destination ids make the
    // re-provisioning a CAS no-op, and the home links land with the
    // replayed consequence.
    // Accepted seq PER BATCH (space + delegated identity), not per
    // space: one wave may commit several batches into one foreign space
    // (one per acting identity), and each contribution must settle with
    // the seq of the batch ITS ops rode — a space-keyed map would
    // promote every contribution with the LAST batch's seq, skewing
    // replica heads and later conflict decisions.
    const foreignSeqs = new Map<string, number>();
    for (
      const { key, batch } of this.#buildForeignBatches(requeued, droppedWhole)
    ) {
      // Tenure re-check per sink call (defense-in-depth over the entry
      // check): the entry check plus the engine's live-lease row cover
      // today's synchronous sink, but an ASYNC sink would re-open the
      // same-process C7b window between entry and this call.
      if (
        this.#lease !== undefined &&
        !this.#lease.isCurrentTenure(this.#sealedTenure)
      ) {
        this.#abortAfterForeignFailure(outcome);
        outcome.aborted = "lease-lost";
        return outcome;
      }
      const result = await sink.commitWave(batch);
      if (result.error) {
        logger.warn("wave-foreign-commit-failed", () => [
          `foreign provisioning commit to ${batch.space} failed; ` +
          "home commit withheld (protocol.md §2b)",
          result.error,
        ]);
        this.#abortAfterForeignFailure(outcome);
        outcome.aborted = "foreign-commit-failed";
        return outcome;
      }
      foreignSeqs.set(key, result.ok.seq);
    }

    // ---- the home commit, re-resolving on sink-reported races ----
    while (true) {
      const batch = this.#buildHomeBatch(
        requeued,
        droppedWhole,
        droppedDocs,
        rebasedHeads,
      );

      // Empty-wave short-circuit — ONLY when there is truly nothing for
      // the store to see. A batch with preconditions still goes to the
      // sink even with zero ops: preconditions are commit GATES, and
      // short-circuiting them would resolve their contributions
      // committed without the engine ever validating the gate. A batch
      // with outbound appends goes too: the durable rows land inside
      // the wave's own transaction (FP1) — short-circuiting would lose
      // them.
      if (
        batch.operations.length === 0 && batch.consequenceOf.length === 0 &&
        batch.preconditions.length === 0 &&
        (batch.outboxAppends?.length ?? 0) === 0
      ) {
        this.#settleVerdicts(
          outcome,
          requeued,
          droppedWhole,
          droppedDocs,
          homeWrites,
          0,
          foreignSeqs,
        );
        return outcome;
      }

      // Tenure re-check before every home attempt (see the foreign-loop
      // note): the resolve loop may have awaited the sink several times.
      if (
        this.#lease !== undefined &&
        !this.#lease.isCurrentTenure(this.#sealedTenure)
      ) {
        for (const contribution of this.#contributions) {
          this.#withdraw(
            contribution,
            "lease lost mid-wave; the in-flight wave aborts " +
              "(serving-loop.md §2)",
          );
          outcome.dispositions[contribution.index] =
            contribution.context.kind === "event-handler"
              ? { kind: "requeued" }
              : { kind: "dropped" };
        }
        this.#reportRequeuedEvents(outcome, () => true);
        outcome.aborted = "lease-lost";
        return outcome;
      }
      const result = await sink.commitWave(batch);
      if (!result.error) {
        this.#settleVerdicts(
          outcome,
          requeued,
          droppedWhole,
          droppedDocs,
          homeWrites,
          result.ok.seq,
          foreignSeqs,
        );
        outcome.seq = result.ok.seq;
        return outcome;
      }

      // The sink re-verified inside its transaction and something moved
      // after our head query (or a precondition failed). Fold the news
      // in and resolve again; a rejection naming nothing is terminal.
      // This converges without timers: drops and requeues are monotone,
      // and a rebase re-decision runs only for a doc whose head actually
      // advanced — each pass observes strictly newer store state.
      const rejection = result.error;
      let progressed = false;
      const renamed: string[] = [];
      for (const key of rejection.conflictedDocs ?? []) {
        const wasRebased = rebasedHeads.has(key);
        if (!conflicted.has(key) || wasRebased) {
          conflicted.add(key);
          renamed.push(key);
          progressed = true;
        }
        if (wasRebased) {
          // The head moved past the rebase decision: the field-level
          // merge is void. Reset every contribution's rebase state for
          // this doc so the next resolve pass re-decides against the
          // new head (§3d's re-CAS).
          rebasedHeads.delete(key);
          for (const perContribution of rebasedDocs) {
            perContribution.delete(key);
          }
        }
      }
      for (const index of rejection.failedPreconditions ?? []) {
        const owner = batch.preconditionOwners?.[index];
        if (
          owner !== undefined && !requeued.has(owner) &&
          !droppedWhole.has(owner)
        ) {
          // A violated precondition (e.g. a create-only doc that appeared
          // mid-wave) is a semantic conflict for its contribution.
          if (this.#contributions[owner].context.kind === "event-handler") {
            requeued.add(owner);
          } else {
            droppedWhole.add(owner);
            outcome.dependencyDroppedWrites += this.#homeOpCount(
              this.#contributions[owner],
            );
          }
          progressed = true;
        }
      }
      if (!progressed) {
        logger.warn("wave-commit-rejected", () => [
          "wave commit rejected without resolvable conflicts",
          rejection.message,
        ]);
        for (const contribution of this.#contributions) {
          this.#withdraw(
            contribution,
            `wave commit rejected: ${rejection.message}`,
          );
          outcome.dispositions[contribution.index] =
            contribution.context.kind === "event-handler"
              ? { kind: "requeued" }
              : { kind: "dropped" };
        }
        this.#reportRequeuedEvents(outcome, () => true);
        outcome.aborted = "rejected";
        return outcome;
      }
      if (renamed.length > 0) {
        const fresh = await sink.currentHeads(
          this.#space,
          renamed.map((key) => allDocs.get(key)!).filter((doc) =>
            doc !== undefined
          ),
        );
        for (const [key, head] of fresh) heads.set(key, head);
      }
      await resolveConflicts();
    }
  }

  // ---- helpers ----

  #homeSealed(
    contribution: WaveContribution,
  ): SealedSpaceContribution | undefined {
    return contribution.spaces.find((s) => s.space === this.#space);
  }

  #foreignSealed(contribution: WaveContribution): SealedSpaceContribution[] {
    return contribution.spaces.filter((s) => s.space !== this.#space);
  }

  #homeDocInstances(
    contribution: WaveContribution,
  ): Map<string, { id: string; scope?: CellScope; scopeKey: string }> {
    const docs = new Map<
      string,
      { id: string; scope?: CellScope; scopeKey: string }
    >();
    const home = this.#homeSealed(contribution);
    if (home === undefined) return docs;
    for (const operation of home.sealed.commit.operations) {
      if (operation.op === "sqlite") continue;
      const scopeKey = this.#scopeKeyFor(operation.scope, contribution.context);
      docs.set(docInstanceKey(operation.id, scopeKey), {
        id: operation.id,
        scope: operation.scope,
        scopeKey,
      });
    }
    return docs;
  }

  /** M1 (scopes.md §5, §7): a run's scoped addresses resolve against the
   * PER-RUN identity its context carries — the demand's instance identity
   * for derivations, the stamped `firedAt` pair for handlers — falling
   * back to the wave-level identity (OFF-arm cardinality 1, and runs
   * with no scoped addresses). */
  #scopeKeyFor(
    scope: CellScope | undefined,
    context?: WaveRunContext,
  ): ScopeKey {
    return resolveScopeKey(
      scope,
      context?.scopeKeyIdentity ?? this.#scopeKeyIdentity,
    );
  }

  #homeOpCount(contribution: WaveContribution): number {
    const home = this.#homeSealed(contribution);
    if (home === undefined) return 0;
    return home.sealed.commit.operations.filter((op) => op.op !== "sqlite")
      .length;
  }

  #homeOpCountFor(
    contribution: WaveContribution,
    doc: { id: string; scope?: CellScope; scopeKey: string },
  ): number {
    const home = this.#homeSealed(contribution);
    if (home === undefined) return 0;
    return home.sealed.commit.operations.filter((op) =>
      op.op !== "sqlite" && op.id === doc.id &&
      this.#scopeKeyFor(op.scope, contribution.context) === doc.scopeKey
    ).length;
  }

  /** Field-level merge check (§3d): every op this contribution holds on
   * the conflicted doc must be a patch whose value paths are disjoint
   * from the concurrent commits' written paths. A whole-doc set or delete
   * never commutes; overlapping paths are a semantic conflict. */
  #rebases(
    contribution: WaveContribution,
    doc: { id: string; scope?: CellScope; scopeKey: string },
    concurrentPaths: ReadonlyArray<readonly string[]>,
  ): boolean {
    const home = this.#homeSealed(contribution);
    if (home === undefined) return true;
    for (const operation of home.sealed.commit.operations) {
      if (operation.op === "sqlite") continue;
      if (
        operation.id !== doc.id ||
        this.#scopeKeyFor(operation.scope, contribution.context) !==
          doc.scopeKey
      ) {
        continue;
      }
      if (operation.op !== "patch") return false;
      for (const patch of operation.patches) {
        const patchPath = parsePointer(patch.path);
        for (const concurrent of concurrentPaths) {
          if (!pathsOverlap(patchPath, concurrent)) continue;
          // Stream-sidecar refinement (Phase 3; events.md §4): the ONLY
          // concurrent writers a sidecar doc admits at `/value/entries`
          // are tail APPENDS — the authored shape guard refuses deeper
          // authored writes, whole-array rewrites, and deletes
          // (engine.ts validateEventAppends), and the loop's own derived
          // commits are self-echo-skipped. A tail append creates only
          // NEW indices, so an index-addressed consequence mark
          // (`/value/entries/<i>/...` for an entry that existed at the
          // wave basis) commutes with it — the general prefix-overlap
          // rule would requeue every event whose stream took a
          // concurrent fire, which the field-level merge exists to
          // avoid (serving-loop.md §3d).
          if (
            doc.id.startsWith(STREAM_ENTRIES_DOC_PREFIX) &&
            concurrent.length === 2 &&
            concurrent[0] === "value" &&
            concurrent[1] === "entries" &&
            patchPath.length > 2 &&
            String(Number(patchPath[2])) === String(patchPath[2])
          ) {
            continue;
          }
          return false;
        }
      }
    }
    return true;
  }

  /** Whether this contribution READ a sealed write that is being
   * withdrawn — in ANY space it sealed into, resolving each space's
   * pending-read layers against that space's own seals (localSeqs are
   * per-space counters). A withdrawn writer's foreign write never lands
   * (#buildForeignBatches excludes it), so a reader deriving from it
   * must fold in exactly like a home reader (§3d: no blind derived
   * writes). Bounded by what SEALS: the tx seals only spaces it wrote
   * (or gated), so a read in a space the run wrote nothing to never
   * reaches the accumulator — the third stage-D bound, documented at
   * the sink (engine-wave-sink.ts). */
  #readsWithdrawnContribution(
    contribution: WaveContribution,
    byLocalSeq: ReadonlyMap<MemorySpace, ReadonlyMap<number, number>>,
    sawWithdrawnWrite: (
      ownerIndex: number,
      readDocKey: string,
      readSpace: MemorySpace,
    ) => boolean,
  ): boolean {
    for (const spaceContribution of contribution.spaces) {
      const perSpace = byLocalSeq.get(spaceContribution.space);
      if (perSpace === undefined) continue;
      for (const read of spaceContribution.sealed.commit.reads.pending) {
        const layers = Array.isArray(read.localSeq)
          ? read.localSeq
          : [read.localSeq];
        const readDocKey = docInstanceKey(
          read.id,
          this.#scopeKeyFor(read.scope, contribution.context),
        );
        for (const layer of layers) {
          const owner = perSpace.get(layer);
          if (
            owner !== undefined &&
            sawWithdrawnWrite(owner, readDocKey, spaceContribution.space)
          ) {
            return true;
          }
        }
      }
    }
    return false;
  }

  #survivors(
    requeued: ReadonlySet<number>,
    droppedWhole: ReadonlySet<number>,
  ): WaveContribution[] {
    return this.#contributions.filter((c) =>
      !requeued.has(c.index) && !droppedWhole.has(c.index)
    );
  }

  #buildHomeBatch(
    requeued: ReadonlySet<number>,
    droppedWhole: ReadonlySet<number>,
    droppedDocs: ReadonlyArray<ReadonlySet<string>>,
    rebasedHeads: ReadonlyMap<string, number>,
  ): WaveSpaceCommit {
    const operations: Operation[] = [];
    const annotations: WaveWriteAnnotation[] = [];
    const preconditions: CommitPrecondition[] = [];
    const preconditionOwners: number[] = [];
    const consequenceOf: string[] = [];
    const sqliteScopeKeys: Array<{ op: number; scopeKey: ScopeKey }> = [];
    const outboxAppends: OutboxAppendRow[] = [];
    // §3b's overwrite unit: when one wave holds several runs of the same
    // (action, instance) — a later contribution re-ran the action against
    // earlier sealed writes — the LAST run's rows replace the earlier
    // run's as a set, exactly as they would across waves.
    const basisInstances = new Map<string, WaveBasisInstanceRows>();
    for (const contribution of this.#survivors(requeued, droppedWhole)) {
      const context = contribution.context;
      // FP1's fold completeness (the stage-G review's M-A): appends and
      // consequence coverage ride EVERY survivor — one that sealed only
      // FOREIGN spaces, or sealed nothing at all (the zero-seal emitter
      // minted in seal()), still lands its cross-space appends as
      // durable rows in THIS home transaction and its eventId in the
      // commit's consequenceOf. The model is explicit: its
      // cascadesCross and consequenceOf folds run for every COMMITTED
      // contribution, writes or not — gating them on a home seal lost
      // both silently for the foreign-only and zero-seal shapes. A
      // withdrawn contribution's appends still never ride (the
      // survivors filter above): its event replays and re-emits.
      if (context.kind === "event-handler" && context.eventId !== undefined) {
        consequenceOf.push(context.eventId);
      }
      outboxAppends.push(...contribution.outboundAppends);
      const home = this.#homeSealed(contribution);
      if (home === undefined) continue;
      for (const operation of home.sealed.commit.operations) {
        if (operation.op !== "sqlite") {
          const key = docInstanceKey(
            operation.id,
            this.#scopeKeyFor(operation.scope, context),
          );
          if (droppedDocs[contribution.index].has(key)) continue;
        }
        const opIndex = operations.length;
        operations.push(operation);
        if (operation.op === "sqlite") {
          // The sqlite bound's discharge (stage G): the db file a folded
          // op targets is keyed per scope INSTANCE, resolved against the
          // RUN's identity exactly like the run's scoped cell writes (M1
          // — the wave envelope has no session to resolve it from). The
          // sink attaches the matching file(s) before its transaction.
          sqliteScopeKeys.push({
            op: opIndex,
            scopeKey: this.#scopeKeyFor(operation.db.scope, context),
          });
        }
        if (operation.op !== "sqlite") {
          const scoped = operation.scope !== undefined &&
            operation.scope !== "space";
          if (scoped || context.acting !== undefined) {
            annotations.push({
              op: opIndex,
              ...(scoped
                ? { scopeKey: this.#scopeKeyFor(operation.scope, context) }
                : {}),
              ...(context.acting !== undefined
                ? {
                  actingUser: context.acting.user,
                  ...(context.acting.session !== undefined
                    ? { actingSession: context.acting.session }
                    : {}),
                }
                : {}),
            });
          }
        }
      }
      for (const precondition of home.sealed.commit.preconditions ?? []) {
        preconditions.push(precondition);
        preconditionOwners.push(contribution.index);
      }
      // Every survivor lands its basis rows — including one whose writes
      // were dropped per-doc as superseded: its reads are true, and no
      // recompute-owed mark exists (§3d, RULED 2026-08-05).
      const actionScopeKey = context.actionScopeKey ?? "space";
      basisInstances.set(`${context.actionId} ${actionScopeKey}`, {
        action: context.actionId,
        actionScopeKey,
        rows: this.#basisRowsFor(contribution),
      });
    }
    // Same-space emitted entries (LT1): every surviving op that appends
    // a seq-LESS entry into a stream sidecar carries a NEW event — the
    // engine's admission requires its declaration to stamp the stream
    // seq (a rewrite — an already-stamped entry — needs none). An
    // entry whose event was PROCESSED IN THIS WAVE — a surviving
    // event-handler contribution carries its eventId — is marked
    // `consequenced` in the batch op (a CLONE; the sealed arrays are
    // caller-shared), so the entry and its consequences commit
    // together (events.md §2's "an entry processed in its own wave
    // commits together with its consequences"; the engine admits
    // derived new appends already consequenced). A run that REQUEUED
    // is not a survivor: its entry lands unmarked and the next wave's
    // drain re-runs it (C8b); an emitter that requeued withdrew the
    // entry with its contribution (C8d).
    const survivedEventIds = new Set<string>();
    for (const contribution of this.#survivors(requeued, droppedWhole)) {
      if (
        contribution.context.kind === "event-handler" &&
        contribution.context.eventId !== undefined
      ) {
        survivedEventIds.add(contribution.context.eventId);
      }
    }
    const eventAppends: Array<{ id: string; eventId: string }> = [];
    // A fresh entry list whose OBJECT entries are shallow-copied: the
    // consequenced mark below lands on the copies while every deeper
    // value (payload included) stays SHARED by reference.
    const spineCloneEntryList = (entries: readonly unknown[]): unknown[] =>
      entries.map((entry) =>
        entry !== null && typeof entry === "object" && !Array.isArray(entry)
          ? { ...(entry as Record<string, unknown>) }
          : entry
      );
    for (const [opIndex, original] of operations.entries()) {
      if (original.op === "sqlite" || original.op === "delete") continue;
      if (!original.id.startsWith(STREAM_ENTRIES_DOC_PREFIX)) continue;
      // Clone before any possible mark: the batch holds the SEALED
      // commits' own op objects (shared with replica overlays). Only
      // the SPINE is cloned — the op object, the containers down to
      // `/value/entries`, and the entry objects — NEVER
      // `structuredClone` (verdict blocker, 2026-08-12): event payloads
      // are FabricValues that can carry registry symbols, which
      // `structuredClone` refuses with `DataCloneError`, aborting wave
      // assembly for a valid event; cells it can copy get demoted.
      const entryLists: unknown[][] = [];
      let operation = original;
      if (original.op === "set") {
        const outer = original.value as
          | { value?: { entries?: unknown[] } }
          | undefined;
        const inner = outer?.value;
        if (Array.isArray(inner?.entries)) {
          const entries = spineCloneEntryList(inner.entries);
          operation = {
            ...original,
            value: { ...outer, value: { ...inner, entries } } as never,
          };
          entryLists.push(entries);
        }
      } else if (original.op === "patch") {
        const patches = original.patches.map((patch) => {
          if (
            (patch.op === "append" || patch.op === "add-unique") &&
            patch.path === "/value/entries"
          ) {
            const values = spineCloneEntryList(patch.values as unknown[]);
            entryLists.push(values);
            return { ...patch, values: values as never };
          }
          if (
            (patch.op === "add" || patch.op === "replace") &&
            patch.path === "/value/entries" &&
            Array.isArray((patch as unknown as { value?: unknown }).value)
          ) {
            const values = spineCloneEntryList(
              (patch as unknown as { value: unknown[] }).value,
            );
            entryLists.push(values);
            return { ...patch, value: values as never };
          }
          return patch;
        });
        operation = { ...original, patches };
      }
      operations[opIndex] = operation;
      for (const list of entryLists) {
        for (const [entryIndex, candidate] of list.entries()) {
          const entry = candidate as {
            eventId?: string;
            seq?: number;
            consequenced?: boolean;
          } | null;
          if (
            entry === null || typeof entry !== "object" ||
            typeof entry.eventId !== "string" || entry.seq !== undefined
          ) {
            continue;
          }
          if (
            !eventAppends.some((decl) =>
              decl.id === operation.id && decl.eventId === entry.eventId
            )
          ) {
            eventAppends.push({
              id: operation.id,
              eventId: entry.eventId,
            });
          }
          if (
            entry.consequenced !== true &&
            survivedEventIds.has(entry.eventId)
          ) {
            // Same-wave processing: mark the CLONE in place. `list` is
            // the spine clone's own array (spineCloneEntryList above),
            // so the sealed originals stay pristine.
            (list[entryIndex] as { consequenced?: boolean })
              .consequenced = true;
          }
        }
      }
    }
    // The rebased ops stay in the batch; the sink re-verifies each
    // rebased doc still sits at the head the merge decision observed.
    return {
      space: this.#space,
      home: true,
      ...(eventAppends.length === 0 ? {} : { eventAppends }),
      basisSeq: this.#basisSeq,
      rebasedHeads: [...rebasedHeads.entries()].map(([doc, head]) => ({
        doc,
        head,
      })),
      operations,
      preconditions,
      preconditionOwners,
      annotations,
      consequenceOf,
      basisInstances: [...basisInstances.values()],
      holder: this.#lease?.holder,
      ...(this.#derivedThrough === undefined
        ? {}
        : { derivedThrough: this.#derivedThrough }),
      ...(sqliteScopeKeys.length === 0 ? {} : { sqliteScopeKeys }),
      ...(outboxAppends.length === 0 ? {} : { outboxAppends }),
    };
  }

  /** The delegated-identity carriage a contribution's foreign batch
   * carries (protocol.md §2's server-produced authored row): ONE
   * originating chain actor + ONE grant, or none. */
  #delegatedFor(context: WaveRunContext): {
    actingPrincipal: string;
    actingSession?: string;
    capabilityRef: string;
  } | undefined {
    return context.acting !== undefined && context.capabilityRef !== undefined
      ? {
        actingPrincipal: context.acting.user,
        ...(context.acting.session !== undefined
          ? { actingSession: context.acting.session }
          : {}),
        capabilityRef: context.capabilityRef,
      }
      : undefined;
  }

  /** The foreign-batch grouping key — (space, acting identity, grant).
   * ONE construction, shared by the batch builder and the verdict
   * settlement, so a contribution always resolves with the seq of the
   * batch its ops actually rode. */
  #foreignBatchKeyFor(space: MemorySpace, context: WaveRunContext): string {
    const delegated = this.#delegatedFor(context);
    return `${space}\0${
      delegated === undefined ? "" : JSON.stringify(delegated)
    }`;
  }

  #buildForeignBatches(
    requeued: ReadonlySet<number>,
    droppedWhole: ReadonlySet<number>,
  ): Array<{ key: string; batch: WaveSpaceCommit }> {
    // One batch per (space, acting identity, capability grant): a foreign
    // provisioning commit carries ONE originating chain actor + ONE
    // grant in its metadata (protocol.md §2's server-produced authored
    // row, §2b), so contributions acting as different principals never
    // share a commit.
    const batches = new Map<string, WaveSpaceCommit>();
    for (const contribution of this.#survivors(requeued, droppedWhole)) {
      for (const sealed of this.#foreignSealed(contribution)) {
        const context = contribution.context;
        const delegated = this.#delegatedFor(context);
        const batchKey = this.#foreignBatchKeyFor(sealed.space, context);
        let batch = batches.get(batchKey);
        if (batch === undefined) {
          batch = {
            space: sealed.space,
            home: false,
            basisSeq: this.#basisSeq,
            rebasedHeads: [],
            operations: [],
            preconditions: [],
            annotations: [],
            consequenceOf: [],
            basisInstances: [],
            holder: this.#lease?.holder,
            ...(delegated === undefined ? {} : { delegated }),
          };
          batches.set(batchKey, batch);
        }
        // No per-op annotations on a foreign batch: the annotation pair
        // is DERIVED-only carriage (protocol.md §7's closed list). The
        // delegated identity rides ONCE in the batch's commit metadata,
        // and the engine's delegated admission keys scoped writes from
        // that validated CARRIED identity (scopes.md §5: consequences
        // land in the actor's instances) — which is why batches group
        // per (space, actor, grant) above.
        for (const operation of sealed.sealed.commit.operations) {
          batch.operations.push(operation);
        }
        batch.preconditions.push(...sealed.sealed.commit.preconditions ?? []);
      }
    }
    return [...batches.entries()].map(([key, batch]) => ({ key, batch }));
  }

  /** Basis rows (§3b) for one surviving contribution: doc-granular
   * ids + seqs from the sealed commit's read set — confirmed reads carry
   * their store version; in-wave pending reads share the wave's own
   * commit seq (`seq: null`, filled by the sink). */
  #basisRowsFor(contribution: WaveContribution): SchedulerBasisRow[] {
    const context = contribution.context;
    const actionScopeKey = context.actionScopeKey ?? "space";
    const rows = new Map<string, SchedulerBasisRow>();
    for (const spaceContribution of contribution.spaces) {
      const reads = spaceContribution.sealed.commit.reads;
      for (const read of reads.confirmed) {
        const entityScopeKey = this.#scopeKeyFor(
          read.scope,
          contribution.context,
        );
        rows.set(`${spaceContribution.space} ${read.id} ${entityScopeKey}`, {
          action: context.actionId,
          actionScopeKey,
          entitySpace: spaceContribution.space,
          entity: read.id,
          entityScopeKey,
          seq: read.seq,
        });
      }
      for (const read of reads.pending) {
        const entityScopeKey = this.#scopeKeyFor(
          read.scope,
          contribution.context,
        );
        rows.set(`${spaceContribution.space} ${read.id} ${entityScopeKey}`, {
          action: context.actionId,
          actionScopeKey,
          entitySpace: spaceContribution.space,
          entity: read.id,
          entityScopeKey,
          seq: null,
        });
      }
    }
    return [...rows.values()];
  }

  #settleVerdicts(
    outcome: WaveCommitOutcome,
    requeued: ReadonlySet<number>,
    droppedWhole: ReadonlySet<number>,
    droppedDocs: ReadonlyArray<ReadonlySet<string>>,
    homeWrites: ReadonlyArray<
      ReadonlyMap<string, { id: string; scope?: CellScope; scopeKey: string }>
    >,
    homeSeq: number,
    foreignSeqs: ReadonlyMap<string, number>,
  ): void {
    this.#reportRequeuedEvents(outcome, (idx) => requeued.has(idx));
    for (const contribution of this.#contributions) {
      const idx = contribution.index;
      const context = contribution.context;
      if (requeued.has(idx)) {
        outcome.dispositions[idx] = { kind: "requeued" };
        // The withdraw rolls back every space's local overlay, foreign
        // included — a foreign provisioning commit that already landed
        // stays durable, and the requeued event's replay converges on
        // the same deterministic ids (protocol.md §2b).
        this.#withdraw(
          contribution,
          "raced consequence requeued: rolled back to unconsequenced, " +
            "retried in a later wave (serving-loop.md §3d)",
        );
        continue;
      }
      if (droppedWhole.has(idx)) {
        outcome.dispositions[idx] = { kind: "dropped" };
        this.#withdraw(
          contribution,
          "pure derivation dropped: derived from a withdrawn contribution; " +
            "its own reads re-run it when fresh state lands " +
            "(serving-loop.md §3d)",
        );
        continue;
      }
      if (droppedDocs[idx].size > 0) {
        let droppedOps = 0;
        for (const key of droppedDocs[idx]) {
          const doc = homeWrites[idx].get(key);
          if (doc !== undefined) {
            droppedOps += this.#homeOpCountFor(contribution, doc);
          }
        }
        const allDropped = droppedDocs[idx].size === homeWrites[idx].size &&
          contribution.spaces.length === 1;
        outcome.dispositions[idx] = allDropped
          ? { kind: "dropped" }
          : { kind: "partially-dropped", droppedOps };
        // Any surviving ops rode the wave commit; the sealed commit's own
        // overlay rolls back whole and reconverges from the wave commit
        // (or, all-dropped, from the superseding authored commit) arriving
        // as confirmed state.
        this.#withdraw(
          contribution,
          "superseded pure derivation writes dropped from the wave commit " +
            "(serving-loop.md §3d)",
        );
        continue;
      }
      outcome.dispositions[idx] = { kind: "committed" };
      if (context.kind === "event-handler" && context.eventId !== undefined) {
        outcome.committedEventIds.push(context.eventId);
      }
      for (const space of contribution.spaces) {
        const seq = space.space === this.#space ? homeSeq : foreignSeqs.get(
          this.#foreignBatchKeyFor(space.space, context),
        ) ?? homeSeq;
        space.resolveVerdict({ committed: { seq } });
      }
    }
  }

  #abortAfterForeignFailure(outcome: WaveCommitOutcome): void {
    for (const contribution of this.#contributions) {
      const idx = contribution.index;
      this.#withdraw(
        contribution,
        "foreign provisioning commit failed; home commit withheld — the " +
          "event stays unconsequenced and replays (protocol.md §2b)",
      );
      outcome.dispositions[idx] = contribution.context.kind === "event-handler"
        ? { kind: "requeued" }
        : { kind: "dropped" };
    }
    this.#reportRequeuedEvents(outcome, () => true);
  }

  /**
   * Report requeued events for the serving loop to retry — SURVIVING
   * requeues only, matching the model's C8d rollback closure: a
   * same-wave cascade child of a requeued parent never got a durable
   * stream entry, so it has nothing to retry — the parent's re-run
   * re-mints it with a fresh id. Reporting it would make the loop retry
   * an event that does not exist.
   */
  #reportRequeuedEvents(
    outcome: WaveCommitOutcome,
    isRequeued: (index: number) => boolean,
  ): void {
    for (const contribution of this.#contributions) {
      const context = contribution.context;
      if (
        context.kind !== "event-handler" || context.eventId === undefined ||
        !isRequeued(contribution.index)
      ) {
        continue;
      }
      const parentAlsoRequeued = context.parentEventId !== undefined &&
        this.#contributions.some((c) =>
          c.context.eventId === context.parentEventId &&
          isRequeued(c.index)
        );
      if (!parentAlsoRequeued) {
        outcome.requeuedEventIds.push(context.eventId);
      }
    }
  }
}
