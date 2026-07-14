import type { BranchName, ExecutionLease } from "@commonfabric/memory/v2";
import type {
  AcceptedCommitEvent,
  AcceptedCommitListener,
  ExecutionDemandListener,
  ExecutionDemandSnapshot,
  ExecutionLeaseHandle,
} from "@commonfabric/memory/v2/server";
import { getLogger } from "@commonfabric/utils/logger";

const logger = getLogger("execution.pool", { enabled: false });

export interface ExecutionPoolControl {
  subscribeExecutionDemands(listener: ExecutionDemandListener): () => void;
  subscribeAcceptedCommits(
    space: string,
    listener: AcceptedCommitListener,
  ): () => void;
  /** Durable legacy owner query. Missing support must fail closed. */
  legacyBackgroundActive?(
    space: string,
    branch: BranchName,
  ): Promise<boolean> | boolean;
  acquireExecutionLease(
    space: string,
    branch: BranchName,
    options?: { preferredOriginSessionId?: string },
  ): Promise<ExecutionLeaseHandle | null>;
  renewExecutionLease(
    lease: ExecutionLeaseHandle,
  ): Promise<ExecutionLeaseHandle | null>;
  beginExecutionLeaseDrain(
    lease: ExecutionLeaseHandle,
  ): Promise<ExecutionLeaseHandle | null>;
  finishExecutionLeaseDrain(
    lease: ExecutionLeaseHandle,
  ): Promise<ExecutionLease | null>;
}

export interface SpaceExecutor {
  /** Replace the union of demanded piece roots without restarting the realm. */
  setDemand(pieces: readonly string[]): Promise<void>;
  /** Pull the current demanded roots after an accepted input invalidation. */
  wake(): Promise<void>;
  /** Settle outstanding local work and return its accepted sequence barrier. */
  settle(): Promise<number>;
  /** Tear down the isolated runtime, optionally without another settle pass. */
  stop(options?: { abrupt?: boolean }): Promise<void>;
  /** Latest cumulative counters for this Worker generation. Older executor
   * implementations may omit the diagnostic without affecting execution. */
  executionMetrics?(): ExecutorExecutionMetricsSnapshot;
}

export interface ExecutorExecutionMetricsSnapshot {
  /** Completed scheduler actions, including runs that produced no routeable
   * action transaction. */
  readonly schedulerRuns: number;
  /** Server-role async builtin requests started by this executor generation. */
  readonly asyncRequests: number;
  /** Complete action transactions classified by the executor storage router.
   * These are not settlement counts and must not be compared one-to-one with
   * client overlays or coalesced server settlements. */
  readonly actionTransactions: Readonly<{
    shadow: number;
    authoritative: number;
  }>;
}

export interface SpaceExecutorStartOptions {
  readonly space: string;
  readonly branch: BranchName;
  readonly lease: ExecutionLeaseHandle;
  readonly pieces: readonly string[];
  /** Pool-owned cancellation for a generation that has not finished starting. */
  readonly signal?: AbortSignal;
  /** Terminal realm failure. The pool fences this generation before retry. */
  readonly onCrash: (error: unknown) => void;
}

export interface SpaceExecutorFactory {
  start(options: SpaceExecutorStartOptions): Promise<SpaceExecutor>;
}

export interface SharedExecutionPoolOptions {
  control: ExecutionPoolControl;
  factory: SpaceExecutorFactory;
  /** Mandatory Phase-1 interlock. Errors fail closed. */
  legacyBackgroundActive?: (
    space: string,
    branch: BranchName,
  ) => Promise<boolean> | boolean;
  /** Clock/timer seams keep lease lifecycle tests deterministic. */
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => number;
  clearTimer?: (timer: number) => void;
  crashBackoffBaseMs?: number;
  crashBackoffMaxMs?: number;
  /** Maximum graceful-settle window before the generation is fenced. */
  settleTimeoutMs?: number;
}

export interface SpaceExecutionSnapshot {
  readonly state:
    | "waiting"
    | "excluded"
    | "starting"
    | "live"
    | "draining"
    | "backoff";
  readonly referenceCount: number;
  readonly pieces: readonly string[];
  readonly leaseGeneration?: number;
}

export interface ExecutionPoolMetricsSnapshot {
  readonly activeLanes: number;
  readonly activeWorkers: number;
  readonly activeDemands: number;
  readonly states: Readonly<Record<SpaceExecutionSnapshot["state"], number>>;
  readonly demandSnapshots: number;
  /** Lifetime placement totals, including active and retired generations. */
  readonly executionPlacement: ExecutorExecutionMetricsSnapshot;
  /** Worker factory calls begun, including attempts still in flight. */
  readonly workerStartAttempts: number;
  /** Starts cancelled by pool lifecycle or a superseding demand snapshot. */
  readonly workerStartAborts: number;
  /** Starts rejected for reasons other than pool cancellation. */
  readonly workerStartFailures: number;
  /** Worker generations that reached the live state. */
  readonly workersStarted: number;
  readonly workersStopped: number;
  readonly abruptStops: number;
  readonly leaseLosses: number;
  readonly leaseReplacements: number;
  readonly sponsorRotations: number;
  readonly crashes: number;
  /** Per-lane accepted-commit callbacks received while the lane remains
   * mapped, including callbacks later rejected by branch/state filters. */
  readonly acceptedCommitNotifications: number;
  /** Exact-lane host-index results inspected from notifications. This does
   * not issue another index query. */
  readonly acceptedCommitIndexDecisions: number;
  /** Exact-lane host-index results with no stale demanded readers. */
  readonly suppressedUnrelatedCommits: number;
  /** Coalesced reconciliation passes queued for indexed-relevant
   * executor-null/draining lanes. */
  readonly parkedWakeAttempts: number;
  /** Worker generations made live after cold acquisition began with a pending
   * indexed-relevant commit wake. */
  readonly parkedWakeStarts: number;
  /** Demand-empty drains that remained empty and gracefully settled, stopped,
   * and released their lease. */
  readonly demandEmptyHibernations: number;
}

type Slot = {
  readonly key: string;
  readonly space: string;
  readonly branch: BranchName;
  order: number;
  demands: ExecutionDemandSnapshot["demands"];
  pieces: string[];
  state: SpaceExecutionSnapshot["state"];
  lease: ExecutionLeaseHandle | null;
  executor: SpaceExecutor | null;
  generationToken: object | null;
  crashToken: object | null;
  startupAbort: AbortController | null;
  renewTimer: number | null;
  backoffTimer: number | null;
  crashAttempts: number;
  lastLeaseGeneration?: number;
  lastSponsor?: string;
  unsubscribeAcceptedCommits: (() => void) | null;
  lastSettledSeq: number;
  pendingWakeSeq: number | null;
  pendingWakeStartedAt: number | null;
  preferredOriginSessionId?: string;
  acceptedWakeQueued: boolean;
  tail: Promise<void>;
};

const laneKey = (space: string, branch: BranchName): string =>
  JSON.stringify([space, branch]);

const unionPieces = (
  demands: ExecutionDemandSnapshot["demands"],
): string[] => [...new Set(demands.flatMap((demand) => demand.pieces))].sort();

const sameStrings = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

/**
 * Host-local demand coordinator. A lane is branch-qualified and owns at most
 * one isolated Runtime generation regardless of how many client connections
 * reference its roots. Durable lease fencing remains the cross-host owner.
 */
export class SharedExecutionPool {
  readonly #control: ExecutionPoolControl;
  readonly #factory: SpaceExecutorFactory;
  readonly #legacyBackgroundActive: NonNullable<
    SharedExecutionPoolOptions["legacyBackgroundActive"]
  >;
  readonly #now: () => number;
  readonly #setTimer: (callback: () => void, delayMs: number) => number;
  readonly #clearTimer: (timer: number) => void;
  readonly #crashBackoffBaseMs: number;
  readonly #crashBackoffMaxMs: number;
  readonly #settleTimeoutMs: number;
  readonly #slots = new Map<string, Slot>();
  readonly #tasks = new Set<Promise<void>>();
  readonly #retiredExecutionPlacement = {
    schedulerRuns: 0,
    asyncRequests: 0,
    shadowActionTransactions: 0,
    authoritativeActionTransactions: 0,
  };
  readonly #metrics = {
    demandSnapshots: 0,
    workerStartAttempts: 0,
    workerStartAborts: 0,
    workerStartFailures: 0,
    workersStarted: 0,
    workersStopped: 0,
    abruptStops: 0,
    leaseLosses: 0,
    leaseReplacements: 0,
    sponsorRotations: 0,
    crashes: 0,
    acceptedCommitNotifications: 0,
    acceptedCommitIndexDecisions: 0,
    suppressedUnrelatedCommits: 0,
    parkedWakeAttempts: 0,
    parkedWakeStarts: 0,
    demandEmptyHibernations: 0,
  };
  #unsubscribe: (() => void) | null = null;
  #closed = false;

  constructor(options: SharedExecutionPoolOptions) {
    this.#control = options.control;
    this.#factory = options.factory;
    const legacyBackgroundActive = options.legacyBackgroundActive ??
      options.control.legacyBackgroundActive?.bind(options.control);
    this.#legacyBackgroundActive = legacyBackgroundActive ?? (() => true);
    this.#now = options.now ?? Date.now;
    this.#setTimer = options.setTimer ??
      ((callback, delayMs) =>
        setTimeout(callback, delayMs) as unknown as number);
    this.#clearTimer = options.clearTimer ??
      ((timer) =>
        clearTimeout(timer as unknown as ReturnType<typeof setTimeout>));
    // A crashed Worker has no recovery event to await; bounded exponential
    // backoff prevents a bad graph or host dependency from hot-spinning.
    this.#crashBackoffBaseMs = options.crashBackoffBaseMs ?? 1_000;
    this.#crashBackoffMaxMs = options.crashBackoffMaxMs ?? 30_000;
    // Graceful drain may legitimately stop making progress. At this safety
    // bound we fence the lease and recompute from durable state; the cost is
    // redundant work, never acceptance under expired authority.
    this.#settleTimeoutMs = options.settleTimeoutMs ?? 60_000;
  }

  start(): void {
    if (this.#closed) throw new Error("execution pool is closed");
    if (this.#unsubscribe !== null) return;
    this.#unsubscribe = this.#control.subscribeExecutionDemands((snapshot) =>
      this.#acceptDemandSnapshot(snapshot)
    );
  }

  snapshot(
    space: string,
    branch: BranchName,
  ): SpaceExecutionSnapshot | undefined {
    const slot = this.#slots.get(laneKey(space, branch));
    if (slot === undefined) return undefined;
    return {
      state: slot.state,
      referenceCount: slot.demands.length,
      pieces: [...slot.pieces],
      ...(slot.lease !== null
        ? { leaseGeneration: slot.lease.leaseGeneration }
        : {}),
    };
  }

  metrics(): ExecutionPoolMetricsSnapshot {
    const states: Record<SpaceExecutionSnapshot["state"], number> = {
      waiting: 0,
      excluded: 0,
      starting: 0,
      live: 0,
      draining: 0,
      backoff: 0,
    };
    let activeWorkers = 0;
    let activeDemands = 0;
    let schedulerRuns = this.#retiredExecutionPlacement.schedulerRuns;
    let asyncRequests = this.#retiredExecutionPlacement.asyncRequests;
    let shadowActionTransactions = this.#retiredExecutionPlacement
      .shadowActionTransactions;
    let authoritativeActionTransactions = this.#retiredExecutionPlacement
      .authoritativeActionTransactions;
    for (const slot of this.#slots.values()) {
      states[slot.state]++;
      activeDemands += slot.demands.length;
      if (slot.executor !== null) {
        activeWorkers++;
        const placement = this.#readExecutionMetrics(slot.executor);
        schedulerRuns += placement.schedulerRuns;
        asyncRequests += placement.asyncRequests;
        shadowActionTransactions += placement.actionTransactions.shadow;
        authoritativeActionTransactions +=
          placement.actionTransactions.authoritative;
      }
    }
    return Object.freeze({
      activeLanes: this.#slots.size,
      activeWorkers,
      activeDemands,
      states: Object.freeze(states),
      executionPlacement: Object.freeze({
        schedulerRuns,
        asyncRequests,
        actionTransactions: Object.freeze({
          shadow: shadowActionTransactions,
          authoritative: authoritativeActionTransactions,
        }),
      }),
      ...this.#metrics,
    });
  }

  #readExecutionMetrics(
    executor: SpaceExecutor,
  ): ExecutorExecutionMetricsSnapshot {
    try {
      return executor.executionMetrics?.() ?? {
        schedulerRuns: 0,
        asyncRequests: 0,
        actionTransactions: { shadow: 0, authoritative: 0 },
      };
    } catch (error) {
      console.warn("executor Worker metrics snapshot failed", error);
      return {
        schedulerRuns: 0,
        asyncRequests: 0,
        actionTransactions: { shadow: 0, authoritative: 0 },
      };
    }
  }

  #retireExecutionMetrics(executor: SpaceExecutor): void {
    const placement = this.#readExecutionMetrics(executor);
    this.#retiredExecutionPlacement.schedulerRuns += placement.schedulerRuns;
    this.#retiredExecutionPlacement.asyncRequests += placement.asyncRequests;
    this.#retiredExecutionPlacement.shadowActionTransactions +=
      placement.actionTransactions.shadow;
    this.#retiredExecutionPlacement.authoritativeActionTransactions +=
      placement.actionTransactions.authoritative;
  }

  async idle(): Promise<void> {
    while (this.#tasks.size > 0) {
      await Promise.allSettled([...this.#tasks]);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    for (const slot of this.#slots.values()) {
      this.#unsubscribeAcceptedCommits(slot);
      slot.startupAbort?.abort(new Error("execution pool is closing"));
    }
    await this.idle();
    const stops = [...this.#slots.values()].map((slot) =>
      this.#enqueue(slot, async () => {
        await this.#shutdown(slot, false);
      })
    );
    await Promise.allSettled(stops);
    await this.idle();
    this.#slots.clear();
  }

  #acceptDemandSnapshot(snapshot: ExecutionDemandSnapshot): Promise<void> {
    if (this.#closed) return Promise.resolve();
    const key = laneKey(snapshot.space, snapshot.branch);
    let slot = this.#slots.get(key);
    if (slot === undefined) {
      const created: Slot = {
        key,
        space: snapshot.space,
        branch: snapshot.branch,
        order: 0,
        demands: [],
        pieces: [],
        state: "waiting",
        lease: null,
        executor: null,
        generationToken: null,
        crashToken: null,
        startupAbort: null,
        renewTimer: null,
        backoffTimer: null,
        crashAttempts: 0,
        unsubscribeAcceptedCommits: null,
        lastSettledSeq: 0,
        pendingWakeSeq: null,
        pendingWakeStartedAt: null,
        acceptedWakeQueued: false,
        tail: Promise.resolve(),
      };
      slot = created;
      this.#slots.set(key, created);
      try {
        created.unsubscribeAcceptedCommits = this.#control
          .subscribeAcceptedCommits(
            created.space,
            (event) => this.#acceptAcceptedCommit(created, event),
          );
      } catch (error) {
        this.#slots.delete(key);
        throw error;
      }
    }
    if (snapshot.order <= slot.order) return slot.tail;
    this.#metrics.demandSnapshots++;
    slot.order = snapshot.order;
    slot.demands = snapshot.demands;
    if (snapshot.demands.length === 0) {
      slot.startupAbort?.abort(new Error("execution demand was removed"));
    }
    return this.#enqueue(slot, () => this.#reconcile(slot));
  }

  #acceptAcceptedCommit(
    slot: Slot,
    event: AcceptedCommitEvent,
  ): Promise<void> {
    if (this.#closed || this.#slots.get(slot.key) !== slot) {
      return Promise.resolve();
    }
    this.#metrics.acceptedCommitNotifications++;
    if (event.space !== slot.space || event.branch !== slot.branch) {
      return Promise.resolve();
    }
    // Server already performed the indexed stale-reader lookup. Inspecting
    // its bounded scalar result here must not be described as a second query.
    this.#metrics.acceptedCommitIndexDecisions++;
    if (event.staleDemandedReaders.length === 0) {
      this.#metrics.suppressedUnrelatedCommits++;
      return Promise.resolve();
    }
    if (
      event.dataSeq <= slot.lastSettledSeq ||
      (slot.executor !== null && slot.state !== "draining")
    ) return Promise.resolve();

    if (slot.pendingWakeSeq === null) {
      slot.pendingWakeStartedAt = performance.now();
    }
    if (slot.pendingWakeSeq === null || event.dataSeq > slot.pendingWakeSeq) {
      slot.pendingWakeSeq = event.dataSeq;
      slot.preferredOriginSessionId = event.originSessionId;
    } else if (
      event.dataSeq === slot.pendingWakeSeq &&
      event.originSessionId !== undefined
    ) {
      slot.preferredOriginSessionId = event.originSessionId;
    }

    if (slot.acceptedWakeQueued) return slot.tail;
    slot.acceptedWakeQueued = true;
    this.#metrics.parkedWakeAttempts++;
    return this.#enqueue(slot, async () => {
      try {
        if (this.#closed || this.#slots.get(slot.key) !== slot) return;
        if (
          slot.pendingWakeSeq === null ||
          slot.pendingWakeSeq <= slot.lastSettledSeq
        ) {
          this.#clearPendingWake(slot);
          return;
        }
        if (slot.executor !== null && slot.state !== "draining") {
          this.#clearPendingWake(slot);
          return;
        }
        if (
          slot.demands.length === 0 || unionPieces(slot.demands).length === 0
        ) {
          this.#clearPendingWake(slot);
          return;
        }
        await this.#reconcile(slot);
      } finally {
        slot.acceptedWakeQueued = false;
      }
    });
  }

  #clearPendingWake(slot: Slot): void {
    slot.pendingWakeSeq = null;
    slot.pendingWakeStartedAt = null;
    slot.preferredOriginSessionId = undefined;
  }

  #unsubscribeAcceptedCommits(slot: Slot): void {
    const unsubscribe = slot.unsubscribeAcceptedCommits;
    slot.unsubscribeAcceptedCommits = null;
    unsubscribe?.();
  }

  #removeSlot(slot: Slot): void {
    if (this.#slots.get(slot.key) !== slot) return;
    this.#unsubscribeAcceptedCommits(slot);
    this.#slots.delete(slot.key);
  }

  #enqueue(slot: Slot, operation: () => Promise<void>): Promise<void> {
    const task = slot.tail.then(operation, operation);
    slot.tail = task.catch((error) => {
      console.warn("shared execution pool reconciliation failed", error);
    });
    this.#tasks.add(task);
    void task.then(
      () => this.#tasks.delete(task),
      () => this.#tasks.delete(task),
    );
    return task;
  }

  async #reconcile(slot: Slot): Promise<void> {
    if (this.#closed && slot.executor === null && slot.lease === null) return;
    const nextPieces = unionPieces(slot.demands);
    if (slot.demands.length === 0 || nextPieces.length === 0 || this.#closed) {
      const drainOrder = slot.order;
      const hibernateStartedAt = performance.now();
      this.#cancelBackoff(slot);
      const shutdown = await this.#shutdown(slot, false);
      if (shutdown.graceful && slot.demands.length === 0) {
        this.#metrics.demandEmptyHibernations++;
        // Fixed-key duration from demand-empty reconciliation through the
        // completed settle/stop/lease-release sequence.
        logger.time(hibernateStartedAt, "hibernate");
      }
      // Demand snapshots mutate the slot before their queued reconciliation
      // runs. A newer non-empty snapshot may therefore arrive while stop() is
      // awaiting runtime settlement. Keep the mapped lane in that case so the
      // queued reconciliation can start its fenced replacement; deleting it
      // here would orphan that replacement and let the next snapshot create a
      // second lane for the same branch/space.
      if (
        !this.#closed &&
        (slot.order !== drainOrder || slot.demands.length > 0)
      ) return;
      this.#removeSlot(slot);
      return;
    }

    let legacyOwned = true;
    try {
      legacyOwned = await this.#legacyBackgroundActive(slot.space, slot.branch);
    } catch (error) {
      console.warn("legacy background exclusion check failed", error);
    }
    if (legacyOwned) {
      this.#cancelBackoff(slot);
      // Legacy acquisition has already fenced claims and is synchronously
      // waiting for this listener. Stop abruptly so no Worker or broker
      // authority can overlap the background-ready response.
      await this.#shutdown(slot, true);
      slot.pieces = nextPieces;
      slot.state = "excluded";
      return;
    }

    if (slot.backoffTimer !== null) {
      slot.pieces = nextPieces;
      slot.state = "backoff";
      return;
    }

    if (slot.executor !== null && slot.lease !== null) {
      if (slot.crashToken === slot.generationToken) {
        await this.#shutdown(slot, true);
        this.#scheduleCrashRetry(slot);
        return;
      }
      let renewed: ExecutionLeaseHandle | null;
      try {
        renewed = await this.#control.renewExecutionLease(slot.lease);
      } catch (error) {
        console.warn("execution lease renewal failed", error);
        renewed = null;
      }
      if (renewed === null) {
        this.#metrics.leaseLosses++;
        await this.#shutdown(slot, true);
      } else {
        slot.lease = renewed;
        if (!sameStrings(slot.pieces, nextPieces)) {
          const demandStartedAt = performance.now();
          try {
            await slot.executor.setDemand(nextPieces);
          } finally {
            logger.time(demandStartedAt, "demand-update");
          }
          slot.pieces = nextPieces;
        }
        slot.state = "live";
        return;
      }
    }

    if (
      slot.pendingWakeSeq !== null &&
      slot.pendingWakeSeq <= slot.lastSettledSeq
    ) {
      this.#clearPendingWake(slot);
    }
    const wakingFromAcceptedCommit = slot.pendingWakeSeq !== null;
    const wakeStartedAt = slot.pendingWakeStartedAt;
    slot.state = "waiting";
    const acquired = await this.#control.acquireExecutionLease(
      slot.space,
      slot.branch,
      slot.preferredOriginSessionId === undefined
        ? undefined
        : { preferredOriginSessionId: slot.preferredOriginSessionId },
    );
    if (acquired === null) return;
    if (
      slot.lastLeaseGeneration !== undefined &&
      slot.lastLeaseGeneration !== acquired.leaseGeneration
    ) {
      this.#metrics.leaseReplacements++;
    }
    if (
      slot.lastSponsor !== undefined &&
      slot.lastSponsor !== acquired.onBehalfOf
    ) {
      this.#metrics.sponsorRotations++;
    }
    slot.lastLeaseGeneration = acquired.leaseGeneration;
    slot.lastSponsor = acquired.onBehalfOf;
    slot.lease = acquired;
    slot.state = "starting";
    const token = {};
    slot.generationToken = token;
    slot.crashToken = null;
    const startupAbort = new AbortController();
    slot.startupAbort = startupAbort;
    const workerStartedAt = performance.now();
    this.#metrics.workerStartAttempts++;
    let startOutcome: "live" | "aborted" | "failed" = "failed";
    try {
      const executor = await this.#factory.start({
        space: slot.space,
        branch: slot.branch,
        lease: acquired,
        pieces: nextPieces,
        signal: startupAbort.signal,
        onCrash: (error) => {
          if (
            slot.generationToken !== token || slot.crashToken === token
          ) return;
          this.#metrics.crashes++;
          slot.crashToken = token;
          console.warn(
            `executor Worker crashed for ${slot.space}/${slot.branch}`,
            error,
          );
          void this.#enqueue(slot, () => this.#reconcile(slot));
        },
      });
      if (slot.startupAbort === startupAbort) slot.startupAbort = null;
      if (
        startupAbort.signal.aborted || slot.generationToken !== token ||
        this.#closed
      ) {
        startOutcome = "aborted";
        try {
          await executor.stop();
        } finally {
          this.#retireExecutionMetrics(executor);
        }
        return;
      }
      slot.executor = executor;
      slot.pieces = nextPieces;
      slot.state = "live";
      startOutcome = "live";
      this.#metrics.workersStarted++;
      if (wakingFromAcceptedCommit) {
        this.#metrics.parkedWakeStarts++;
        // Fixed-key duration from the first coalesced relevant notification
        // until its cold replacement generation is live.
        if (wakeStartedAt !== null) logger.time(wakeStartedAt, "wake");
      }
      this.#clearPendingWake(slot);
      this.#scheduleRenewal(slot, token);
      if (slot.crashToken === token) {
        await this.#reconcile(slot);
      }
    } catch (error) {
      if (slot.startupAbort === startupAbort) slot.startupAbort = null;
      startOutcome = startupAbort.signal.aborted ? "aborted" : "failed";
      slot.crashToken = token;
      await this.#shutdown(slot, true);
      console.warn(
        `executor Worker failed to start for ${slot.space}/${slot.branch}`,
        error,
      );
      this.#scheduleCrashRetry(slot);
    } finally {
      if (startOutcome === "aborted") {
        this.#metrics.workerStartAborts++;
      } else if (startOutcome === "failed") {
        this.#metrics.workerStartFailures++;
      }
      logger.time(workerStartedAt, "worker-start");
      logger.time(workerStartedAt, `worker-start-${startOutcome}`);
    }
  }

  #scheduleRenewal(slot: Slot, token: object): void {
    this.#cancelRenewal(slot);
    if (slot.lease === null || slot.lease.state !== "active") return;
    const remaining = Math.max(1, slot.lease.expiresAt - this.#now());
    slot.renewTimer = this.#setTimer(() => {
      slot.renewTimer = null;
      if (slot.generationToken !== token || this.#closed) return;
      void this.#enqueue(slot, async () => {
        if (slot.lease === null || slot.generationToken !== token) return;
        let renewed: ExecutionLeaseHandle | null;
        try {
          renewed = await this.#control.renewExecutionLease(slot.lease);
        } catch (error) {
          console.warn("execution lease renewal failed", error);
          renewed = null;
        }
        if (renewed === null) {
          this.#metrics.leaseLosses++;
          await this.#shutdown(slot, true);
          await this.#reconcile(slot);
          return;
        }
        slot.lease = renewed;
        // A successful boot alone is not a health boundary: a realm that
        // repeatedly initializes and immediately crashes must still escalate
        // its backoff. Surviving through an authority renewal proves this
        // generation stayed live long enough to reset the crash streak.
        slot.crashAttempts = 0;
        this.#scheduleRenewal(slot, token);
      });
    }, Math.max(1, Math.floor(remaining / 2)));
  }

  #cancelRenewal(slot: Slot): void {
    if (slot.renewTimer === null) return;
    this.#clearTimer(slot.renewTimer);
    slot.renewTimer = null;
  }

  #scheduleCrashRetry(slot: Slot): void {
    this.#cancelBackoff(slot);
    if (this.#closed || slot.demands.length === 0) return;
    slot.crashAttempts++;
    const exponent = Math.max(0, slot.crashAttempts - 1);
    const delayMs = Math.min(
      this.#crashBackoffMaxMs,
      this.#crashBackoffBaseMs * (2 ** exponent),
    );
    slot.state = "backoff";
    slot.backoffTimer = this.#setTimer(() => {
      slot.backoffTimer = null;
      if (this.#closed || this.#slots.get(slot.key) !== slot) return;
      void this.#enqueue(slot, () => this.#reconcile(slot));
    }, delayMs);
  }

  #cancelBackoff(slot: Slot): void {
    if (slot.backoffTimer === null) return;
    this.#clearTimer(slot.backoffTimer);
    slot.backoffTimer = null;
  }

  async #settleWhileRenewing(
    slot: Slot,
    executor: SpaceExecutor,
    initialLease: ExecutionLeaseHandle | null,
  ): Promise<
    | {
      graceful: true;
      lease: ExecutionLeaseHandle | null;
      sequence: number;
    }
    | {
      graceful: false;
      lease: ExecutionLeaseHandle | null;
    }
  > {
    type Outcome =
      | { kind: "settled"; sequence: number }
      | { kind: "settle-error"; error: unknown }
      | { kind: "renewal-failed" }
      | { kind: "timeout" };

    let lease = initialLease;
    let renewalTimer: number | null = null;
    let timeoutTimer: number | null = null;
    let renewalTask: Promise<void> | null = null;
    let renewalFailed = false;
    let running = true;
    const generationToken = slot.generationToken;
    const renewalFailure = Promise.withResolvers<void>();

    const failRenewal = (error?: unknown): void => {
      if (renewalFailed) return;
      renewalFailed = true;
      this.#metrics.leaseLosses++;
      if (error !== undefined) {
        console.warn("execution lease renewal failed during settle", error);
      }
      renewalFailure.resolve();
    };

    const scheduleRenewal = (): void => {
      if (!running || lease === null || lease.state !== "active") return;
      const remaining = Math.max(1, lease.expiresAt - this.#now());
      renewalTimer = this.#setTimer(() => {
        renewalTimer = null;
        const current = lease;
        if (!running || current === null || current.state !== "active") return;
        renewalTask = this.#control.renewExecutionLease(current).then(
          (renewed) => {
            if (renewed === null) {
              failRenewal();
              return;
            }
            lease = renewed;
            if (
              slot.generationToken === generationToken &&
              slot.lease?.leaseGeneration === renewed.leaseGeneration
            ) {
              slot.lease = renewed;
            }
            scheduleRenewal();
          },
          (error) => failRenewal(error),
        ).finally(() => {
          renewalTask = null;
        });
      }, Math.max(1, Math.floor(remaining / 2)));
    };

    scheduleRenewal();
    const settleStartedAt = performance.now();
    const settle = executor.settle().then(
      (sequence): Outcome => ({ kind: "settled", sequence }),
      (error): Outcome => ({ kind: "settle-error", error }),
    ).finally(() => logger.time(settleStartedAt, "worker-settle"));
    const timeout = new Promise<Outcome>((resolve) => {
      timeoutTimer = this.#setTimer(
        () => resolve({ kind: "timeout" }),
        Math.max(0, this.#settleTimeoutMs),
      );
    });
    const failedRenewal = renewalFailure.promise.then<Outcome>(() => ({
      kind: "renewal-failed",
    }));

    const outcome = await Promise.race([settle, timeout, failedRenewal]);
    running = false;
    if (renewalTimer !== null) this.#clearTimer(renewalTimer);
    if (timeoutTimer !== null) this.#clearTimer(timeoutTimer);
    const inFlightRenewal = renewalTask;
    if (inFlightRenewal !== null) await inFlightRenewal;

    if (outcome.kind === "settle-error") {
      console.warn("executor Worker failed to settle", outcome.error);
    } else if (outcome.kind === "timeout") {
      console.warn(
        `executor Worker did not settle within ${this.#settleTimeoutMs}ms`,
      );
    }
    if (outcome.kind === "settled" && !renewalFailed) {
      return { graceful: true, lease, sequence: outcome.sequence };
    }
    return { graceful: false, lease };
  }

  async #shutdown(
    slot: Slot,
    abrupt: boolean,
  ): Promise<{ graceful: boolean }> {
    this.#cancelRenewal(slot);
    this.#cancelBackoff(slot);
    const executor = slot.executor;
    let lease = slot.lease;
    const leaseGeneration = lease?.leaseGeneration;
    if (executor === null && lease === null) {
      return { graceful: false };
    }
    let stopFailed = false;
    let finishFailed = false;
    slot.state = "draining";

    if (!abrupt && executor !== null) {
      const settled = await this.#settleWhileRenewing(slot, executor, lease);
      lease = settled.lease;
      if (settled.graceful) {
        slot.lastSettledSeq = Math.max(
          slot.lastSettledSeq,
          settled.sequence,
        );
      }
      abrupt = !settled.graceful;
    }
    if (lease !== null && lease.state === "active") {
      try {
        const draining = await this.#control.beginExecutionLeaseDrain(lease);
        if (draining === null) {
          this.#metrics.leaseLosses++;
          abrupt = true;
          lease = null;
        } else {
          lease = draining;
          if (slot.lease?.leaseGeneration === lease.leaseGeneration) {
            slot.lease = lease;
          }
        }
      } catch (error) {
        console.warn("execution lease drain failed", error);
        this.#metrics.leaseLosses++;
        abrupt = true;
        lease = null;
      }
    }
    if (executor !== null) {
      try {
        await executor.stop(abrupt ? { abrupt: true } : undefined);
      } catch (error) {
        console.warn("executor Worker teardown failed", error);
        stopFailed = true;
      }
      this.#retireExecutionMetrics(executor);
      this.#metrics.workersStopped++;
      if (abrupt) this.#metrics.abruptStops++;
    }
    if (lease !== null) {
      try {
        const finished = await this.#control.finishExecutionLeaseDrain(lease);
        if (finished === null) finishFailed = true;
      } catch (error) {
        console.warn("execution lease drain completion failed", error);
        this.#metrics.leaseLosses++;
        finishFailed = true;
      }
    }
    if (slot.executor === executor) slot.executor = null;
    if (slot.lease?.leaseGeneration === leaseGeneration) {
      slot.lease = null;
    }
    slot.generationToken = null;
    slot.crashToken = null;
    return {
      graceful: executor !== null && !abrupt && !stopFailed && !finishFailed,
    };
  }
}
