/**
 * Scheduling of one space's background pieces: which are enabled, when each
 * next runs, how a failure backs off and eventually disables a piece, and the
 * worker controller the runs go through.
 */

import { type Cancel, Cell, useCancelGroup } from "@commonfabric/runner";
import { sleep } from "@commonfabric/utils/sleep";

import { type BGPieceEntry } from "./schema.ts";
import {
  WorkerController,
  WorkerControllerErrorEvent,
  type WorkerOptions,
} from "./worker-controller.ts";

/**
 * Options for constructing a `SpaceManager`: the worker controller's, plus
 * the scheduler's own intervals.
 */
export interface PieceSchedulerOptions extends WorkerOptions {
  /**
   * How often the loop looks for a runnable task, in milliseconds; 100 by
   * default.
   */
  pollingIntervalMs?: number;

  /**
   * How long `stop()` waits for a piece in flight, in milliseconds; ten
   * seconds by default.
   */
  deactivationTimeoutMs?: number;

  /**
   * How long after a successful run its piece runs again, in milliseconds,
   * and the unit of the backoff after a failed one; a minute by default.
   */
  rerunIntervalMs?: number;
}

/** A scheduled run of one piece. */
type Task = {
  /** Entity id of the piece. */
  pieceId: string;

  /** When the run is due, as a `Date.now()` value. */
  timestamp: number;

  /** The piece's registry entry. */
  entry: Cell<BGPieceEntry>;
};

/**
 * Scheduler of one space's background pieces. It keeps the enabled entries it
 * is watching, a queue of runs ordered by due time, and one
 * `WorkerController` for the space, and it records each run's outcome on the
 * piece's registry entry. A piece that fails three runs in a row is disabled,
 * and a terminal worker error disables every piece in the space and replaces
 * the worker.
 */
export class SpaceManager {
  #did: string;
  #pollingIntervalMs: number;
  #enabledPieces = new Map<string, Cell<BGPieceEntry>>();
  #activePiece: Cell<BGPieceEntry> | null = null;
  #deactivationTimeoutMs: number;
  #workerController!: WorkerController;
  #rerunIntervalMs: number;
  #pendingTasks: Task[] = [];
  #failureTracking = new Map<string, number>();
  #workerOptions: WorkerOptions;
  #isRunning = false;

  /**
   * Constructs an instance for the space `options` names, and starts its
   * worker controller. Runs no piece until `start()`.
   */
  constructor(options: PieceSchedulerOptions) {
    this.#did = options.did;
    this.#pollingIntervalMs = options.pollingIntervalMs ?? 100;
    this.#deactivationTimeoutMs = options.deactivationTimeoutMs ?? 10000;
    this.#rerunIntervalMs = options.rerunIntervalMs ?? 60000;
    this.#workerOptions = options;
    this.#setupWorkerController();

    console.log(
      `${this.#did} Piece scheduler initialized | pollingIntervalMs: ${this.#pollingIntervalMs} | deactivationTimeoutMs: ${this.#deactivationTimeoutMs} | rerunIntervalMs: ${this.#rerunIntervalMs}`,
    );
  }

  /**
   * The state and the steps of this instance that a test drives directly:
   * the scheduling tables, the piece in flight, the running flag, the worker
   * controller, and the loop and the two steps it takes.
   */
  get accessForTestingOnly(): {
    activePiece: Cell<BGPieceEntry> | null;
    readonly enabledPieces: Map<string, Cell<BGPieceEntry>>;
    readonly failureTracking: Map<string, number>;
    isRunning: boolean;
    pendingTasks: Task[];
    workerController: WorkerController;
    execLoop(): Promise<void>;
    processPiece(pieceId: string, entry: Cell<BGPieceEntry>): Promise<void>;
    setupWorkerController(): Promise<void>;
  } {
    // deno-lint-ignore no-this-alias
    const outerThis = this;
    return {
      get activePiece() {
        return outerThis.#activePiece;
      },
      set activePiece(value) {
        outerThis.#activePiece = value;
      },
      enabledPieces: this.#enabledPieces,
      failureTracking: this.#failureTracking,
      get isRunning() {
        return outerThis.#isRunning;
      },
      set isRunning(value) {
        outerThis.#isRunning = value;
      },
      get pendingTasks() {
        return outerThis.#pendingTasks;
      },
      set pendingTasks(value) {
        outerThis.#pendingTasks = value;
      },
      get workerController() {
        return outerThis.#workerController;
      },
      set workerController(value) {
        outerThis.#workerController = value;
      },
      execLoop: () => this.#execLoop(),
      processPiece: (pieceId, entry) => this.#processPiece(pieceId, entry),
      setupWorkerController: () => this.#setupWorkerController(),
    };
  }

  /**
   * Updates the list of pieces to watch, removing any pieces that are no
   * longer in the list.
   */
  watch(entries: Cell<BGPieceEntry>[]): Cancel {
    const [cancel, addCancel] = useCancelGroup();

    const scheduled = Array.from(this.#enabledPieces.keys());
    const desired = new Set();

    for (const entry of entries) {
      const raw = entry.get();
      addCancel(entry.sink((value) => this.#updatePieceStatus(value, entry)));

      if (!raw.disabledAt) {
        desired.add(raw.pieceId);
      }
    }

    const toRemove = scheduled.filter((pieceId) => !desired.has(pieceId));

    for (const pieceId of toRemove) {
      this.#enabledPieces.delete(pieceId);
      this.#pendingTasks = this.#pendingTasks.filter((task) =>
        task.pieceId !== pieceId
      );
    }

    console.log(
      `${this.#did} Piece scheduling ${this.#enabledPieces.size} piece updaters`,
    );
    return cancel;
  }

  /** Starts the scheduling loop; does nothing if it is already running. */
  start(): void {
    if (this.#isRunning) {
      return;
    }
    this.#isRunning = true;
    console.log(`${this.#did} Piece scheduler starting...`);
    this.#execLoop();
  }

  /**
   * Stops the scheduling loop, waits for a piece in flight to finish or for
   * the deactivation timeout to pass, whichever is first, and shuts the
   * worker controller down.
   */
  async stop(): Promise<void> {
    console.log(`${this.#did} Stopping piece scheduler...`);
    this.#isRunning = false;

    // Wait for active jobs to finish with a timeout
    if (this.#activePiece) {
      await Promise.race([
        sleep(this.#deactivationTimeoutMs),
        new Promise((resolve) => {
          const checkInterval = setInterval(() => {
            if (!this.#activePiece) {
              clearInterval(checkInterval);
              resolve(true);
            }
          }, this.#pollingIntervalMs);
        }),
      ]);
    }

    await this.#workerController.shutdown();
  }

  /**
   * Runs the scheduling loop: while running, hands the head of the queue to
   * `#processPiece()` once it is due, the worker is ready, and no piece is in
   * flight, polling between checks.
   */
  async #execLoop(): Promise<void> {
    while (this.#isRunning) {
      if (!this.#workerController.isReady()) {
        await sleep(this.#pollingIntervalMs);
        continue;
      }

      if (this.#activePiece) {
        await sleep(this.#pollingIntervalMs);
        continue;
      }

      if (
        this.#pendingTasks.length === 0 ||
        this.#pendingTasks[0].timestamp > Date.now()
      ) {
        await sleep(this.#pollingIntervalMs);
        continue;
      }

      const { pieceId, entry, timestamp: _ } = this.#pendingTasks.shift()!;

      this.#processPiece(pieceId, entry);
    }
  }

  /**
   * Runs one piece through the worker controller and records the outcome,
   * skipping a piece whose entry has been disabled.
   */
  async #processPiece(pieceId: string, entry: Cell<BGPieceEntry>) {
    const raw = entry.get();

    if (raw.disabledAt) {
      console.log(`${this.#did} Piece ${pieceId} is disabled, skipping`);
      return;
    }

    console.log(`${this.#did} Starting ${raw.integration} ${raw.pieceId}`);

    this.#activePiece = entry;

    try {
      await this.#workerController.runPiece(entry);
      this.#onProcessSuccess(pieceId, entry);
    } catch (error) {
      const errorString = error instanceof Error
        ? error.message
        : String(error);
      console.error(`${this.#did} ${errorString}`);
      this.#onProcessFail(pieceId, entry, errorString);
    }
    this.#activePiece = null;
  }

  /**
   * Queues a run of `pieceId` due `whenInMs` from now, the rerun interval by
   * default, keeping the queue ordered by due time.
   */
  #pushTask(
    pieceId: string,
    entry: Cell<BGPieceEntry>,
    whenInMs?: number,
  ) {
    const when = whenInMs ?? this.#rerunIntervalMs;
    const timestamp = Date.now() + when;
    this.#pendingTasks.push({
      pieceId,
      timestamp,
      entry,
    });

    this.#pendingTasks.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Handler for a watched entry's value, run when the watch is established
   * and again on each change, which schedules a piece that is enabled and not
   * yet scheduled, and drops one that has become disabled.
   */
  #updatePieceStatus(raw: BGPieceEntry, entry: Cell<BGPieceEntry>) {
    const pieceId = raw.pieceId;
    const enabled = !raw.disabledAt;
    const currentlyScheduled = this.#enabledPieces.has(pieceId) ||
      this.#activePiece?.get().pieceId === pieceId;

    if (enabled) {
      // if we aren't already scheduling this piece, add it to the list
      if (!currentlyScheduled) {
        this.#enabledPieces.set(pieceId, entry);
        this.#pushTask(pieceId, entry, 0);
      }
    } else {
      // if we are disabling a piece, remove it from the list
      if (currentlyScheduled) {
        this.#enabledPieces.delete(pieceId);
        this.#pendingTasks = this.#pendingTasks.filter((r) =>
          r.pieceId !== pieceId
        );
      }
    }
  }

  /**
   * Records a successful run on the entry, clears the piece's failure count,
   * and queues its next run if it is still enabled.
   */
  #onProcessSuccess(pieceId: string, entry: Cell<BGPieceEntry>) {
    // If previous runs have failed, clear out the counter
    if (this.#failureTracking.has(pieceId)) {
      this.#failureTracking.delete(pieceId);
    }

    entry.runtime.editWithRetry((tx) => {
      entry.withTx(tx).update({
        lastRun: Date.now(),
        status: "Success",
      });
    });

    if (this.#enabledPieces.has(pieceId)) {
      this.#pushTask(pieceId, entry);
    }
  }

  /**
   * Records a failed run on the entry and, if the piece is still enabled,
   * queues a retry with a linearly growing delay; the third failure in a row
   * disables the piece instead.
   */
  #onProcessFail(
    pieceId: string,
    entry: Cell<BGPieceEntry>,
    error: string,
  ) {
    const failureCount = (this.#failureTracking.get(pieceId) ?? 0) + 1;

    // If we've received graph errors 3 times in a row,
    // disable the piece.
    if (failureCount >= 3) {
      this.#failureTracking.delete(pieceId);
      this.#disablePiece(pieceId, entry, error);
    } else {
      this.#failureTracking.set(pieceId, failureCount);
      entry.runtime.editWithRetry((tx) => {
        entry.withTx(tx).update({
          lastRun: Date.now(),
          status: error,
        });
      });

      if (this.#enabledPieces.has(pieceId)) {
        // Apply a linear backoff for the next attempts
        this.#pushTask(
          pieceId,
          entry,
          this.#rerunIntervalMs * (failureCount + 1),
        );
      }
    }
  }

  /**
   * Disables `pieceId`, recording `error` as the reason on its entry, and
   * drops its queued runs.
   */
  #disablePiece(
    pieceId: string,
    entry: Cell<BGPieceEntry>,
    error: string,
  ) {
    entry.runtime.editWithRetry((tx) => {
      entry.withTx(tx).update({
        disabledAt: Date.now(),
        lastRun: Date.now(),
        status: `Disabled: ${error}`,
      });
    });

    this.#enabledPieces.delete(pieceId);
    this.#pendingTasks = this.#pendingTasks.filter((r) =>
      r.pieceId !== pieceId
    );
  }

  /** Disables every enabled piece in the space, recording `reason` on each. */
  #disableSpace(reason: string) {
    console.log(`${this.#did} Disabling space: ${reason}`);
    for (const [pieceId, entry] of this.#enabledPieces.entries()) {
      this.#disablePiece(pieceId, entry, reason);
    }
  }

  /**
   * Handler for the event `WorkerController` fires when a terminal error
   * occurs (e.g. outside of the graph), which may happen at any point during
   * execution. Because this can occur from a piece calling
   * `setTimeout(() => throw new Error(""), timeout)`, we cannot determine the
   * offending piece. Because this should not occur frequently, this should
   * flush out misbehaving pieces.
   *
   * It attempts to recreate the worker environment, which should only occur
   * once per space-wide disabling.
   */
  #onTerminalError = (event: Event) => {
    // `addEventListener` types its listener over `Event`; the narrowing
    // recovers the controller's own event type, and anything else here is a
    // bug worth hearing about rather than a space left running on a dead
    // worker.
    if (!(event instanceof WorkerControllerErrorEvent)) {
      console.error(
        `${this.#did} Terminal error listener got a \`${event.type}\` event that is not a \`WorkerControllerErrorEvent\``,
      );
      return;
    }
    console.error(
      `${this.#did} Terminal error received: ${event.error?.message}`,
    );

    const reason =
      `TerminalError: All pieces in this space have been disabled: ${event.error?.message}`;
    this.#disableSpace(reason);
    this.#setupWorkerController();
  };

  /**
   * Replaces the worker controller with a fresh one, listening for its
   * terminal errors, and shuts the previous one down. A controller that fails
   * to initialize disables the space and is replaced in turn.
   */
  async #setupWorkerController() {
    const previousWorker = this.#workerController;
    const newWorker = new WorkerController(this.#workerOptions);
    newWorker.addEventListener(
      "error",
      this.#onTerminalError,
    );
    this.#workerController = newWorker;

    if (previousWorker) {
      console.log(`${this.#did} Restarting Worker Controller`);
      previousWorker.removeEventListener("error", this.#onTerminalError);
      previousWorker.shutdown().catch((e) => {
        console.warn(
          `Could not shutdown old worker ${this.#did} after restarting: ${e}`,
        );
      });
    }

    try {
      await newWorker.ready;
      console.log(`${this.#did} Worker controller ready for work`);
    } catch (e) {
      // Initialization error. This "should not" occur, but is seen on invalid IPC requests
      // during initialization.
      // Disable all pieces in this space and attempt to recreate the worker.
      console.error(`${this.#did} failed to initialize: ${e}`);
      this.#disableSpace(`Failed to initialize worker.`);
      this.#setupWorkerController();
    }
  }
}
