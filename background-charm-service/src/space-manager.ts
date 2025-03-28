import { BGCharmEntry, sleep } from "@commontools/utils";
import { Cell } from "@commontools/runner";
import { log } from "./utils.ts";
import { WorkerController } from "./worker-controller.ts";
import { type Cancel, useCancelGroup } from "@commontools/runner";
import { Identity } from "@commontools/identity";

type CharmSchedulerOptions = {
  did: string;
  toolshedUrl: string;
  identity: Identity;
  maxConcurrentJobs?: number;
  maxRetries?: number;
  pollingIntervalMs?: number;
  deactivationTimeoutMs?: number;
  rerunIntervalMs?: number;
  timeoutMs?: number;
};

type RunBg = {
  charmId: string;
  timestamp: number;
  bg: Cell<BGCharmEntry>;
};

export class SpaceManager {
  private did: string;
  private maxConcurrentJobs: number;
  private maxRetries: number;
  private pollingIntervalMs: number;
  private schedulableBgs = new Map<string, Cell<BGCharmEntry>>();
  private activeBg: Cell<BGCharmEntry> | null = null;
  private deactivationTimeoutMs: number;
  private workerController: WorkerController;
  private rerunIntervalMs: number;
  private timeoutMs: number;
  private pendingRuns: RunBg[] = [];

  constructor(options: CharmSchedulerOptions) {
    this.did = options.did;
    this.maxConcurrentJobs = options.maxConcurrentJobs ?? 5;
    this.maxRetries = options.maxRetries ?? 3;
    this.pollingIntervalMs = options.pollingIntervalMs ?? 100;
    this.deactivationTimeoutMs = options.deactivationTimeoutMs ?? 10000;
    this.rerunIntervalMs = options.rerunIntervalMs ?? 60000;
    this.workerController = new WorkerController(this.did);
    this.timeoutMs = options.timeoutMs ?? 10000;
    log(`Charm scheduler initialized`);
    log(` - did: ${this.did}`);
    log(` - maxConcurrentJobs: ${this.maxConcurrentJobs}`);
    log(` - maxRetries: ${this.maxRetries}`);
    log(` - pollingIntervalMs: ${this.pollingIntervalMs}`);
    log(` - deactivationTimeoutMs: ${this.deactivationTimeoutMs}`);
    log(` - rerunIntervalMs: ${this.rerunIntervalMs}`);

    this.workerController.setupWorker(
      options.toolshedUrl,
      options.identity,
    ).then(
      () => {
        log(`Worker controller ${this.did} ready for work`);
      },
    ).catch((err) => {
      log(`Failed to setup worker controller: ${err}`);
    });

    this.execLoop();
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
        console.log("timestamp adding charm", charmId);
        this.schedulableBgs.set(charmId, c);
        this.addPendingRun(charmId, c);
      }
    } else {
      // if we are disabling a charm, remove it from the list
      if (currentlyScheduled) {
        console.log("timestamp removing charm", charmId);
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

    log(`Charm scheduling ${this.schedulableBgs.size} charm updaters`);
    return cancel;
  }

  start() {
    log("Charm scheduler started");
  }

  async stop(): Promise<void> {
    log("Stopping charm scheduler...");

    // Wait for active jobs to finish with a timeout
    if (this.activeBg) {
      log(`Waiting for active charm to complete...`);
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
    this.workerController.shutdown();
  }

  getStatus() {
    return {
      running: this.workerController.ready,
      activeCharm: this.activeBg,
      scheduledCharms: this.schedulableBgs.size,
      pendingRuns: this.pendingRuns.length,
    };
  }

  private async execLoop(): Promise<void> {
    while (true) {
      // fixme(ja): we could await a race of the following:
      if (!this.workerController.ready) {
        log("worker controller not ready, sleeping");
        await sleep(this.pollingIntervalMs);
        continue;
      }

      if (this.activeBg) {
        log("active charm, sleeping");
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

  private processCharm(charmId: string, bg: Cell<BGCharmEntry>) {
    log(`processCharm ${charmId}`);

    const b = bg.get();

    if (b.disabledAt) {
      log(`Charm ${charmId} is disabled, skipping`);
      return;
    }

    log(`Starting ${b.integration} ${b.charmId} (${b.space})`);

    this.activeBg = bg;

    Promise.race([
      this.workerController.runCharm(bg).catch((e) => {
        log(e instanceof Error ? e.message : String(e), {
          error: true,
        });
        return {
          success: false,
          error: e instanceof Error ? e.message : String(e),
          charmId,
        };
      }),
      sleep(this.timeoutMs).then(() => ({
        success: false,
        error: "Timeout while running charm",
      })),
    ]).then((result) => {
      if (!result.success) {
        this.disableCharm(charmId, bg);
      } else {
        this.recordSuccess(charmId, bg);
      }
    }).finally(() => {
      this.activeBg = null;
    });
  }

  private recordSuccess(charmId: string, bg: Cell<BGCharmEntry>) {
    bg.update({
      lastRun: Date.now(),
    });
    if (this.schedulableBgs.has(charmId)) {
      this.addPendingRun(charmId, bg, this.rerunIntervalMs / 1000);
    }
  }

  private disableCharm(charmId: string, bg: Cell<BGCharmEntry>) {
    bg.update({
      disabledAt: Date.now(),
      lastRun: Date.now(),
    });
    this.schedulableBgs.delete(charmId);
    this.pendingRuns = this.pendingRuns.filter((r) => r.charmId !== charmId);
  }
}
