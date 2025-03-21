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
        new Promise((resolve) => setTimeout(resolve, 10000)), // 10 sec timeout
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
      try {
        // Check if we can process more jobs
        if (this.activeJobs.size >= this.maxConcurrentJobs) {
          await sleep(this.pollingIntervalMs);
          continue;
        }

        // Get next job from queue
        const job = this.pendingJobs.shift();

        if (!job) {
          await sleep(this.pollingIntervalMs);
          continue;
        }

        this.activeJobs.add(job);
        this.processJob(job).finally(() => {
          this.activeJobs.delete(job);
        });
      } catch (error) {
        // FIXME(ja): should we remove the job from the queue/activeJobs?
        log(error instanceof Error ? error.message : String(error), {
          error: true,
        });
        await sleep(1000);
      }
    }
  }

  private async processJob(job: Job): Promise<void> {
    const startTime = Date.now();
    let success = false;
    let error: string | undefined;
    let resultData: unknown;

    const entry = job.bgCharmEntry.get();

    log(`Starting ${entry.integration} ${entry.charmId} (${entry.space})`);

    try {
      resultData = await Promise.race([
        this.executeCharmHandler.handle(job),
        new Promise((_resolve, reject) => {
          setTimeout(() => reject("Job timed out"), job.timeoutMs);
        }),
      ]);

      // FIXME(ja): HERE

      if (
        resultData && typeof resultData === "object" &&
        "success" in resultData
      ) {
        // If the handler explicitly returns success: false, respect that
        success = resultData.success === true;
        if (!success && "error" in resultData) {
          error = resultData.error as string;
          throw new Error(error || "Unknown error in charm execution");
        }
      } else {
        success = true;
      }

      const duration = Date.now() - startTime;
      if (success) {
        log(
          `Job ${job.bgCharmEntry.charmId} completed successfully (${duration}ms)`,
        );
      } else {
        error = error || "Unknown error in charm execution";
        log(`Job ${job.bgCharmEntry.charmId} failed (${duration}ms): ${error}`);
        throw new Error(error);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      log(`Job ${job.bgCharmEntry.charmId} failed: ${error}`);
      throw e; // Re-throw for outer catch
    }
  }
}
