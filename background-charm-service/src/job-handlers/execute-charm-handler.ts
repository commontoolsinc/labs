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
      
      // Execute charm with proper error detection and timeout
      log(`Executing charm: ${charmId}`);
      
      try {
        // Execute the charm with proper tracking and error detection
        await this.executeCharmWithTimeout(runningCharm, argument, spaceId as DID);
        
        // If we get here, the charm truly succeeded (timeout function will throw on failure)
        const executionTimeMs = Date.now() - startTime;
        await this.stateManager.updateAfterExecution(
          spaceId,
          charmId,
          integrationId,
          true, // success
          executionTimeMs
        );
        
        log(`Successfully executed charm: ${charmId} (${executionTimeMs}ms)`);
        return { success: true, executionTimeMs };
      } catch (charmError) {
        // The charm execution function will throw detailed errors
        throw charmError;
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
  ): Promise<void> {
    const charmId = charm.entityId ? charm.entityId["/"] : "unknown";
    
    // Find updater stream
    const updaterStream = this.findUpdaterStream(charm);
    if (!updaterStream) {
      throw new Error("No updater stream found in charm");
    }
    
    // Check auth
    const auth = argument.key("auth");
    if (!auth) {
      throw new Error("Missing auth in charm argument");
    }
    
    const { token, expiresAt } = auth.get();
    
    // Refresh token if needed
    if (token && expiresAt && Date.now() > expiresAt) {
      log(`Token expired, refreshing for charm: ${charmId}`);
      try {
        await this.refreshAuthToken(auth, charm, space);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to refresh token: ${errorMsg}`);
      }
    } else if (!token) {
      throw new Error("Missing authentication token");
    }
    
    // Create abort controller for timeout
    const abortController = new AbortController();
    const signal = abortController.signal;
    
    // Set timeout (longer timeout to allow API requests to complete)
    const timeoutId = setTimeout(() => {
      abortController.abort();
      log(`Charm execution timed out after 15s: ${charmId}`);
    }, 15000);
    
    // Detect completion using Promise.race with a timeout
    return new Promise<void>((resolve, reject) => {
      let errorDetected = false;
      
      // Error listener specifically for this execution
      const errorHandler = (event: PromiseRejectionEvent) => {
        // Only handle errors coming from this charm execution
        const errorText = String(event.reason);
        if (errorText.includes(charmId)) {
          errorDetected = true;
          const errorMessage = event.reason instanceof Error 
            ? event.reason.message 
            : String(event.reason);
          reject(new Error(`Charm execution error: ${errorMessage}`));
        }
      };
      
      // Add temporary error listener
      self.addEventListener("unhandledrejection", errorHandler);
      
      try {
        // Send the message to the stream
        updaterStream.send({});
        
        // Set up a completion check - wait for a reasonable time for the charm to execute
        // This is a more reliable approach than the 2 second fixed timeout
        const intervalId = setInterval(() => {
          if (signal.aborted) {
            clearInterval(intervalId);
            self.removeEventListener("unhandledrejection", errorHandler);
            reject(new Error(`Charm execution timed out: ${charmId}`));
          }
        }, 100);
        
        // Allow a reasonable amount of time for execution to complete
        // This is the maximum time we'll wait for a successful execution
        setTimeout(() => {
          clearInterval(intervalId);
          self.removeEventListener("unhandledrejection", errorHandler);
          
          if (errorDetected) {
            reject(new Error(`Charm ${charmId} generated unhandled rejection`));
          } else {
            log(`Charm ${charmId} executed successfully`);
            resolve();
          }
        }, 10000); // 10 second window to detect successful execution
      } catch (error) {
        self.removeEventListener("unhandledrejection", errorHandler);
        reject(error);
      }
    }).finally(() => {
      // Clean up
      clearTimeout(timeoutId);
    });
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