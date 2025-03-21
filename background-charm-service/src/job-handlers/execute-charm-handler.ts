/// <reference lib="deno.unstable" />

import { ExecuteCharmJob, Job } from "../types.ts";
import { log } from "../utils.ts";
import { CharmManager } from "@commontools/charm";
import { type DID, Session } from "@commontools/identity";
import { CharmTimeoutError } from "../errors/index.ts";
import { env } from "../env.ts";
import {
  createTimeoutController,
  getSharedWorkerPool,
} from "../utils/common.ts";
import { WorkerPool } from "../utils/worker-pool.ts";

export class ExecuteCharmHandler {
  private managerCache = new Map<string, CharmManager>();
  private workerPool: WorkerPool<any, any>;

  constructor() {
    // Get the shared worker pool instance
    const workerUrl = new URL("../utils/charm-worker.ts", import.meta.url).href;
    this.workerPool = getSharedWorkerPool({
      maxWorkers: env.MAX_CONCURRENT_JOBS,
      workerUrl,
      workerOptions: {
        type: "module",
        deno: {
          permissions: {
            read: true,
            write: true,
            net: true,
            env: true,
          },
        },
      },
    });
  }

  /**
   * Handle an execute charm job
   */
  async handle(job: Job): Promise<unknown> {
    const entry = job.bgCharmEntry.get();

    log(`Executing ${entry.integration} ${entry.charmId} (${entry.space})`);

    const startTime = Date.now();

    try {
      // Execute the charm - passing integration ID for Gmail-specific handling
      await this.executeCharmWithWorker({
        space: entry.space as DID,
        charmId: entry.charmId,
      });

      // If we get here, the charm succeeded (timeout function will throw on failure)
      const executionTimeMs = Date.now() - startTime;

      log(`Successfully executed: ${entry.charmId} (${executionTimeMs}ms)`);
      return { success: true, executionTimeMs };
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      log(
        `Error executing charm ${entry.space}/${entry.charmId}: ${errorMessage}`,
        { error: true },
      );
      const executionTimeMs = Date.now() - startTime;

      // // Check if we should disable this charm
      // if (state.consecutiveFailures >= 5) { // TODO(@jakedahn): Make configurable
      //   log(
      //     `Disabling charm ${spaceId}/${charmId} after ${state.consecutiveFailures} consecutive failures`,
      //   );
      //   await this.stateManager.disableCharm(spaceId, charmId);
      // }

      return {
        success: false,
        error: errorMessage,
        executionTimeMs,
        // consecutiveFailures: state.consecutiveFailures,
      };
    }
  }

  /**
   * Execute a charm using the worker pool
   */
  private async executeCharmWithWorker({
    space,
    charmId,
  }: {
    space: DID;
    charmId: string;
  }): Promise<void> {
    // Create a timeout controller for the worker execution
    const { controller, clear: clearTimeout } = createTimeoutController(
      env.CHARM_EXECUTION_TIMEOUT_MS,
    );

    try {
      log(`Submitting charm ${charmId} to worker pool`);

      // this spawns the actual worker process
      const task = this.workerPool.execute({
        spaceId: space,
        charmId,
        operatorPass: env.OPERATOR_PASS,
        toolshedUrl: env.TOOLSHED_API_URL,
      });

      // Convert AbortSignal to a promise that rejects when aborted
      const abort = new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => {
          reject(
            new CharmTimeoutError(
              `Charm execution timed out after ${env.CHARM_EXECUTION_TIMEOUT_MS}ms`,
              space as string,
              charmId || "",
              env.CHARM_EXECUTION_TIMEOUT_MS,
            ),
          );
        });
      });

      const result = await Promise.race([task, abort]);

      // Check if the result indicates an error
      if (result && typeof result === "object" && "error" in result) {
        throw new Error(result.error as string);
      }

      log(`Worker pool successfully executed charm: ${charmId}`);
    } finally {
      // Always clear the timeout to prevent memory leaks
      clearTimeout();
    }
  }
}
