/// <reference lib="deno.unstable" />
import { JobHandler } from "./base-handler.ts";
import { ExecuteCharmJob, Job, JobType } from "../kv-types.ts";
import { KVStateManager } from "../kv-state-manager.ts";
import { log } from "../utils.ts";
import * as Session from "../session.ts";
import { Cell, isStream } from "@commontools/runner";
import { Charm, CharmManager } from "@commontools/charm";
import type { DID } from "@commontools/identity";
import { getIntegration } from "../integrations/index.ts";

/**
 * Handler for execute charm jobs
 */
export class ExecuteCharmHandler implements JobHandler {
  private kv: Deno.Kv;
  private stateManager: KVStateManager;
  private managerCache = new Map<string, CharmManager>();

  constructor(kv: Deno.Kv) {
    this.kv = kv;
    this.stateManager = new KVStateManager(kv);
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
        throw new Error(`Charm not found: ${charmId}`);
      }

      // Get running charm and argument
      log(`Loading running charm and argument: ${charmId}`);
      const runningCharm = await manager.get(charm, true);
      const argument = manager.getArgument(charm);

      if (!runningCharm || !argument) {
        throw new Error(`Charm not properly loaded: ${charmId}`);
      }

      // Get the integration to validate the charm
      const integration = getIntegration(integrationId);
      if (!integration) {
        throw new Error(`Integration not found: ${integrationId}`);
      }

      // Get integration config with validation function
      const integrationConfig = integration.getIntegrationConfig();
      if (
        integrationConfig.isValidIntegrationCharm &&
        !integrationConfig.isValidIntegrationCharm(runningCharm)
      ) {
        throw new Error(
          `Charm does not match integration type ${integrationId}`,
        );
      }

      // Execute charm with proper error detection and timeout
      log(`Executing charm: ${charmId}`);

      try {
        // Execute the charm - passing integration ID for Gmail-specific handling
        await this.executeCharmWithWorker(
          runningCharm,
          argument,
          spaceId as DID,
          integrationId,
          charmId,
        );

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
      if (state.consecutiveFailures >= 5) { // TODO: Make configurable
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
   * Execute a charm using a dedicated worker process
   */
  private async executeCharmWithWorker(
    charm: Cell<Charm>,
    argument: Cell<any>,
    space: DID,
    integrationId?: string,
    charmId?: string,
  ): Promise<void> {
    // Special case for Gmail integration: handle token refresh
    // We still need to do this in the main process before spawning the worker
    if (integrationId === "gmail") {
      // Check auth
      const auth = argument.key("auth");
      if (!auth) {
        throw new Error("Missing auth in Gmail charm argument");
      }

      const { token, expiresAt } = auth.get();

      // Refresh token if needed for Gmail integration
      if (token && expiresAt && Date.now() > expiresAt) {
        log(`Token expired, refreshing for Gmail charm: ${charmId}`);
        try {
          await this.refreshGmailAuthToken(auth, charm, space);
        } catch (error) {
          const errorMsg = error instanceof Error
            ? error.message
            : String(error);
          throw new Error(`Failed to refresh Gmail token: ${errorMsg}`);
        }
      } else if (!token) {
        throw new Error("Missing Gmail authentication token");
      }
    }

    // Find updater stream to verify it exists before creating a worker
    const updaterStream = this.findUpdaterStream(charm);
    if (!updaterStream) {
      throw new Error("No updater stream found in charm");
    }

    // Get the worker script path
    const workerUrl = new URL("../utils/charm-worker.ts", import.meta.url).href;

    // Create a worker timeout promise
    const timeout = new Promise<void>((_, reject) => {
      setTimeout(
        () => reject(new Error(`Charm execution timed out: ${charmId}`)),
        30000,
      );
    });

    // Get operator password for the worker
    const operatorPass = Deno.env.get("OPERATOR_PASS") ?? "implicit trust";

    // Extract the updater key (stream name) from the charm
    const updaterKey = this.findUpdaterStreamName(charm);
    if (!updaterKey) {
      throw new Error("Could not determine updater stream name");
    }

    // Create a worker execution promise
    const workerPromise = new Promise<void>((resolve, reject) => {
      log(`Creating worker for charm: ${charmId} with updater: ${updaterKey}`);

      try {
        // Create and start worker with appropriate permissions
        const worker = new Worker(workerUrl, {
          type: "module",
          deno: {
            permissions: {
              read: true,
              write: true,
              net: true,
              env: true,
            },
          },
        });

        // Handle messages from the worker
        worker.onmessage = (e) => {
          if (e.data.success) {
            log(`Worker successfully executed charm: ${charmId}`);
            resolve();
          } else {
            reject(new Error(e.data.error || "Unknown worker error"));
          }
          worker.terminate();
        };

        // Handle worker errors
        worker.onerror = (e) => {
          log(`Worker error for charm ${charmId}: ${e.message}`);
          reject(new Error(`Worker error: ${e.message}`));
          worker.terminate();
        };

        // Get toolshed URL for the worker
        const toolshedUrl = Deno.env.get("TOOLSHED_API_URL") ??
          "https://toolshed.saga-castor.ts.net/";

        // Send data to worker, including the necessary URLs and configuration
        worker.postMessage({
          spaceId: space,
          charmId: charmId,
          updaterKey: updaterKey,
          operatorPass: operatorPass,
          toolshedUrl: toolshedUrl,
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        log(`Error creating worker: ${errorMsg}`);
        reject(new Error(`Failed to create worker: ${errorMsg}`));
      }
    });

    // Race the worker execution against the timeout
    return Promise.race([workerPromise, timeout]);
  }

  /**
   * Find the updater stream in a charm
   */
  private findUpdaterStream(charm: Cell<Charm>): Cell<any> | null {
    // Check for known updater streams
    const streamNames = [
      // FIXME(jake): We need to document this `integrationUpdater`
      "integrationUpdater", // Well-known handler name for integration charms
      "updater",
      "googleUpdater",
      "discordUpdater",
    ];

    for (const name of streamNames) {
      const stream = charm.key(name);
      if (isStream(stream)) {
        return stream;
      }
    }

    return null;
  }

  /**
   * Find the updater stream name in a charm
   * Returns the name of the first valid updater stream found
   */
  private findUpdaterStreamName(charm: Cell<Charm>): string | null {
    // Check for known updater streams
    const streamNames = [
      "integrationUpdater", // Well-known handler name for integration charms
      "updater",
      "googleUpdater",
      "discordUpdater",
    ];

    for (const name of streamNames) {
      const stream = charm.key(name);
      if (isStream(stream)) {
        return name;
      }
    }

    return null;
  }

  /**
   * Refresh a Gmail authentication token
   * This is a special case specifically for Gmail integration
   */
  private async refreshGmailAuthToken(
    auth: Cell<any>,
    charm: Cell<Charm>,
    space: DID,
  ): Promise<void> {
    const authCellId = JSON.parse(JSON.stringify(auth.getAsCellLink()));
    authCellId.space = space as string;

    // Get toolshed URL
    const toolshedUrl = Deno.env.get("TOOLSHED_API_URL") ??
      "https://toolshed.saga-castor.ts.net/";

    const refreshUrl = new URL(
      "/api/integrations/google-oauth/refresh",
      toolshedUrl,
    );

    const refreshResponse = await fetch(refreshUrl, {
      method: "POST",
      body: JSON.stringify({ authCellId }),
    });

    const refreshData = await refreshResponse.json();
    if (!refreshData.success) {
      throw new Error(
        `Error refreshing Gmail token: ${JSON.stringify(refreshData)}`,
      );
    }
  }

  /**
   * Get or create a charm manager for a space
   */
  private async getManagerForSpace(space: DID): Promise<CharmManager> {
    const spaceKey = space.toString();

    if (this.managerCache.has(spaceKey)) {
      return this.managerCache.get(spaceKey)!;
    }

    // Get operator password
    const operatorPass = Deno.env.get("OPERATOR_PASS") ?? "implicit trust";

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
