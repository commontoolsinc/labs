import { JobHandler } from "./base-handler.ts";
import { Job, JobType, MaintenanceJob } from "../types.ts";
import { StateManager } from "../state-manager.ts";
import { JobQueue } from "../job-queue.ts";
import { log } from "../utils.ts";

/**
 * Handler for maintenance jobs
 */
export class MaintenanceHandler implements JobHandler {
  private kv: Deno.Kv;
  private stateManager: StateManager;

  constructor(kv: Deno.Kv) {
    this.kv = kv;
    this.stateManager = new StateManager(kv);
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
      default:
        throw new Error(`Unknown maintenance task: ${task}`);
    }
  }

  /**
   * Run cleanup task
   */
  private async runCleanup(): Promise<unknown> {
    // Clean up old jobs
    const jobQueue = new JobQueue(this.kv);
    const cleaned = await jobQueue.cleanup();

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

    // Organize by integration
    const integrationStats = new Map<string, {
      charms: number;
      disabled: number;
      executions: number;
      successes: number;
      failures: number;
    }>();

    for (const state of allCharmStates) {
      if (!integrationStats.has(state.integrationId)) {
        integrationStats.set(state.integrationId, {
          charms: 0,
          disabled: 0,
          executions: 0,
          successes: 0,
          failures: 0,
        });
      }

      const stats = integrationStats.get(state.integrationId)!;
      stats.charms++;
      if (state.disabled) stats.disabled++;
      stats.executions += state.totalExecutions;
      stats.successes += state.totalSuccesses;
      stats.failures += state.totalFailures;
    }

    // Log stats
    log("=== Service Statistics ===");
    log(`Total charms: ${totalCharms} (${disabledCharms} disabled)`);
    log(
      `Total executions: ${totalExecutions} (${totalSuccesses} successes, ${totalFailures} failures)`,
    );

    for (const [id, stats] of integrationStats.entries()) {
      const successRate = stats.executions > 0
        ? (stats.successes / stats.executions * 100).toFixed(2)
        : "100.00";

      log(
        `Integration ${id}: ${stats.charms} charms, ${successRate}% success rate`,
      );
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
      integrationStats: Object.fromEntries(integrationStats),
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
        charm.integrationId,
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
