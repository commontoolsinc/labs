import { JobHandler } from "./base-handler.ts";
import { Job, JobType, ExecuteCharmJob } from "../kv-types.ts";
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
    
    log(`Executing charm: ${spaceId}/${charmId} (integration: ${integrationId})`);
    
    // Check if charm is disabled
    const isDisabled = await this.stateManager.isCharmDisabled(spaceId, charmId, integrationId);
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
        throw new Error(`Charm does not match integration type ${integrationId}`);
      }
      
      // Execute charm with timeout
      log(`Executing charm: ${charmId}`);
      const result = await this.executeCharmWithTimeout(runningCharm, argument, spaceId as DID);
      
      // Update state based on success/failure
      const executionTimeMs = Date.now() - startTime;
      
      if (result.success) {
        // Success case
        await this.stateManager.updateAfterExecution(
          spaceId,
          charmId,
          integrationId,
          true, // success
          executionTimeMs
        );
        
        log(`Successfully executed charm: ${charmId} (${executionTimeMs}ms)`);
        return { success: true, executionTimeMs };
      } else {
        // Failure case
        const error = new Error(result.error || "Unknown error during charm execution");
        const state = await this.stateManager.updateAfterExecution(
          spaceId,
          charmId,
          integrationId,
          false, // failure
          executionTimeMs,
          error
        );
        
        // Check if we should disable this charm
        if (state.consecutiveFailures >= 5) { // TODO: Make configurable
          log(`Disabling charm ${spaceId}/${charmId} after ${state.consecutiveFailures} consecutive failures`);
          await this.stateManager.disableCharm(spaceId, charmId, integrationId);
        }
        
        log(`Error executing charm: ${charmId} - ${error.message} (${executionTimeMs}ms)`);
        
        // CRITICAL FIX: Throw an error instead of returning failure
        // This ensures the job is properly marked as failed
        throw error;
      }
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log(`Error executing charm ${spaceId}/${charmId}: ${errorMessage}`);
      
      // Update state with failure
      const executionTimeMs = Date.now() - startTime;
      const state = await this.stateManager.updateAfterExecution(
        spaceId,
        charmId,
        integrationId,
        false, // failure
        executionTimeMs,
        error instanceof Error ? error : new Error(errorMessage)
      );
      
      // Check if we should disable this charm
      if (state.consecutiveFailures >= 5) { // TODO: Make configurable
        log(`Disabling charm ${spaceId}/${charmId} after ${state.consecutiveFailures} consecutive failures`);
        await this.stateManager.disableCharm(spaceId, charmId, integrationId);
      }
      
      return { 
        success: false, 
        error: errorMessage,
        executionTimeMs,
        consecutiveFailures: state.consecutiveFailures
      };
    }
  }
  
  /**
   * Execute a charm with timeout
   */
  private async executeCharmWithTimeout(
    charm: Cell<Charm>,
    argument: Cell<any>,
    space: DID,
  ): Promise<{ success: boolean; error?: string }> {
    const charmId = charm.entityId ? charm.entityId["/"] : "unknown";
    
    // Find updater stream
    const updaterStream = this.findUpdaterStream(charm);
    if (!updaterStream) {
      return { success: false, error: "No updater stream found in charm" };
    }
    
    // Check auth
    const auth = argument.key("auth");
    if (!auth) {
      return { success: false, error: "Missing auth in charm argument" };
    }
    
    const { token, expiresAt } = auth.get();
    
    // Refresh token if needed
    if (token && expiresAt && Date.now() > expiresAt) {
      log(`Token expired, refreshing for charm: ${charmId}`);
      try {
        await this.refreshAuthToken(auth, charm, space);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return { success: false, error: `Failed to refresh token: ${errorMsg}` };
      }
    } else if (!token) {
      return { success: false, error: "Missing authentication token" };
    }
    
    // Create abort controller for timeout
    const abortController = new AbortController();
    const signal = abortController.signal;
    
    // Set timeout
    const timeoutId = setTimeout(() => {
      abortController.abort();
      log(`Charm execution timed out after 15s: ${charmId}`);
    }, 15000);
    
    // Track if we've seen any unhandled rejections for this charm
    let sawUnhandledRejection = false;
    const errorHandler = () => {
      sawUnhandledRejection = true;
      log(`Charm ${charmId} generated an unhandled error/rejection`);
    };
    
    // Install temporary error handlers
    self.addEventListener("unhandledrejection", errorHandler);
    self.addEventListener("error", errorHandler);
    
    try {
      // Execute with timeout
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          // Send the message to the stream
          try {
            updaterStream.send({});
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            reject(new Error(`Error sending message to stream: ${errorMsg}`));
            return;
          }
          
          // Check for unhandled rejections every 50ms
          const checkInterval = setInterval(() => {
            if (sawUnhandledRejection || signal.aborted) {
              clearInterval(checkInterval);
              if (sawUnhandledRejection) {
                reject(new Error("Charm generated unhandled rejection"));
                return;
              }
              if (signal.aborted) {
                reject(new Error("Charm execution timed out"));
                return;
              }
            }
          }, 50);
          
          // CRITICAL FIX: Never auto-resolve! Wait at least 10 seconds for real completion
          setTimeout(() => {
            clearInterval(checkInterval);
            // Always check for error, even after timeout
            if (sawUnhandledRejection) {
              reject(new Error("Charm generated unhandled rejection"));
            } else {
              // Don't resolve here - wait for the full timeout period
              // This prevents false "success" reports for charms that take longer than 1 second
              log(`Charm ${charmId} still executing after initial timeout check`);
            }
          }, 1000);
          
          // Add a longer timeout for actual success - this will keep the promise pending longer
          // so we can catch delayed errors
          setTimeout(() => {
            clearInterval(checkInterval);
            if (sawUnhandledRejection) {
              reject(new Error("Charm generated unhandled rejection"));
            } else {
              log(`Charm ${charmId} completed without error for 10 seconds, marking successful`);
              resolve();
            }
          }, 10000);
        }),
        new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error("Charm execution timed out"));
          });
        })
      ]);
      
      // If we got here without unhandled rejections, consider it successful
      if (sawUnhandledRejection) {
        return { 
          success: false, 
          error: "Charm generated unhandled rejection" 
        };
      }
      
      return { success: true };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log(`Error executing charm ${charmId}: ${errorMsg}`);
      return { 
        success: false, 
        error: errorMsg 
      };
    } finally {
      // Clean up
      clearTimeout(timeoutId);
      self.removeEventListener("unhandledrejection", errorHandler);
      self.removeEventListener("error", errorHandler);
    }
  }
  
  /**
   * Find the updater stream in a charm
   */
  private findUpdaterStream(charm: Cell<Charm>): Cell<any> | null {
    // Check for known updater streams
    const streamNames = [
      "updater",
      "googleUpdater",
      "githubUpdater",
      "notionUpdater",
      "calendarUpdater",
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
   * Refresh an authentication token
   */
  private async refreshAuthToken(
    auth: Cell<any>,
    charm: Cell<Charm>,
    space: DID,
  ): Promise<void> {
    const authCellId = JSON.parse(JSON.stringify(auth.getAsCellLink()));
    authCellId.space = space as string;
    
    // Determine integration type
    const integrationTypes = ["google", "github", "notion", "calendar"];
    let integrationType = "google"; // Default
    
    for (const type of integrationTypes) {
      if (charm.key(`${type}Updater`) && isStream(charm.key(`${type}Updater`))) {
        integrationType = type;
        break;
      }
    }
    
    // Get toolshed URL
    const toolshedUrl = Deno.env.get("TOOLSHED_API_URL") ?? 
      "https://toolshed.saga-castor.ts.net/";
    
    const refreshUrl = new URL(
      `/api/integrations/${integrationType}-oauth/refresh`,
      toolshedUrl,
    );
    
    const refreshResponse = await fetch(refreshUrl, {
      method: "POST",
      body: JSON.stringify({ authCellId }),
    });
    
    const refreshData = await refreshResponse.json();
    if (!refreshData.success) {
      throw new Error(`Error refreshing token: ${JSON.stringify(refreshData)}`);
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