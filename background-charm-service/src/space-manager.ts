import { BGCharmEntry, sleep } from "@commontools/utils";
import { Cell } from "@commontools/runner";
import { log } from "./utils.ts";
import { WorkerController, type WorkerOptions } from "./worker-controller.ts";
import { type Cancel, useCancelGroup } from "@commontools/runner";

export interface CharmSchedulerOptions extends WorkerOptions {
  pollingIntervalMs?: number;
  deactivationTimeoutMs?: number;
  rerunIntervalMs?: number;
}

type RunBg = {
  charmId: string;
  timestamp: number;
  bg: Cell<BGCharmEntry>;
};

export class SpaceManager {
  private did: string;
  private pollingIntervalMs: number;
  private schedulableBgs = new Map<string, Cell<BGCharmEntry>>();
  private activeBg: Cell<BGCharmEntry> | null = null;
  private deactivationTimeoutMs: number;
  private workerController: WorkerController;
  private rerunIntervalMs: number;
  private pendingRuns: RunBg[] = [];

  constructor(options: CharmSchedulerOptions) {
    this.did = options.did;
    this.pollingIntervalMs = options.pollingIntervalMs ?? 100;
    this.deactivationTimeoutMs = options.deactivationTimeoutMs ?? 10000;
    this.rerunIntervalMs = options.rerunIntervalMs ?? 60000;
    this.workerController = new WorkerController(options);

    log(
      `${this.did} Charm scheduler initialized | pollingIntervalMs: ${this.pollingIntervalMs} | deactivationTimeoutMs: ${this.deactivationTimeoutMs} | rerunIntervalMs: ${this.rerunIntervalMs}`,
    );
  }

  private addPendingRun(
    charmId: string,
    bg: Cell<BGCharmEntry>,
    secondsFromNow: number = 0,
  ) {
    const timestamp = Date.now() + (secondsFromNow * 1000);
    this.pendingRuns.push({
      charmId,
      timestamp,
      bg,
    });

    this.pendingRuns.sort((a, b) => a.timestamp - b.timestamp);
  }

  private updateCharmStatus(b: BGCharmEntry, c: Cell<BGCharmEntry>) {
    const charmId = b.charmId;
    const enabled = !b.disabledAt;
    const currentlyScheduled = this.schedulableBgs.has(charmId) ||
      this.activeBg?.get().charmId === charmId;

    if (enabled) {
      // if we aren't already scheuduling this charm, add it to the list
      if (!currentlyScheduled) {
        this.schedulableBgs.set(charmId, c);
        this.addPendingRun(charmId, c);
      }
    } else {
      // if we are disabling a charm, remove it from the list
      if (currentlyScheduled) {
        this.schedulableBgs.delete(charmId);
        this.pendingRuns = this.pendingRuns.filter((r) =>
          r.charmId !== charmId
        );
      }
    }
  }

  // Update the list of charms to watch (removing any charms that are no longer in the list)
  watch(bg: Cell<BGCharmEntry>[]): Cancel {
    const [cancel, addCancel] = useCancelGroup();

    const scheduled = Array.from(this.schedulableBgs.keys());
    const desired = new Set();

    for (const c of bg) {
      const b = c.get();
      addCancel(c.sink((b) => this.updateCharmStatus(b, c)));

      if (!b.disabledAt) {
        desired.add(b.charmId);
      }
    }

    const toRemove = scheduled.filter((c) => !desired.has(c));

    for (const c of toRemove) {
      this.schedulableBgs.delete(c);
      this.pendingRuns = this.pendingRuns.filter((r) => r.charmId !== c);
    }

    log(
      `${this.did} Charm scheduling ${this.schedulableBgs.size} charm updaters`,
    );
    return cancel;
  }

  async start(): Promise<void> {
    log(`${this.did} Charm scheduler starting...`);
    await this.workerController.initialize();
    log(`${this.did} Worker controller ready for work`);
    this.execLoop();
  }

  async stop(): Promise<void> {
    log(`${this.did} Stopping charm scheduler...`);

    // Wait for active jobs to finish with a timeout
    if (this.activeBg) {
      await Promise.race([
        sleep(this.deactivationTimeoutMs),
        new Promise((resolve) => {
          const checkInterval = setInterval(() => {
            if (!this.activeBg) {
              clearInterval(checkInterval);
              resolve(true);
            }
          }, this.pollingIntervalMs);
        }),
      ]);
    }

    // FIXME(ja): stop web worker!
    await this.workerController.shutdown();
  }

  private async execLoop(): Promise<void> {
    while (true) {
      if (this.activeBg) {
        await sleep(this.pollingIntervalMs);
        continue;
      }

      if (
        this.pendingRuns.length === 0 ||
        this.pendingRuns[0].timestamp > Date.now()
      ) {
        await sleep(this.pollingIntervalMs);
        continue;
      }

      const { charmId, bg, timestamp } = this.pendingRuns.shift()!;

      this.processCharm(charmId, bg);
    }
  }

  private async processCharm(charmId: string, bg: Cell<BGCharmEntry>) {
    const b = bg.get();

    if (b.disabledAt) {
      log(`${this.did} Charm ${charmId} is disabled, skipping`);
      return;
    }

    log(`${this.did} Starting ${b.integration} ${b.charmId}`);

    this.activeBg = bg;

    try {
      await this.workerController.runCharm(bg);
      this.recordSuccess(charmId, bg);
    } catch (error) {
      const errorString = error instanceof Error
        ? error.message
        : String(error);
      log(`${this.did} ${errorString}`, {
        error: true,
      });
      this.disableCharm(charmId, bg, errorString);
    }
    this.activeBg = null;
  }

  private recordSuccess(charmId: string, bg: Cell<BGCharmEntry>) {
    bg.update({
      lastRun: Date.now(),
      status: "Success",
    });
    if (this.schedulableBgs.has(charmId)) {
      this.addPendingRun(charmId, bg, this.rerunIntervalMs / 1000);
    }
  }

  private disableCharm(
    charmId: string,
    bg: Cell<BGCharmEntry>,
    error?: string,
  ) {
    bg.update({
      disabledAt: Date.now(),
      lastRun: Date.now(),
      status: error ? error : "Disabled",
    });
    this.schedulableBgs.delete(charmId);
    this.pendingRuns = this.pendingRuns.filter((r) => r.charmId !== charmId);
  }
}
