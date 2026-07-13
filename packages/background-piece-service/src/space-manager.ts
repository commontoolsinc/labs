import { sleep } from "@commonfabric/utils/sleep";
import { Cell } from "@commonfabric/runner";
import { type Cancel, useCancelGroup } from "@commonfabric/runner";
import {
  WorkerController,
  WorkerControllerErrorEvent,
  type WorkerOptions,
} from "./worker-controller.ts";
import { type BGPieceEntry } from "./schema.ts";
import type {
  LegacyBackgroundExclusion,
  LegacyBackgroundExclusionStatus,
} from "@commonfabric/memory/v2";

export interface LegacyBackgroundExclusionControl {
  acquire(
    branch: string,
  ): Promise<LegacyBackgroundExclusionStatus | null | undefined>;
  renew(
    branch: string,
    exclusionGeneration: number,
  ): Promise<LegacyBackgroundExclusionStatus | null | undefined>;
  release(
    branch: string,
    exclusionGeneration: number,
  ): Promise<LegacyBackgroundExclusion | null | undefined>;
}

export interface PieceSchedulerOptions extends WorkerOptions {
  pollingIntervalMs?: number;
  deactivationTimeoutMs?: number;
  rerunIntervalMs?: number;
  backgroundExclusion?: LegacyBackgroundExclusionControl;
  createWorkerController?: (options: WorkerOptions) => WorkerController;
  now?: () => number;
  /** Monotonic clock used only for locally enforcing server lease duration. */
  monotonicNow?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => number;
  clearTimer?: (timer: number) => void;
}

type Task = {
  pieceId: string;
  timestamp: number;
  entry: Cell<BGPieceEntry>;
};

export class SpaceManager {
  private did: string;
  private pollingIntervalMs: number;
  private enabledPieces = new Map<string, Cell<BGPieceEntry>>();
  private activePiece: Cell<BGPieceEntry> | null = null;
  private deactivationTimeoutMs: number;
  private workerController: WorkerController | null = null;
  private rerunIntervalMs: number;
  private pendingTasks: Task[] = [];
  private failureTracking = new Map<string, number>();
  private workerOptions: WorkerOptions;
  private isRunning = false;
  private isStopping = false;
  private stopPromise: Promise<void> | null = null;
  private workerGeneration = 0;
  private readonly backgroundExclusionControl?:
    LegacyBackgroundExclusionControl;
  private backgroundExclusion: LegacyBackgroundExclusion | null = null;
  private backgroundReady = false;
  private readonly createWorkerController: (
    options: WorkerOptions,
  ) => WorkerController;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly setTimer: (
    callback: () => void,
    delayMs: number,
  ) => number;
  private readonly clearTimer: (timer: number) => void;
  private renewalTimer: number | null = null;
  private expiryTimer: number | null = null;
  private retryTimer: number | null = null;
  private acquisitionInFlight = false;
  private renewalInFlight: LegacyBackgroundExclusion | null = null;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private readonly initializationTasks = new Set<Promise<void>>();
  private readonly controlTasks = new Set<Promise<void>>();

  constructor(options: PieceSchedulerOptions) {
    this.did = options.did;
    this.pollingIntervalMs = options.pollingIntervalMs ?? 100;
    this.deactivationTimeoutMs = options.deactivationTimeoutMs ?? 10000;
    this.rerunIntervalMs = options.rerunIntervalMs ?? 60000;
    this.workerOptions = options;
    this.backgroundExclusionControl = options.backgroundExclusion;
    this.createWorkerController = options.createWorkerController ??
      ((workerOptions) => new WorkerController(workerOptions));
    this.now = options.now ?? Date.now;
    this.monotonicNow = options.monotonicNow ?? performance.now.bind(
      performance,
    );
    this.setTimer = options.setTimer ??
      ((callback, delayMs) =>
        setTimeout(callback, delayMs) as unknown as number);
    this.clearTimer = options.clearTimer ??
      ((timer) =>
        clearTimeout(timer as unknown as ReturnType<typeof setTimeout>));
    if (this.backgroundExclusionControl === undefined) {
      void this.setupWorkerController();
    }

    console.log(
      `${this.did} Piece scheduler initialized | pollingIntervalMs: ${this.pollingIntervalMs} | deactivationTimeoutMs: ${this.deactivationTimeoutMs} | rerunIntervalMs: ${this.rerunIntervalMs}`,
    );
  }

  private pushTask(
    pieceId: string,
    entry: Cell<BGPieceEntry>,
    whenInMs?: number,
  ) {
    const when = whenInMs ?? this.rerunIntervalMs;
    const timestamp = this.now() + when;
    this.pendingTasks.push({
      pieceId,
      timestamp,
      entry,
    });

    this.pendingTasks.sort((a, b) => a.timestamp - b.timestamp);
  }

  private updatePieceStatus(b: BGPieceEntry, c: Cell<BGPieceEntry>) {
    const pieceId = b.pieceId;
    const enabled = !b.disabledAt;
    const currentlyScheduled = this.enabledPieces.has(pieceId) ||
      this.activePiece?.get().pieceId === pieceId;

    if (enabled) {
      // if we aren't already scheduling this piece, add it to the list
      if (!currentlyScheduled) {
        this.enabledPieces.set(pieceId, c);
        this.pushTask(pieceId, c, 0);
      }
    } else {
      // if we are disabling a piece, remove it from the list
      if (currentlyScheduled) {
        this.enabledPieces.delete(pieceId);
        this.pendingTasks = this.pendingTasks.filter((r) =>
          r.pieceId !== pieceId
        );
      }
    }
  }

  // Update the list of pieces to watch (removing any pieces that are no longer in the list)
  watch(entries: Cell<BGPieceEntry>[]): Cancel {
    const [cancel, addCancel] = useCancelGroup();

    const scheduled = Array.from(this.enabledPieces.keys());
    const desired = new Set();

    for (const entry of entries) {
      const raw = entry.get();
      addCancel(entry.sink((value) => this.updatePieceStatus(value, entry)));

      if (!raw.disabledAt) {
        desired.add(raw.pieceId);
      }
    }

    const toRemove = scheduled.filter((pieceId) => !desired.has(pieceId));

    for (const pieceId of toRemove) {
      this.enabledPieces.delete(pieceId);
      this.pendingTasks = this.pendingTasks.filter((task) =>
        task.pieceId !== pieceId
      );
    }

    console.log(
      `${this.did} Piece scheduling ${this.enabledPieces.size} piece updaters`,
    );
    return cancel;
  }

  start(): void {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;
    this.isStopping = false;
    this.stopPromise = null;
    console.log(`${this.did} Piece scheduler starting...`);
    if (this.backgroundExclusionControl !== undefined) {
      this.beginAcquireBackgroundExclusion();
    } else if (this.workerController === null) {
      void this.enqueueLifecycle(() => this.setupWorkerController());
    }
    void this.execLoop();
  }

  stop(): Promise<void> {
    if (this.stopPromise !== null) return this.stopPromise;
    console.log(`${this.did} Stopping piece scheduler...`);
    this.isRunning = false;
    this.isStopping = true;

    this.stopPromise = this.stopLifecycle();
    return this.stopPromise;
  }

  private async stopLifecycle(): Promise<void> {
    // Wait for active jobs to finish with a timeout
    if (this.activePiece) {
      await Promise.race([
        sleep(this.deactivationTimeoutMs),
        new Promise((resolve) => {
          const checkInterval = setInterval(() => {
            if (!this.activePiece) {
              clearInterval(checkInterval);
              resolve(true);
            }
          }, this.pollingIntervalMs);
        }),
      ]);
    }

    await this.enqueueLifecycle(async () => {
      this.cancelRetry();
      const worker = this.workerController;
      this.workerController = null;
      this.workerGeneration++;
      if (worker !== null) {
        worker.removeEventListener?.("error", this.onTerminalError);
        try {
          await worker.shutdown();
        } catch (error) {
          console.warn(`Could not shutdown worker ${this.did}: ${error}`);
          worker.terminateNow("background piece service stopping");
        }
      }

      const exclusion = this.backgroundExclusion;
      if (
        exclusion !== null && this.backgroundExclusionControl !== undefined
      ) {
        try {
          await this.backgroundExclusionControl.release(
            exclusion.branch,
            exclusion.exclusionGeneration,
          );
        } catch (error) {
          console.warn(
            `Could not release background exclusion for ${this.did}: ${error}`,
          );
        }
      }
      this.cancelExclusionTimers();
      this.backgroundExclusion = null;
      this.backgroundReady = false;
      this.isStopping = false;
    });
  }

  async idle(): Promise<void> {
    while (true) {
      const tail = this.lifecycleTail;
      const initializations = [...this.initializationTasks];
      const controls = [...this.controlTasks];
      await Promise.allSettled([tail, ...initializations, ...controls]);
      if (
        tail === this.lifecycleTail && initializations.length === 0 &&
        this.initializationTasks.size === 0 && controls.length === 0 &&
        this.controlTasks.size === 0
      ) return;
    }
  }

  private enqueueLifecycle(
    operation: () => Promise<void> | void,
  ): Promise<void> {
    const task = this.lifecycleTail.then(operation, operation);
    this.lifecycleTail = task.catch((error) => {
      console.error(`${this.did} Background lifecycle failed: ${error}`);
    });
    return task;
  }

  private trackControlTask(task: Promise<void>): void {
    this.controlTasks.add(task);
    void task.then(
      () => this.controlTasks.delete(task),
      () => this.controlTasks.delete(task),
    );
  }

  private beginAcquireBackgroundExclusion(): void {
    const control = this.backgroundExclusionControl;
    if (
      control === undefined || !this.isRunning || this.acquisitionInFlight
    ) return;
    this.acquisitionInFlight = true;
    const task = control.acquire("").then(
      (status) =>
        this.enqueueLifecycle(async () => {
          this.acquisitionInFlight = false;
          if (!this.isRunning) {
            if (status?.exclusion !== undefined) {
              await control.release(
                status.exclusion.branch,
                status.exclusion.exclusionGeneration,
              ).catch((error) =>
                console.warn(
                  `${this.did} Could not release late background exclusion: ${error}`,
                )
              );
            }
            return;
          }
          if (status === undefined) {
            console.error(
              `${this.did} Background exclusion protocol unavailable; failing closed`,
            );
            return;
          }
          if (status === null) {
            this.scheduleRetry();
            return;
          }
          await this.acceptBackgroundStatus(status);
        }),
      (error) =>
        this.enqueueLifecycle(() => {
          this.acquisitionInFlight = false;
          console.warn(
            `${this.did} Could not acquire background exclusion: ${error}`,
          );
          this.scheduleRetry();
        }),
    ).catch(() => undefined);
    this.trackControlTask(task);
  }

  private beginRenewBackgroundExclusion(
    expected: LegacyBackgroundExclusion,
  ): void {
    const control = this.backgroundExclusionControl;
    if (
      control === undefined || this.backgroundExclusion !== expected ||
      (!this.isRunning && !this.isStopping) ||
      this.renewalInFlight === expected
    ) return;
    this.renewalInFlight = expected;
    const task = control.renew(
      expected.branch,
      expected.exclusionGeneration,
    ).then(
      (status) =>
        this.enqueueLifecycle(async () => {
          if (this.renewalInFlight === expected) {
            this.renewalInFlight = null;
          }
          if (this.backgroundExclusion !== expected) return;
          if (status === null || status === undefined) {
            await this.loseBackgroundAuthority(
              "background exclusion authority lost",
            );
            return;
          }
          await this.acceptBackgroundStatus(status);
        }),
      (error) =>
        this.enqueueLifecycle(async () => {
          if (this.renewalInFlight === expected) {
            this.renewalInFlight = null;
          }
          if (this.backgroundExclusion !== expected) return;
          console.warn(
            `${this.did} Background exclusion renewal failed: ${error}`,
          );
          await this.loseBackgroundAuthority(
            "background exclusion renewal failed",
          );
        }),
    ).catch(() => undefined);
    this.trackControlTask(task);
  }

  private async acceptBackgroundStatus(
    status: LegacyBackgroundExclusionStatus,
  ): Promise<void> {
    this.backgroundExclusion = status.exclusion;
    if (!this.scheduleExclusionTimers(status)) {
      console.error(
        `${this.did} Background exclusion response lacks a safe server-relative deadline; failing closed`,
      );
      this.loseBackgroundAuthority(
        "background exclusion deadline unavailable",
      );
      return;
    }
    this.backgroundReady = status.ready;
    if (status.ready && this.isRunning && this.workerController === null) {
      await this.setupWorkerController();
    }
  }

  private scheduleExclusionTimers(
    status: LegacyBackgroundExclusionStatus,
  ): boolean {
    this.cancelExclusionTimers();
    const exclusion = status.exclusion;
    const serverTime = status.serverTime;
    if (
      serverTime === undefined || !Number.isSafeInteger(serverTime) ||
      !Number.isSafeInteger(exclusion.expiresAt) ||
      exclusion.expiresAt <= serverTime
    ) return false;
    const remaining = exclusion.expiresAt - serverTime;
    const blockedDelay = status.blockedUntil === undefined
      ? remaining
      : Math.max(1, status.blockedUntil - serverTime);
    const renewDelay = Math.max(
      1,
      Math.min(Math.floor(remaining / 2), blockedDelay),
    );
    this.renewalTimer = this.setTimer(() => {
      this.renewalTimer = null;
      this.beginRenewBackgroundExclusion(exclusion);
    }, renewDelay);
    const localDeadline = this.monotonicNow() + remaining;
    const expire = () => {
      this.expiryTimer = null;
      const delay = Math.ceil(localDeadline - this.monotonicNow());
      if (delay > 0) {
        this.expiryTimer = this.setTimer(expire, delay);
        return;
      }
      void this.enqueueLifecycle(() => {
        if (this.backgroundExclusion === exclusion) {
          this.loseBackgroundAuthority("background exclusion expired locally");
        }
      });
    };
    this.expiryTimer = this.setTimer(expire, remaining);
    return true;
  }

  private cancelExclusionTimers(): void {
    if (this.renewalTimer !== null) {
      this.clearTimer(this.renewalTimer);
      this.renewalTimer = null;
    }
    if (this.expiryTimer !== null) {
      this.clearTimer(this.expiryTimer);
      this.expiryTimer = null;
    }
  }

  private loseBackgroundAuthority(reason: string): void {
    this.cancelExclusionTimers();
    this.backgroundExclusion = null;
    this.backgroundReady = false;
    this.renewalInFlight = null;
    const worker = this.workerController;
    this.workerController = null;
    this.workerGeneration++;
    if (worker !== null) {
      worker.removeEventListener?.("error", this.onTerminalError);
      worker.terminateNow(reason);
    }
    if (this.isRunning) this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (
      this.retryTimer !== null || this.isStopping ||
      (this.backgroundExclusionControl !== undefined && !this.isRunning)
    ) return;
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      void this.enqueueLifecycle(async () => {
        if (
          this.isStopping ||
          (this.backgroundExclusionControl !== undefined && !this.isRunning)
        ) return;
        if (
          this.backgroundExclusionControl !== undefined &&
          this.backgroundExclusion === null
        ) {
          this.beginAcquireBackgroundExclusion();
        } else if (this.workerController === null) {
          await this.setupWorkerController();
        }
      });
    }, this.pollingIntervalMs);
  }

  private cancelRetry(): void {
    if (this.retryTimer === null) return;
    this.clearTimer(this.retryTimer);
    this.retryTimer = null;
  }

  private async execLoop(): Promise<void> {
    while (this.isRunning) {
      const worker = this.workerController;
      if (worker === null || !worker.isReady()) {
        await sleep(this.pollingIntervalMs);
        continue;
      }

      if (this.activePiece) {
        await sleep(this.pollingIntervalMs);
        continue;
      }

      if (
        this.pendingTasks.length === 0 ||
        this.pendingTasks[0].timestamp > this.now()
      ) {
        await sleep(this.pollingIntervalMs);
        continue;
      }

      const { pieceId, entry, timestamp: _ } = this.pendingTasks.shift()!;

      void this.processPiece(pieceId, entry);
    }
  }

  private async processPiece(pieceId: string, entry: Cell<BGPieceEntry>) {
    const raw = entry.get();

    if (raw.disabledAt) {
      console.log(`${this.did} Piece ${pieceId} is disabled, skipping`);
      return;
    }

    console.log(`${this.did} Starting ${raw.integration} ${raw.pieceId}`);

    const worker = this.workerController;
    if (worker === null) {
      if (this.enabledPieces.has(pieceId)) this.pushTask(pieceId, entry, 0);
      return;
    }
    const workerGeneration = this.workerGeneration;
    this.activePiece = entry;

    try {
      await worker.runPiece(entry);
      if (
        this.workerController !== worker ||
        this.workerGeneration !== workerGeneration
      ) {
        if (this.enabledPieces.has(pieceId) && this.isRunning) {
          this.pushTask(pieceId, entry, 0);
        }
        return;
      }
      this.onProcessSuccess(pieceId, entry);
    } catch (error) {
      if (
        this.workerController !== worker ||
        this.workerGeneration !== workerGeneration
      ) {
        console.warn(
          `${this.did} Piece ${pieceId} interrupted by worker fencing`,
        );
        if (this.enabledPieces.has(pieceId) && this.isRunning) {
          this.pushTask(pieceId, entry, 0);
        }
        return;
      }
      const errorString = error instanceof Error
        ? error.message
        : String(error);
      console.error(`${this.did} ${errorString}`);
      this.onProcessFail(pieceId, entry, errorString);
    } finally {
      this.activePiece = null;
    }
  }

  private onProcessSuccess(pieceId: string, entry: Cell<BGPieceEntry>) {
    // If previous runs have failed, clear out the counter
    if (this.failureTracking.has(pieceId)) {
      this.failureTracking.delete(pieceId);
    }

    entry.runtime.editWithRetry((tx) => {
      entry.withTx(tx).update({
        lastRun: this.now(),
        status: "Success",
      });
    });

    if (this.enabledPieces.has(pieceId)) {
      this.pushTask(pieceId, entry);
    }
  }

  private onProcessFail(
    pieceId: string,
    entry: Cell<BGPieceEntry>,
    error: string,
  ) {
    const failureCount = (this.failureTracking.get(pieceId) ?? 0) + 1;

    // If we've received graph errors 3 times in a row,
    // disable the piece.
    if (failureCount >= 3) {
      this.failureTracking.delete(pieceId);
      this.disablePiece(pieceId, entry, error);
    } else {
      this.failureTracking.set(pieceId, failureCount);
      entry.runtime.editWithRetry((tx) => {
        entry.withTx(tx).update({
          lastRun: this.now(),
          status: error,
        });
      });

      if (this.enabledPieces.has(pieceId)) {
        // Apply a linear backoff for the next attempts
        this.pushTask(
          pieceId,
          entry,
          this.rerunIntervalMs * (failureCount + 1),
        );
      }
    }
  }

  private disablePiece(
    pieceId: string,
    entry: Cell<BGPieceEntry>,
    error: string,
  ) {
    entry.runtime.editWithRetry((tx) => {
      entry.withTx(tx).update({
        disabledAt: this.now(),
        lastRun: this.now(),
        status: `Disabled: ${error}`,
      });
    });

    this.enabledPieces.delete(pieceId);
    this.pendingTasks = this.pendingTasks.filter((r) => r.pieceId !== pieceId);
  }

  private disableSpace(reason: string) {
    console.log(`${this.did} Disabling space: ${reason}`);
    for (const [pieceId, entry] of this.enabledPieces.entries()) {
      this.disablePiece(pieceId, entry, reason);
    }
  }

  // This is fired from `WorkerController` when an terminal error
  // occurs (e.g. outside of the graph), and may happen at any point
  // during execution.
  // Because this can occur from a piece calling `setTimeout(() => throw new Error(""), timeout)`
  // we cannot determine the offending piece. Because this should not occur frequently,
  // and happening currently due to older, misbehaving pieces, this should flush out
  // those misbehaving pieces.
  //
  // Attempt to recreate the worker environment, which should only occur once per
  // space-wide disabling.
  private onTerminalError = (event: WorkerControllerErrorEvent) => {
    console.error(
      `${this.did} Terminal error received: ${event.error?.message}`,
    );

    const reason =
      `TerminalError: All pieces in this space have been disabled: ${event.error?.message}`;
    this.disableSpace(reason);
    void this.enqueueLifecycle(() => {
      const failed = this.workerController;
      if (failed !== null) {
        failed.removeEventListener?.("error", this.onTerminalError);
        this.workerController = null;
        this.workerGeneration++;
        failed.terminateNow("terminal background worker error");
      }
      this.scheduleRetry();
    });
  };

  private async setupWorkerController(): Promise<void> {
    if (
      this.isStopping ||
      (this.backgroundExclusionControl !== undefined &&
        (!this.isRunning || !this.backgroundReady ||
          this.backgroundExclusion === null))
    ) return;
    const previousWorker = this.workerController;
    if (previousWorker !== null) {
      console.log(`${this.did} Restarting Worker Controller`);
      previousWorker.removeEventListener?.("error", this.onTerminalError);
      this.workerController = null;
      this.workerGeneration++;
      try {
        await previousWorker.shutdown();
      } catch (e) {
        console.warn(
          `Could not shutdown old worker ${this.did} after restarting: ${e}`,
        );
      }
    }
    if (
      this.isStopping ||
      (this.backgroundExclusionControl !== undefined &&
        (!this.isRunning || !this.backgroundReady ||
          this.backgroundExclusion === null))
    ) return;

    const newWorker = this.createWorkerController(this.workerOptions);
    newWorker.addEventListener(
      "error",
      this.onTerminalError,
    );
    this.workerController = newWorker;
    const generation = ++this.workerGeneration;
    const initialization = newWorker.initializeResolve.then(
      () =>
        this.enqueueLifecycle(() => {
          if (
            this.workerController !== newWorker ||
            this.workerGeneration !== generation
          ) {
            newWorker.terminateNow("superseded background worker generation");
            return;
          }
          console.log(`${this.did} Worker controller ready for work`);
        }),
      (error) =>
        this.enqueueLifecycle(() => {
          if (this.workerController !== newWorker) return;
          this.workerController = null;
          this.workerGeneration++;
          newWorker.removeEventListener?.("error", this.onTerminalError);
          newWorker.terminateNow("background worker initialization failed");
          // Initialization error. This "should not" occur, but is seen on invalid IPC requests
          // during initialization.
          // Disable all pieces in this space and attempt to recreate the worker.
          console.error(`${this.did} failed to initialize: ${error}`);
          this.disableSpace(`Failed to initialize worker.`);
          this.scheduleRetry();
        }),
    ).then(() => undefined);
    this.initializationTasks.add(initialization);
    void initialization.then(
      () => this.initializationTasks.delete(initialization),
      () => this.initializationTasks.delete(initialization),
    );
  }
}
