import { BGCharmEntry, sleep } from "@commontools/utils";

import { Job } from "./types.ts";
import { log } from "./utils.ts";
import { ExecuteCharmHandler } from "./execute-charm-handler.ts";

type JobQueueOptions = {
  maxConcurrentJobs?: number;
  maxRetries?: number;
  pollingIntervalMs?: number;
};

/**
 * Job queue system for handling background tasks
 */
export class JobQueue {
  private consumerRunning = false;
  private maxConcurrentJobs: number;
  private maxRetries: number;
  private pollingIntervalMs: number;
  private activeJobs = new Set<Job>();
  private pendingJobs: Job[] = [];
  private executeCharmHandler = new ExecuteCharmHandler();

  constructor(options: JobQueueOptions = {}) {
    this.maxConcurrentJobs = options.maxConcurrentJobs ?? 5;
    this.maxRetries = options.maxRetries ?? 3;
    this.pollingIntervalMs = options.pollingIntervalMs ?? 100;

    log(`Job queue initialized`);
    log(` - maxConcurrentJobs: ${this.maxConcurrentJobs}`);
    log(` - maxRetries: ${this.maxRetries}`);
    log(` - pollingIntervalMs: ${this.pollingIntervalMs}`);
  }

  addExecuteCharmJob(
    bg: BGCharmEntry,
    { priority, maxRetries }: { priority?: number; maxRetries?: number } = {},
  ) {
    this.pendingJobs.push({
      bgCharmEntry: bg,
      priority: priority ?? 3,
      createdAt: Date.now(),
      retryCount: 0,
      maxRetries: maxRetries ?? this.maxRetries,
      timeoutMs: 30000,
      status: "pending",
    });
  }

  startConsumer(): void {
    if (this.consumerRunning) {
      log("Job consumer is already running");
      return;
    }

    this.consumerRunning = true;
    this.runConsumerLoop();
    log("Job consumer started");
  }

  async stopConsumer(): Promise<void> {
    log("Stopping job consumer...");
    this.consumerRunning = false;

    // Wait for active jobs to finish with a timeout
    if (this.activeJobs.size > 0) {
      log(`Waiting for ${this.activeJobs.size} active jobs to complete...`);
      await Promise.race([
        sleep(10000),
        new Promise((resolve) => {
          const checkInterval = setInterval(() => {
            if (this.activeJobs.size === 0) {
              clearInterval(checkInterval);
              resolve(true);
            }
          }, 100);
        }),
      ]);
    }

    log("Job consumer stopped");
  }

  getStatus() {
    return {
      running: this.consumerRunning,
      activeJobs: this.activeJobs.size,
      pendingJobs: this.pendingJobs.length,
    };
  }

  private async runConsumerLoop(): Promise<void> {
    while (this.consumerRunning) {
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
      this.processJob(job)
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

  private processJob(
    job: Job,
  ): Promise<{ success: boolean; error?: string }> {
    const entry = job.bgCharmEntry.get();
    log(`Starting ${entry.integration} ${entry.charmId} (${entry.space})`);

    return Promise.race([
      this.executeCharmHandler.handle(job),
      sleep(job.timeoutMs).then(() => ({
        success: false,
        error: "Timeout",
      })),
    ]);
  }
}
