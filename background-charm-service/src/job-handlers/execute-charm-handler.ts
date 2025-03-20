/// <reference lib="deno.unstable" />
import { JobHandler } from "./base-handler.ts";
import { ExecuteCharmJob, Job, JobType } from "../types.ts";
import { StateManager } from "../state-manager.ts";
import { log } from "../utils.ts";
import * as Session from "../session.ts";
import { CharmManager } from "@commontools/charm";
import type { DID } from "@commontools/identity";
import { CharmTimeoutError } from "../errors/index.ts";
import { env } from "../config.ts";
import {
  createTimeoutController,
  getSharedWorkerPool,
} from "../utils/common.ts";
import { WorkerPool } from "../utils/worker-pool.ts";

/**
 * Handler for execute charm jobs
 */
export class ExecuteCharmHandler implements JobHandler {
  private stateManager: StateManager;
  private managerCache = new Map<string, CharmManager>();
  private workerPool: WorkerPool<any, any>;

  constructor(kv: Deno.Kv) {
    this.stateManager = new StateManager(kv);

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

    log(
      `Initialized worker pool with ${env.MAX_CONCURRENT_JOBS} max workers`,
    );
  }

  /**
   * Handle an execute charm job
   */
  async handle(job: Job): Promise<unknown> {
    if (job.type !== JobType.EXECUTE_CHARM) {
      throw new Error(`Invalid job type: ${job.type}`);
    }

    const executeJob = job as ExecuteCharmJob;
    const { integrationId, spaceId, charmId } = executeJob;

    log(`Executing charm: ${spaceId}/${charmId} (${integrationId})`);

    // Check if charm is disabled
    const isDisabled = await this.stateManager.isCharmDisabled(
      spaceId,
      charmId,
      integrationId,
    );
    if (isDisabled) {
      log(`Charm is disabled: ${spaceId}/${charmId} but running anyway`);
      return { skipped: true, reason: "disabled" };
    }

    const startTime = Date.now();

    try {
      // Execute the charm - passing integration ID for Gmail-specific handling
      await this.executeCharmWithWorker({
        space: spaceId as DID,
        charmId,
      });

      // If we get here, the charm succeeded (timeout function will throw on failure)
      const executionTimeMs = Date.now() - startTime;
      await this.stateManager.updateAfterExecution(
        spaceId,
        charmId,
        integrationId,
        true, // success
        executionTimeMs,
      );

      log(`Successfully executed charm: ${charmId} (${executionTimeMs}ms)`);
      return { success: true, executionTimeMs };
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      log(`Error executing charm ${spaceId}/${charmId}: ${errorMessage}`);

      // Update state with failure
      const executionTimeMs = Date.now() - startTime;
      const state = await this.stateManager.updateAfterExecution(
        spaceId,
        charmId,
        integrationId,
        false, // failure
        executionTimeMs,
        error instanceof Error ? error : new Error(errorMessage),
      );

      // Check if we should disable this charm
      if (state.consecutiveFailures >= 5) { // TODO(@jakedahn): Make configurable
        log(
          `Disabling charm ${spaceId}/${charmId} after ${state.consecutiveFailures} consecutive failures`,
        );
        await this.stateManager.disableCharm(spaceId, charmId, integrationId);
      }

      return {
        success: false,
        error: errorMessage,
        executionTimeMs,
        consecutiveFailures: state.consecutiveFailures,
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

  /**
   * Shutdown the handler and its resources
   */
  // deno-lint-ignore require-await
  async shutdown(): Promise<void> {
    // We're not shutting down the worker pool here since it's shared
    // The service will handle shutting down the shared pool
    log("ExecuteCharmHandler shutdown complete");
  }

  /**
   * Get or create a charm manager for a space
   */
  private async getManagerForSpace(space: DID): Promise<CharmManager> {
    const spaceKey = space.toString();

    if (this.managerCache.has(spaceKey)) {
      return this.managerCache.get(spaceKey)!;
    }

    // Create new session and manager
    const session = await Session.open({
      passphrase: env.OPERATOR_PASS,
      name: "~background-service",
      space,
    });

    const manager = new CharmManager(session);
    this.managerCache.set(spaceKey, manager);

    return manager;
  }
}
