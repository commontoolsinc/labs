import { BGCharmEntry, sleep } from "@commontools/utils";
import { Cell } from "@commontools/runner";
import { log } from "./utils.ts";
import { WorkerController } from "./worker-controller.ts";

type CharmSchedulerOptions = {
  did: string;
  toolshedUrl: string;
  operatorPass: string;
  maxConcurrentJobs?: number;
  maxRetries?: number;
  pollingIntervalMs?: number;
  deactivationTimeoutMs?: number;
  rerunIntervalMs?: number;
  timeoutMs?: number;
};

type CharmStatus = {
  bg: Cell<BGCharmEntry>;
  enabled: boolean;
};

export class SpaceManager {
  private did: string;
  private maxConcurrentJobs: number;
  private maxRetries: number;
  private pollingIntervalMs: number;
  private state = new Map<string, CharmStatus>();
  private pendingCharms: string[] = [];
  private activeCharms = new Set<string>();
  private deactivationTimeoutMs: number;
  private workerController: WorkerController;
  private rerunIntervalMs: number;
  private timeoutMs: number;

  constructor(options: CharmSchedulerOptions) {
    this.did = options.did;
    this.maxConcurrentJobs = options.maxConcurrentJobs ?? 5;
    this.maxRetries = options.maxRetries ?? 3;
    this.pollingIntervalMs = options.pollingIntervalMs ?? 100;
    this.deactivationTimeoutMs = options.deactivationTimeoutMs ?? 10000;
    this.rerunIntervalMs = options.rerunIntervalMs ?? 6000;
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
      options.operatorPass,
    ).then(
      () => {
        log(`Worker controller ${this.did} ready for work`);
      },
    ).catch((err) => {
      log(`Failed to setup worker controller: ${err}`);
    });

    this.execLoop();
    this.requeueLoop();
  }

  // Update the list of charms to watch (removing any charms that are no longer in the list)
  watch(bg: Cell<BGCharmEntry>[]) {
    const localCharms = Array.from(this.state.keys());

    const serverCharms = new Set<string>();

    for (const b of bg) {
      const serverState = b.get();
      serverCharms.add(serverState.charmId);

      const localState = this.state.get(serverState.charmId);

      if (!localState) {
        this.state.set(serverState.charmId, {
          bg: b,
          enabled: !serverState.disabledAt,
        });
        this.pendingCharms.push(serverState.charmId);
      } else {
        // if server thinks charms disabled state has changed, update our state
        if (!serverState.disabledAt && !localState.enabled) {
          this.state.set(serverState.charmId, {
            ...localState,
            enabled: true,
          });
          this.pendingCharms.push(serverState.charmId);
        } else if (serverState.disabledAt && localState.enabled) {
          this.state.set(serverState.charmId, {
            ...localState,
            enabled: false,
          });
          this.pendingCharms = this.pendingCharms.filter((job) =>
            job !== serverState.charmId
          );
        }
      }
    }

    const removedCharms = localCharms.filter((key) => !serverCharms.has(key));
    removedCharms.forEach((key) => this.state.delete(key));

    log(`Charm scheduler monitoring ${serverCharms.size} charms`);
  }

  start() {
    log("Charm scheduler started");
  }

  async stop(): Promise<void> {
    log("Stopping charm scheduler...");

    // Wait for active jobs to finish with a timeout
    if (this.activeCharms.size > 0) {
      log(`Waiting for ${this.activeCharms.size} active jobs to complete...`);
      await Promise.race([
        sleep(this.deactivationTimeoutMs),
        new Promise((resolve) => {
          const checkInterval = setInterval(() => {
            if (this.activeCharms.size === 0) {
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
      activeJobs: this.activeCharms.size,
      pendingJobs: this.pendingCharms.length,
    };
  }

  private async execLoop(): Promise<void> {
    while (true) {
      if (!this.workerController.ready) {
        log("worker controller not ready, sleeping");
        await sleep(this.pollingIntervalMs);
        continue;
      }

      if (this.activeCharms.size >= this.maxConcurrentJobs) {
        log("active jobs >= max concurrent jobs, sleeping");
        await sleep(this.pollingIntervalMs);
        continue;
      }

      const charmId = this.pendingCharms.shift();

      // skip any charms already running...
      if (!charmId || this.activeCharms.has(charmId)) {
        await sleep(this.pollingIntervalMs);
        continue;
      }

      this.processCharm(charmId);
    }
  }

  private processCharm(
    charmId: string,
  ) {
    log(`processCharm ${charmId}`);
    const bg = this.state.get(charmId)?.bg;
    if (!bg) {
      log(`Charm ${charmId} not found in state`, {
        error: true,
      });
      return;
    }

    log(
      `Starting ${bg.get().integration} ${bg.get().charmId} (${bg.get().space})`,
    );

    this.activeCharms.add(charmId);

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
        this.disableCharm(charmId);
      } else {
        this.enableCharm(charmId);
      }
    }).finally(() => {
      this.activeCharms.delete(charmId);
    });
  }

  private enableCharm(charmId: string) {
    const charm = this.state.get(charmId);
    if (!charm) {
      return;
    }
    charm.bg.set({
      ...charm.bg.get(),
      disabledAt: undefined,
      lastRun: Date.now(),
    });
    charm.enabled = true;
  }

  private disableCharm(charmId: string) {
    const charm = this.state.get(charmId);
    if (!charm) {
      return;
    }
    charm.bg.set({
      ...charm.bg.get(),
      disabledAt: Date.now(),
      lastRun: Date.now(),
    });
    charm.enabled = false;
  }

  private async requeueLoop(): Promise<void> {
    while (true) {
      await sleep(this.rerunIntervalMs);
      if (this.workerController.ready) {
        for (const charmId of this.state.keys()) {
          if (
            !this.activeCharms.has(charmId) &&
            !this.pendingCharms.includes(charmId) &&
            this.state.get(charmId)?.enabled
          ) {
            this.pendingCharms.push(charmId);
            log(`Requeued charm: ${charmId}`);
          }
        }
      } else {
        await sleep(this.pollingIntervalMs);
      }
    }
  }
}
