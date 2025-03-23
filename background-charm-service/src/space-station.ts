import { BGCharmEntry, sleep } from "@commontools/utils";
import { Cell } from "@commontools/runner";
import { log } from "./utils.ts";
import { Habitat } from "./habitat.ts";

type SpaceStationOptions = {
  did: string;
  maxConcurrentJobs?: number;
  maxRetries?: number;
  pollingIntervalMs?: number;
  deactivationTimeoutMs?: number;
  rerunIntervalMs?: number;
  timeoutMs?: number;
};

export class SpaceStation {
  private did: string;
  private running = false;
  private maxConcurrentJobs: number;
  private maxRetries: number;
  private pollingIntervalMs: number;
  private bgCharms = new Map<string, Cell<BGCharmEntry>>();
  private pendingJobs: string[] = [];
  private activeJobs = new Set<string>();
  private deactivationTimeoutMs: number;
  private habitat: Habitat;
  private rerunIntervalMs: number;
  private timeoutMs: number;

  constructor(options: SpaceStationOptions) {
    this.did = options.did;
    this.maxConcurrentJobs = options.maxConcurrentJobs ?? 5;
    this.maxRetries = options.maxRetries ?? 3;
    this.pollingIntervalMs = options.pollingIntervalMs ?? 100;
    this.deactivationTimeoutMs = options.deactivationTimeoutMs ?? 10000;
    this.rerunIntervalMs = options.rerunIntervalMs ?? 6000;
    this.habitat = new Habitat(this.did);
    this.timeoutMs = options.timeoutMs ?? 10000;
    log(`Space station initialized`);
    log(` - did: ${this.did}`);
    log(` - maxConcurrentJobs: ${this.maxConcurrentJobs}`);
    log(` - maxRetries: ${this.maxRetries}`);
    log(` - pollingIntervalMs: ${this.pollingIntervalMs}`);
    log(` - deactivationTimeoutMs: ${this.deactivationTimeoutMs}`);
    log(` - rerunIntervalMs: ${this.rerunIntervalMs}`);

    this.loop();
    this.startRequeueLoop();
  }

  // Update the list of charms to watch (removing any charms that are no longer in the list)
  watch(bg: Cell<BGCharmEntry>[]) {
    const oldCharms = Array.from(this.bgCharms.keys());

    const newCharms = new Set<string>();

    for (const b of bg) {
      const charm = b.get();
      newCharms.add(charm.charmId);

      if (!oldCharms.includes(charm.charmId)) {
        this.bgCharms.set(charm.charmId, b);
        this.pendingJobs.push(charm.charmId);
      }
    }

    const removedCharms = oldCharms.filter((key) => !newCharms.has(key));
    removedCharms.forEach((key) => this.bgCharms.delete(key));

    log(`Space station monitoring ${newCharms.size} charms`);
  }

  start(): void {
    if (this.running) {
      log("Space station is already running");
      return;
    }

    log("Space station started");
    this.running = true;
  }

  async stop(): Promise<void> {
    log("Stopping space station...");
    this.running = false;

    // Wait for active jobs to finish with a timeout
    if (this.activeJobs.size > 0) {
      log(`Waiting for ${this.activeJobs.size} active jobs to complete...`);
      await Promise.race([
        sleep(this.deactivationTimeoutMs),
        new Promise((resolve) => {
          const checkInterval = setInterval(() => {
            if (this.activeJobs.size === 0) {
              clearInterval(checkInterval);
              resolve(true);
            }
          }, this.pollingIntervalMs);
        }),
      ]);
    }

    // FIXME(ja): stop web worker!
  }

  getStatus() {
    return {
      running: this.running,
      activeJobs: this.activeJobs.size,
      pendingJobs: this.pendingJobs.length,
    };
  }

  private async loop(): Promise<void> {
    while (true) {
      if (!this.running) {
        await sleep(this.pollingIntervalMs);
        continue;
      }

      if (this.activeJobs.size >= this.maxConcurrentJobs) {
        await sleep(this.pollingIntervalMs);
        continue;
      }

      const job = this.pendingJobs.shift();

      if (!job) {
        await sleep(this.pollingIntervalMs);
        continue;
      }

      // skip any jobs already running...
      // FIXME(ja): is job actually the same for a specific bgcharmentry?
      if (this.activeJobs.has(job)) {
        continue;
      }

      this.activeJobs.add(job);
      this.processCharm(job)
        .catch((e) => {
          log(e instanceof Error ? e.message : String(e), {
            error: true,
          });
          return {
            success: false,
            error: e instanceof Error ? e.message : String(e),
          };
        })
        .then((result) => {
          console.log(result);
        })
        .finally(() => {
          this.activeJobs.delete(job);
        });
    }
  }

  private processCharm(
    charmId: string,
  ): Promise<{ success: boolean; error?: string }> {
    console.log("processCharm", charmId);
    const charm = this.bgCharms.get(charmId);
    if (!charm) {
      return Promise.resolve({
        success: false,
        error: `Charm ${charmId} not found`,
      });
    }

    log(
      `Starting ${charm.get().integration} ${charm.get().charmId} (${charm.get().space})`,
    );

    return Promise.race([
      this.habitat.runCharm(charm),
      sleep(this.timeoutMs).then(() => ({
        success: false,
        error: "Timeout while running charm",
      })),
    ]);
  }

  private async startRequeueLoop(): Promise<void> {
    while (true) {
      await sleep(this.rerunIntervalMs);
      if (this.running) {
        for (const charmId of this.bgCharms.keys()) {
          if (
            !this.activeJobs.has(charmId) && !this.pendingJobs.includes(charmId)
          ) {
            this.pendingJobs.push(charmId);
            log(`Requeued charm: ${charmId}`);
          }
        }
      }
    }
  }
}
