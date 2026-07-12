import type { BranchName, ExecutionLease } from "@commonfabric/memory/v2";
import type {
  ExecutionDemandListener,
  ExecutionDemandSnapshot,
  ExecutionLeaseHandle,
} from "@commonfabric/memory/v2/server";

export interface ExecutionPoolControl {
  subscribeExecutionDemands(listener: ExecutionDemandListener): () => void;
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
  /** Settle outstanding local work and tear down the isolated runtime. */
  stop(): Promise<void>;
}

export interface SpaceExecutorStartOptions {
  readonly space: string;
  readonly branch: BranchName;
  readonly lease: ExecutionLeaseHandle;
  readonly pieces: readonly string[];
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
  renewTimer: number | null;
  backoffTimer: number | null;
  crashAttempts: number;
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
  readonly #slots = new Map<string, Slot>();
  readonly #tasks = new Set<Promise<void>>();
  #unsubscribe: (() => void) | null = null;
  #closed = false;

  constructor(options: SharedExecutionPoolOptions) {
    this.#control = options.control;
    this.#factory = options.factory;
    this.#legacyBackgroundActive = options.legacyBackgroundActive ??
      (() => false);
    this.#now = options.now ?? Date.now;
    this.#setTimer = options.setTimer ??
      ((callback, delayMs) =>
        setTimeout(callback, delayMs) as unknown as number);
    this.#clearTimer = options.clearTimer ??
      ((timer) =>
        clearTimeout(timer as unknown as ReturnType<typeof setTimeout>));
    this.#crashBackoffBaseMs = options.crashBackoffBaseMs ?? 1_000;
    this.#crashBackoffMaxMs = options.crashBackoffMaxMs ?? 30_000;
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
    await this.idle();
    const stops = [...this.#slots.values()].map((slot) =>
      this.#enqueue(slot, () => this.#shutdown(slot, false))
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
      slot = {
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
        renewTimer: null,
        backoffTimer: null,
        crashAttempts: 0,
        tail: Promise.resolve(),
      };
      this.#slots.set(key, slot);
    }
    if (snapshot.order <= slot.order) return slot.tail;
    slot.order = snapshot.order;
    slot.demands = snapshot.demands;
    return this.#enqueue(slot, () => this.#reconcile(slot!));
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
      this.#cancelBackoff(slot);
      await this.#shutdown(slot, false);
      if (this.#slots.get(slot.key) === slot) this.#slots.delete(slot.key);
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
      await this.#shutdown(slot, false);
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
      const renewed = await this.#control.renewExecutionLease(slot.lease);
      if (renewed === null) {
        await this.#shutdown(slot, true);
      } else {
        slot.lease = renewed;
        if (!sameStrings(slot.pieces, nextPieces)) {
          await slot.executor.setDemand(nextPieces);
          slot.pieces = nextPieces;
        }
        slot.state = "live";
        return;
      }
    }

    slot.state = "waiting";
    const acquired = await this.#control.acquireExecutionLease(
      slot.space,
      slot.branch,
    );
    if (acquired === null) return;
    slot.lease = acquired;
    slot.state = "starting";
    const token = {};
    slot.generationToken = token;
    slot.crashToken = null;
    try {
      const executor = await this.#factory.start({
        space: slot.space,
        branch: slot.branch,
        lease: acquired,
        pieces: nextPieces,
        onCrash: (error) => {
          if (slot.generationToken !== token) return;
          slot.crashToken = token;
          console.warn(
            `executor Worker crashed for ${slot.space}/${slot.branch}`,
            error,
          );
          void this.#enqueue(slot, () => this.#reconcile(slot));
        },
      });
      if (slot.generationToken !== token || this.#closed) {
        await executor.stop();
        return;
      }
      slot.executor = executor;
      slot.pieces = nextPieces;
      slot.state = "live";
      slot.crashAttempts = 0;
      this.#scheduleRenewal(slot, token);
      if (slot.crashToken === token) {
        await this.#reconcile(slot);
      }
    } catch (error) {
      slot.crashToken = token;
      await this.#shutdown(slot, true);
      console.warn(
        `executor Worker failed to start for ${slot.space}/${slot.branch}`,
        error,
      );
      this.#scheduleCrashRetry(slot);
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
        const renewed = await this.#control.renewExecutionLease(slot.lease);
        if (renewed === null) {
          await this.#shutdown(slot, true);
          await this.#reconcile(slot);
          return;
        }
        slot.lease = renewed;
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

  async #shutdown(slot: Slot, _abrupt: boolean): Promise<void> {
    this.#cancelRenewal(slot);
    this.#cancelBackoff(slot);
    const executor = slot.executor;
    let lease = slot.lease;
    slot.executor = null;
    slot.lease = null;
    slot.generationToken = null;
    slot.crashToken = null;
    if (executor === null && lease === null) return;
    slot.state = "draining";

    if (lease !== null && lease.state === "active") {
      lease = await this.#control.beginExecutionLeaseDrain(lease) ?? lease;
    }
    if (executor !== null) {
      try {
        await executor.stop();
      } catch (error) {
        console.warn("executor Worker teardown failed", error);
      }
    }
    if (lease !== null) {
      await this.#control.finishExecutionLeaseDrain(lease);
    }
  }
}
