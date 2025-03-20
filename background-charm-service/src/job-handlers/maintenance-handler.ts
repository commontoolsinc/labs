import { JobHandler } from "./base-handler.ts";
import { Job, JobType, MaintenanceJob } from "../types.ts";
import { StateManager } from "../state-manager.ts";
import { JobQueue } from "../job-queue.ts";
import { log } from "../utils.ts";
import { WorkerPool } from "../utils/worker-pool.ts";

/**
 * Handler for maintenance jobs
 */
export class MaintenanceHandler implements JobHandler {
  private kv: Deno.Kv;
  private stateManager: StateManager;
  private jobQueue: JobQueue | null = null;
  private workerPool: WorkerPool<any, any> | null = null;

  constructor(kv: Deno.Kv) {
    this.kv = kv;
    this.stateManager = new StateManager(kv);
  }

  /**
   * Set the job queue reference to avoid recreating it
   */
  setJobQueue(queue: JobQueue): void {
    this.jobQueue = queue;
  }

  /**
   * Set the worker pool reference to avoid recreating it
   */
  setWorkerPool(pool: WorkerPool<any, any>): void {
    this.workerPool = pool;
  }

  /**
   * Handle a maintenance job
   */
  async handle(job: Job): Promise<unknown> {
    if (job.type !== JobType.MAINTENANCE) {
      throw new Error(`Invalid job type: ${job.type}`);
    }

    const maintenanceJob = job as MaintenanceJob;
    const { task } = maintenanceJob;

    log(`Running maintenance task: ${task}`);

    switch (task) {
      case "cleanup":
        return await this.runCleanup();
      case "stats":
        return await this.updateStats();
      case "reset":
        return await this.resetDisabledCharms();
      case "all":
        // Run all maintenance tasks sequentially
        log("Running all maintenance tasks");
        await this.updateStats();
        await this.runCleanup();
        return await this.resetDisabledCharms();
      default:
        throw new Error(`Unknown maintenance task: ${task}`);
    }
  }

  /**
   * Run cleanup task
   */
  private async runCleanup(): Promise<unknown> {
    // Use the existing job queue if available, or create a new one
    if (!this.jobQueue) {
      log("Warning: No job queue reference provided to maintenance handler");
    }
    
    const cleaned = this.jobQueue 
      ? await this.jobQueue.cleanup()
      : 0;

    return {
      cleanedJobs: cleaned,
      taskType: "cleanup",
    };
  }

  /**
   * Update service statistics
   */
  private async updateStats(): Promise<unknown> {
    // Get all charm states
    const allCharmStates = await this.stateManager.getAllCharmStates();

    // Count metrics
    const totalCharms = allCharmStates.length;
    const disabledCharms = allCharmStates.filter((s) => s.disabled).length;
    const totalExecutions = allCharmStates.reduce(
      (sum, s) => sum + s.totalExecutions,
      0,
    );
    const totalSuccesses = allCharmStates.reduce(
      (sum, s) => sum + s.totalSuccesses,
      0,
    );
    const totalFailures = allCharmStates.reduce(
      (sum, s) => sum + s.totalFailures,
      0,
    );

    // Log stats
    log("=== Service Statistics ===");
    log(`Total charms: ${totalCharms} (${disabledCharms} disabled)`);
    log(
      `Total executions: ${totalExecutions} (${totalSuccesses} successes, ${totalFailures} failures)`,
    );

    // Use existing worker pool if available
    if (this.workerPool) {
      this.workerPool.reportWorkerStats();
    } else {
      log("Warning: No worker pool reference provided to maintenance handler");
    }

    // Return stats for result
    return {
      taskType: "stats",
      totalCharms,
      disabledCharms,
      totalExecutions,
      totalSuccesses,
      totalFailures,
      successRate: totalExecutions > 0
        ? (totalSuccesses / totalExecutions * 100).toFixed(2)
        : "100.00",
    };
  }

  /**
   * Reset disabled charms
   */
  private async resetDisabledCharms(): Promise<unknown> {
    // Get all disabled charms
    const allCharmStates = await this.stateManager.getAllCharmStates();
    const disabledCharms = allCharmStates.filter((s) => s.disabled);

    // Find charms that haven't been run in over 24 hours
    const oneDayAgo = Date.now() - 86400000;
    const charmsToReset = disabledCharms.filter((c) =>
      c.lastExecuted === null || c.lastExecuted < oneDayAgo
    );

    // Reset these charms
    for (const charm of charmsToReset) {
      await this.stateManager.updateCharmState(
        charm.spaceId,
        charm.charmId,
        {
          disabled: false,
          consecutiveFailures: 0,
          lastError: null,
        },
      );

      log(`Reset disabled charm: ${charm.spaceId}/${charm.charmId}`);
    }

    return {
      taskType: "reset",
      disabledCharms: disabledCharms.length,
      charmsReset: charmsToReset.length,
    };
  }
}
