import { type Cancel, Cell, useCancelGroup } from "@commonfabric/runner";
import { sleep } from "@commonfabric/utils/sleep";

import { type BGPieceEntry } from "./schema.ts";
import {
  WorkerController,
  WorkerControllerErrorEvent,
  type WorkerOptions,
} from "./worker-controller.ts";

export interface PieceSchedulerOptions extends WorkerOptions {
  pollingIntervalMs?: number;
  deactivationTimeoutMs?: number;
  rerunIntervalMs?: number;
}

type Task = {
  pieceId: string;
  timestamp: number;
  entry: Cell<BGPieceEntry>;
};

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
   * the scheduling tables, the running flag, the worker controller, and the
   * loop and the two steps it takes. A field this class reassigns is read and
   * written through this object as through the instance itself; the two
   * tables it never reassigns are handed over as they are.
   *
   * The name is the documentation. Nothing here is part of what this class
   * promises, and code that reaches through it is written against internals
   * that are free to change.
   */
  get accessForTestingOnly(): {
    activePiece: Cell<BGPieceEntry> | null;
    enabledPieces: Map<string, Cell<BGPieceEntry>>;
    failureTracking: Map<string, number>;
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

  #updatePieceStatus(b: BGPieceEntry, c: Cell<BGPieceEntry>) {
    const pieceId = b.pieceId;
    const enabled = !b.disabledAt;
    const currentlyScheduled = this.#enabledPieces.has(pieceId) ||
      this.#activePiece?.get().pieceId === pieceId;

    if (enabled) {
      // if we aren't already scheduling this piece, add it to the list
      if (!currentlyScheduled) {
        this.#enabledPieces.set(pieceId, c);
        this.#pushTask(pieceId, c, 0);
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

  // Update the list of pieces to watch (removing any pieces that are no longer in the list)
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

  start(): void {
    if (this.#isRunning) {
      return;
    }
    this.#isRunning = true;
    console.log(`${this.#did} Piece scheduler starting...`);
    this.#execLoop();
  }

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

  #disableSpace(reason: string) {
    console.log(`${this.#did} Disabling space: ${reason}`);
    for (const [pieceId, entry] of this.#enabledPieces.entries()) {
      this.#disablePiece(pieceId, entry, reason);
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
  #onTerminalError = (event: WorkerControllerErrorEvent) => {
    console.error(
      `${this.#did} Terminal error received: ${event.error?.message}`,
    );

    const reason =
      `TerminalError: All pieces in this space have been disabled: ${event.error?.message}`;
    this.#disableSpace(reason);
    this.#setupWorkerController();
  };

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
      await newWorker.initializeResolve;
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
