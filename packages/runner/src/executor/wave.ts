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
import type {
  CommitPrecondition,
  DerivedWriteAnnotation,
  Operation,
} from "@commonfabric/memory/v2";
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
 *   never lost) when the rebase conflicts semantically.
 *
 * The other non-re-derivable class members §3d names — `eventWatermark`
 * advances and effect intents — are produced by the serving loop (stage F)
 * and the effect channel (stage G); they seal as contributions of this
 * same class when their producers exist.
 */
export type WaveRunKind = "derivation" | "event-handler";

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
  /** The same-wave parent event of a cascade-minted event: a requeued
   * parent folds this contribution into the requeue set (§3d; the
   * model's C8d rollback closure). */
  parentEventId?: string;
  /** The scope INSTANCE this run ran as, for basis rows' action_scope_key.
   * Defaults to `"space"` — the pre-narrowing instance. Stage E re-keys
   * the vocabulary per instance; until then, at OFF-arm cardinality 1, the
   * instance dimension is derivable from the runtime's own authenticated
   * session (plan Phase 1 stage E). */
  actionScopeKey?: string;
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
  return waveRunContexts.get(tx);
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
  actionScopeKey: string;
  entitySpace: MemorySpace;
  entity: string;
  entityScopeKey: string;
  seq: number | null;
}

/** One §3b overwrite unit of the wave's basis-index carriage: the LAST
 * run of (action, actionScopeKey) in the wave, whose rows replace that
 * instance's stored set. */
export interface WaveBasisInstanceRows {
  action: string;
  actionScopeKey: string;
  rows: SchedulerBasisRow[];
}

/** The batched commit the wave hands the sink, per space. */
export interface WaveSpaceCommit {
  space: MemorySpace;
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
  context: WaveRunContext;
  spaces: SealedSpaceContribution[];
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
  readonly #resolveScopeKey: (scope: CellScope) => string;
  readonly #replicaFor: (space: MemorySpace) => ISpaceReplica;
  readonly #lease: WaveLease | undefined;
  readonly #sealedTenure: number;
  #contributions: WaveContribution[] = [];
  #assembly: PendingAssembly | undefined;
  #closed = false;

  constructor(options: {
    /** The home space this wave derives for. */
    space: MemorySpace;
    /** Store seq of the wave's input snapshot: the per-doc CAS basis
     * (serving-loop.md §3b's snapshot discipline — mid-wave commits are
     * the NEXT wave's input). */
    basisSeq: number;
    /** Maps a scope KIND to the concrete instance key. At OFF-arm
     * cardinality 1 the identity is the runtime's own authenticated
     * session (key-vocabulary.md §3); stage E moves the vocabulary to the
     * wire-shape module and feeds per-instance values. */
    resolveScopeKey: (scope: CellScope) => string;
    replicaFor: (space: MemorySpace) => ISpaceReplica;
    lease?: WaveLease;
  }) {
    this.#space = options.space;
    this.#basisSeq = options.basisSeq;
    this.#resolveScopeKey = options.resolveScopeKey;
    this.#replicaFor = options.replicaFor;
    this.#lease = options.lease;
    this.#sealedTenure = options.lease?.tenure ?? 0;
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
    if (context === undefined) {
      // No anonymous fallback (serving-loop.md §3d, RULED 2026-08-05):
      // an unstamped seal is a wave-host bug — every server-side commit
      // path stamps its run context before sealing, and stage F names
      // the sanctioned internal stamp kinds when it installs the seal
      // destination. Unreachable from the OFF arm: without a
      // destination installed, seal == commit and this class never
      // runs.
      throw new Error(
        "unstamped transaction sealed into a wave: stamp the run " +
          "context (stampWaveRunContext) before sealing — every " +
          "server-side commit path declares its run context " +
          "(serving-loop.md §3d, RULED 2026-08-05)",
      );
    }
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
      // contributes nothing — same as commit's empty-transaction fast
      // path.
      if (assembly.spaces.length > 0) {
        this.#contributions.push({
          index: this.#contributions.length,
          context: assembly.context,
          spaces: assembly.spaces,
        });
      }
      return result;
    } finally {
      this.#assembly = undefined;
    }
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
  async commitWave(sink: WaveCommitSink): Promise<WaveCommitOutcome> {
    if (this.#closed) {
      throw new Error("wave already committed or abandoned");
    }
    this.#closed = true;
    const outcome: WaveCommitOutcome = {
      supersededWrites: 0,
      dependencyDroppedWrites: 0,
      requeuedEventIds: [],
      committedEventIds: [],
      dispositions: this.#contributions.map(() => ({ kind: "committed" })),
    };

    // The lease check (serving-loop.md §2's stop-committing MUST): work
    // sealed under a lapsed tenure never commits — recovery under the
    // next tenure re-marks and re-runs from the basis index instead.
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
            // Non-re-derivable consequence: rebase against the new head —
            // field-level merge for writes that commute with the
            // concurrent commit; a semantic conflict requeues the event.
            const concurrent = await sink.concurrentWritePaths(
              this.#space,
              doc,
              this.#basisSeq,
            );
            if (this.#rebases(contribution, doc, concurrent)) {
              rebasedDocs[contribution.index].add(key);
              rebasedHeads.set(key, heads.get(key) ?? 0);
            } else {
              requeued.add(contribution.index);
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
          );
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
    const foreignSeqs = new Map<MemorySpace, number>();
    for (const batch of this.#buildForeignBatches(requeued, droppedWhole)) {
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
      foreignSeqs.set(batch.space, result.ok.seq);
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
      // committed without the engine ever validating the gate.
      if (
        batch.operations.length === 0 && batch.consequenceOf.length === 0 &&
        batch.preconditions.length === 0
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
      const scopeKey = this.#scopeKeyFor(operation.scope);
      docs.set(docInstanceKey(operation.id, scopeKey), {
        id: operation.id,
        scope: operation.scope,
        scopeKey,
      });
    }
    return docs;
  }

  #scopeKeyFor(scope: CellScope | undefined): string {
    return scope === undefined || scope === "space"
      ? "space"
      : this.#resolveScopeKey(scope);
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
      this.#scopeKeyFor(op.scope) === doc.scopeKey
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
        this.#scopeKeyFor(operation.scope) !== doc.scopeKey
      ) {
        continue;
      }
      if (operation.op !== "patch") return false;
      for (const patch of operation.patches) {
        const patchPath = parsePointer(patch.path);
        for (const concurrent of concurrentPaths) {
          if (pathsOverlap(patchPath, concurrent)) return false;
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
          this.#scopeKeyFor(read.scope),
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
    // §3b's overwrite unit: when one wave holds several runs of the same
    // (action, instance) — a later contribution re-ran the action against
    // earlier sealed writes — the LAST run's rows replace the earlier
    // run's as a set, exactly as they would across waves.
    const basisInstances = new Map<string, WaveBasisInstanceRows>();
    for (const contribution of this.#survivors(requeued, droppedWhole)) {
      const home = this.#homeSealed(contribution);
      if (home === undefined) continue;
      const context = contribution.context;
      for (const operation of home.sealed.commit.operations) {
        if (operation.op !== "sqlite") {
          const key = docInstanceKey(
            operation.id,
            this.#scopeKeyFor(operation.scope),
          );
          if (droppedDocs[contribution.index].has(key)) continue;
        }
        const opIndex = operations.length;
        operations.push(operation);
        if (operation.op !== "sqlite") {
          const scoped = operation.scope !== undefined &&
            operation.scope !== "space";
          if (scoped || context.acting !== undefined) {
            annotations.push({
              op: opIndex,
              ...(scoped
                ? { scopeKey: this.#scopeKeyFor(operation.scope) }
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
      if (context.kind === "event-handler" && context.eventId !== undefined) {
        consequenceOf.push(context.eventId);
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
    // The rebased ops stay in the batch; the sink re-verifies each
    // rebased doc still sits at the head the merge decision observed.
    return {
      space: this.#space,
      home: true,
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
    };
  }

  #buildForeignBatches(
    requeued: ReadonlySet<number>,
    droppedWhole: ReadonlySet<number>,
  ): WaveSpaceCommit[] {
    const batches = new Map<MemorySpace, WaveSpaceCommit>();
    for (const contribution of this.#survivors(requeued, droppedWhole)) {
      for (const sealed of this.#foreignSealed(contribution)) {
        let batch = batches.get(sealed.space);
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
          };
          batches.set(sealed.space, batch);
        }
        const context = contribution.context;
        for (const operation of sealed.sealed.commit.operations) {
          const opIndex = batch.operations.length;
          batch.operations.push(operation);
          if (context.acting !== undefined && operation.op !== "sqlite") {
            batch.annotations.push({
              op: opIndex,
              actingUser: context.acting.user,
              ...(context.acting.session !== undefined
                ? { actingSession: context.acting.session }
                : {}),
            });
          }
        }
        batch.preconditions.push(...sealed.sealed.commit.preconditions ?? []);
      }
    }
    return [...batches.values()];
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
        const entityScopeKey = this.#scopeKeyFor(read.scope);
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
        const entityScopeKey = this.#scopeKeyFor(read.scope);
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
    foreignSeqs: ReadonlyMap<MemorySpace, number>,
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
        const seq = space.space === this.#space
          ? homeSeq
          : foreignSeqs.get(space.space) ?? homeSeq;
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
