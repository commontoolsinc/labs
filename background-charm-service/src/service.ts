import { Identity } from "@commontools/identity";
import { type Cell, type CellLink, storage } from "@commontools/runner";
import {
  type BGCharmEntry,
  getBGUpdaterCellCharmsCell,
} from "@commontools/utils";
import { JobQueue } from "./job-queue.ts";
import { log } from "./utils.ts";
import { env } from "./env.ts";
import type { CharmStateEntry } from "./types.ts";

export class BackgroundCharmService {
  private charmsCell: Cell<Cell<BGCharmEntry>[]> | null = null;
  private isRunning = false;
  private state: Map<CellLink, CharmStateEntry> = new Map();
  private queue: JobQueue = new JobQueue();

  constructor() {
    this.queue.startConsumer();
  }

  async initialize() {
    storage.setRemoteStorage(new URL(env.MEMORY_URL));
    storage.setSigner(await Identity.fromPassphrase(env.OPERATOR_PASS));
    this.charmsCell = await getBGUpdaterCellCharmsCell();
    await storage.syncCell(this.charmsCell, true);
    await storage.synced();

    this.charmsCell.sink((cs) => this.ensureCharms(cs));
  }

  private ensureCharms(charms: Cell<BGCharmEntry>[]) {
    (charms.get() as Cell<BGCharmEntry>[]).forEach((c) => {
      const cellLink = c.getAsCellLink();
      if (this.state.has(cellLink)) {
        console.log("charm already exists in state");
        // FIXME(ja): check to see if we need to re-enable/disable the charm!
      } else {
        this.state.set(cellLink, {
          bgCharmEntry: c,
          disabled: !c.get().enabled,
          lastExecuted: null,
          lastFinished: null,
          consecutiveFailures: 0,
          lastError: null,
          lastErrorTimestamp: null,
        });
      }
    });
  }

  start() {
    if (this.isRunning) {
      log("Service is already running");
      return;
    }

    this.isRunning = true;

    this.runCycle();
  }

  /**
   * Stop the service
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      log("Service is not running");
      return;
    }

    this.isRunning = false;

    log("Syncing to storage");
    await storage.synced();
    log("Service stopped");
  }

  // for now we can run everything every "cycle" but also add immediate
  // execution when new charms are added
  private runCycle() {
    let skipped = 0;
    let queued = 0;

    this.state.forEach((state) => {
      if (state.disabled) {
        log("charm is disabled, skipping");
        skipped++;
        return;
      }

      this.queue.addExecuteCharmJob(state.bgCharmEntry);
      queued++;
    });

    log(`Queued ${queued} charms, skipped ${skipped} disabled charms`);
  }
}
