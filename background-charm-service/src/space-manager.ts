import { sleep } from "@commontools/utils";
import { Cell } from "@commontools/runner";
import { type Cancel, useCancelGroup } from "@commontools/runner";
import {
  WorkerController,
  WorkerControllerErrorEvent,
  type WorkerOptions,
} from "./worker-controller.ts";
import { type BGCharmEntry } from "./schema.ts";

export interface CharmSchedulerOptions extends WorkerOptions {
  pollingIntervalMs?: number;
  deactivationTimeoutMs?: number;
  rerunIntervalMs?: number;
}

type Task = {
  charmId: string;
  timestamp: number;
  entry: Cell<BGCharmEntry>;
};

export class SpaceManager {
  private did: string;
  private pollingIntervalMs: number;
  private enabledCharms = new Map<string, Cell<BGCharmEntry>>();
  private activeCharm: Cell<BGCharmEntry> | null = null;
  private deactivationTimeoutMs: number;
  private workerController!: WorkerController;
  private rerunIntervalMs: number;
  private pendingTasks: Task[] = [];
  private failureTracking = new Map<string, number>();
  private workerOptions: WorkerOptions;

  constructor(options: CharmSchedulerOptions) {
    this.did = options.did;
    this.pollingIntervalMs = options.pollingIntervalMs ?? 100;
    this.deactivationTimeoutMs = options.deactivationTimeoutMs ?? 10000;
    this.rerunIntervalMs = options.rerunIntervalMs ?? 60000;
    this.workerOptions = options;
    this.setupWorkerController();

    console.log(
      `${this.did} Charm scheduler initialized | pollingIntervalMs: ${this.pollingIntervalMs} | deactivationTimeoutMs: ${this.deactivationTimeoutMs} | rerunIntervalMs: ${this.rerunIntervalMs}`,
    );
  }

  private pushTask(
    charmId: string,
    entry: Cell<BGCharmEntry>,
    whenInMs?: number,
  ) {
    const when = whenInMs ?? this.rerunIntervalMs;
    const timestamp = Date.now() + when;
    this.pendingTasks.push({
      charmId,
      timestamp,
      entry,
    });

    this.pendingTasks.sort((a, b) => a.timestamp - b.timestamp);
  }

  private updateCharmStatus(b: BGCharmEntry, c: Cell<BGCharmEntry>) {
    const charmId = b.charmId;
    const enabled = !b.disabledAt;
    const currentlyScheduled = this.enabledCharms.has(charmId) ||
      this.activeCharm?.get().charmId === charmId;

    if (enabled) {
      // if we aren't already scheduling this charm, add it to the list
      if (!currentlyScheduled) {
        this.enabledCharms.set(charmId, c);
        this.pushTask(charmId, c, 0);
      }
    } else {
      // if we are disabling a charm, remove it from the list
      if (currentlyScheduled) {
        this.enabledCharms.delete(charmId);
        this.pendingTasks = this.pendingTasks.filter((r) =>
          r.charmId !== charmId
        );
      }
    }
  }

  // Update the list of charms to watch (removing any charms that are no longer in the list)
  watch(entries: Cell<BGCharmEntry>[]): Cancel {
    const [cancel, addCancel] = useCancelGroup();

    const scheduled = Array.from(this.enabledCharms.keys());
    const desired = new Set();

    for (const entry of entries) {
      const raw = entry.get();
      addCancel(entry.sink((value) => this.updateCharmStatus(value, entry)));

      if (!raw.disabledAt) {
        desired.add(raw.charmId);
      }
    }

    const toRemove = scheduled.filter((charmId) => !desired.has(charmId));

    for (const charmId of toRemove) {
      this.enabledCharms.delete(charmId);
      this.pendingTasks = this.pendingTasks.filter((task) =>
        task.charmId !== charmId
      );
    }

    console.log(
      `${this.did} Charm scheduling ${this.enabledCharms.size} charm updaters`,
    );
    return cancel;
  }

  start(): void {
    console.log(`${this.did} Charm scheduler starting...`);
    this.execLoop();
  }

  async stop(): Promise<void> {
    console.log(`${this.did} Stopping charm scheduler...`);

    // Wait for active jobs to finish with a timeout
    if (this.activeCharm) {
      await Promise.race([
        sleep(this.deactivationTimeoutMs),
        new Promise((resolve) => {
          const checkInterval = setInterval(() => {
            if (!this.activeCharm) {
              clearInterval(checkInterval);
              resolve(true);
            }
          }, this.pollingIntervalMs);
        }),
      ]);
    }

    await this.workerController.shutdown();
  }

  private async execLoop(): Promise<void> {
    while (true) {
      if (!this.workerController.isReady()) {
        await sleep(this.pollingIntervalMs);
        continue;
      }

      if (this.activeCharm) {
        await sleep(this.pollingIntervalMs);
        continue;
      }

      if (
        this.pendingTasks.length === 0 ||
        this.pendingTasks[0].timestamp > Date.now()
      ) {
        await sleep(this.pollingIntervalMs);
        continue;
      }

      const { charmId, entry, timestamp } = this.pendingTasks.shift()!;

      this.processCharm(charmId, entry);
    }
  }

  private async processCharm(charmId: string, entry: Cell<BGCharmEntry>) {
    const raw = entry.get();

    if (raw.disabledAt) {
      console.log(`${this.did} Charm ${charmId} is disabled, skipping`);
      return;
    }

    console.log(`${this.did} Starting ${raw.integration} ${raw.charmId}`);

    this.activeCharm = entry;

    try {
      await this.workerController.runCharm(entry);
      this.onProcessSuccess(charmId, entry);
    } catch (error) {
      const errorString = error instanceof Error
        ? error.message
        : String(error);
      console.error(`${this.did} ${errorString}`);
      this.onProcessFail(charmId, entry, errorString);
    }
    this.activeCharm = null;
  }

  private onProcessSuccess(charmId: string, entry: Cell<BGCharmEntry>) {
    // If previous runs have failed, clear out the counter
    if (this.failureTracking.has(charmId)) {
      this.failureTracking.delete(charmId);
    }

    entry.update({
      lastRun: Date.now(),
      status: "Success",
    });

    if (this.enabledCharms.has(charmId)) {
      this.pushTask(charmId, entry);
    }
  }

  private onProcessFail(
    charmId: string,
    entry: Cell<BGCharmEntry>,
    error: string,
  ) {
    const failureCount = (this.failureTracking.get(charmId) ?? 0) + 1;

    // If we've received graph errors 3 times in a row,
    // disable the charm.
    if (failureCount >= 3) {
      this.failureTracking.delete(charmId);
      this.disableCharm(charmId, entry, error);
    } else {
      this.failureTracking.set(charmId, failureCount);
      entry.update({
        lastRun: Date.now(),
        status: error,
      });
      if (this.enabledCharms.has(charmId)) {
        // Apply a linear backoff for the next attempts
        this.pushTask(
          charmId,
          entry,
          this.rerunIntervalMs * (failureCount + 1),
        );
      }
    }
  }

  private disableCharm(
    charmId: string,
    entry: Cell<BGCharmEntry>,
    error: string,
  ) {
    entry.update({
      disabledAt: Date.now(),
      lastRun: Date.now(),
      status: `Disabled: ${error}`,
    });
    this.enabledCharms.delete(charmId);
    this.pendingTasks = this.pendingTasks.filter((r) => r.charmId !== charmId);
  }

  // This is fired from `WorkerController` when an terminal error
  // occurs (e.g. outside of the graph), and may happen at any point
  // during execution.
  // Because this can occur from a charm calling `setTimeout(() => throw new Error(""), timeout)`
  // we cannot determine the offending charm. Because this should not occur frequently,
  // and happening currently due to older, misbehaving charms, this should flush out
  // those misbehaving charms.
  //
  // Attempt to recreate the worker environment, which should only occur once per
  // space-wide disabling.
  private onTerminalError = (event: WorkerControllerErrorEvent) => {
    console.error(
      `${this.did} Terminal error received: ${event.error?.message}`,
    );

    const reason =
      `TerminalError: All charms in this space have been disabled: ${event.error?.message}`;
    for (const [charmId, entry] of this.enabledCharms.entries()) {
      this.disableCharm(charmId, entry, reason);
    }
    this.setupWorkerController();
  };

  private async setupWorkerController() {
    const previousWorker = this.workerController;
    const newWorker = new WorkerController(this.workerOptions);
    newWorker.addEventListener(
      "error",
      this.onTerminalError,
    );
    this.workerController = newWorker;

    const tasks = [
      newWorker.initialize().then(() => {
        console.log(`${this.did} Worker controller ready for work`);
      }),
    ];

    if (previousWorker) {
      console.log(`${this.did} Restarting Worker Controller`);
      previousWorker.removeEventListener("error", this.onTerminalError);
      tasks.push(previousWorker.shutdown());
    }

    await Promise.all(tasks);
  }
}
