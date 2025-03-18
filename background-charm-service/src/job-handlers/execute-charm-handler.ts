/// <reference lib="deno.unstable" />
import { JobHandler } from "./base-handler.ts";
import { ExecuteCharmJob, Job, JobType } from "../types.ts";
import { StateManager } from "../state-manager.ts";
import { log } from "../utils.ts";
import * as Session from "../session.ts";
import { Cell, isStream } from "@commontools/runner";
import { Charm, CharmManager } from "@commontools/charm";
import type { DID } from "@commontools/identity";
import { getIntegration } from "../integrations/index.ts";
import {
  CharmNotFoundError,
  CharmTimeoutError,
  IntegrationError,
} from "../errors/index.ts";
import { getConfig } from "../config.ts";
import {
  createTimeoutController,
  findUpdaterStream,
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
  private config: ReturnType<typeof getConfig>;

  constructor(kv: Deno.Kv) {
    this.stateManager = new StateManager(kv);
    this.config = getConfig();

    // Get the shared worker pool instance
    const workerUrl = new URL("../utils/charm-worker.ts", import.meta.url).href;
    this.workerPool = getSharedWorkerPool({
      maxWorkers: this.config.maxConcurrentJobs,
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
      `Initialized worker pool with ${this.config.maxConcurrentJobs} max workers`,
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

    log(
      `Executing charm: ${spaceId}/${charmId} (integration: ${integrationId})`,
    );

    // Check if charm is disabled
    const isDisabled = await this.stateManager.isCharmDisabled(
      spaceId,
      charmId,
      integrationId,
    );
    if (isDisabled) {
      log(`Charm is disabled: ${spaceId}/${charmId}`);
      return { skipped: true, reason: "disabled" };
    }

    const startTime = Date.now();

    try {
      // Get or create manager for this space
      const manager = await this.getManagerForSpace(spaceId as DID);

      // Load the charm
      log(`Loading charm: ${charmId}`);
      const charm = await manager.get(charmId, false);
      if (!charm) {
        throw new CharmNotFoundError(
          `Charm not found: ${charmId}`,
          spaceId,
          charmId,
        );
      }

      // Get running charm and argument
      log(`Loading running charm and argument: ${charmId}`);
      const runningCharm = await manager.get(charm, true);
      const argument = manager.getArgument(charm);

      if (!runningCharm || !argument) {
        throw new CharmNotFoundError(
          `Charm not properly loaded: ${charmId}`,
          spaceId,
          charmId,
        );
      }

      // Get the integration to validate the charm
      const integration = getIntegration(integrationId);
      if (!integration) {
        throw new IntegrationError(
          `Integration not found: ${integrationId}`,
          integrationId,
        );
      }
      // Execute charm with proper error detection and timeout
      log(`Executing charm: ${charmId}`);

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
      } catch (charmError) {
        // The charm execution function will throw detailed errors
        throw charmError;
      }
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
      this.config.charmExecutionTimeoutMs,
    );

    try {
      // Get operator password and toolshed URL for the worker
      const operatorPass = this.config.operatorPass;
      const toolshedUrl = this.config.toolshedUrl;

      // Submit task to worker pool
      log(
        `Submitting charm ${charmId} to worker pool`,
      );

      // The AbortController will automatically abort if the timeout is reached
      const result = await Promise.race([
        this.workerPool.execute({
          spaceId: space,
          charmId,
          operatorPass,
          toolshedUrl,
        }),

        // Convert AbortSignal to a promise that rejects when aborted
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () => {
            reject(
              new CharmTimeoutError(
                `Charm execution timed out after ${this.config.charmExecutionTimeoutMs}ms`,
                space as string,
                charmId || "",
                this.config.charmExecutionTimeoutMs,
              ),
            );
          });
        }),
      ]);

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

    // Get operator password from config
    const operatorPass = this.config.operatorPass;

    // Create new session and manager
    const session = await Session.open({
      passphrase: operatorPass,
      name: "~background-service",
      space,
    });

    const manager = new CharmManager(session);
    this.managerCache.set(spaceKey, manager);

    return manager;
  }
}
