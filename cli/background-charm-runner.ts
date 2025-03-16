// Background Charm Runner
// A robust, extensible system for running charms in the background
import { parse } from "https://deno.land/std/flags/mod.ts";
import { CharmManager } from "@commontools/charm";
import {
  Cell,
  getEntityId,
  isStream,
  setBobbyServerUrl,
  storage,
} from "@commontools/runner";
import { Charm } from "@commontools/charm";
import type { DID } from "@commontools/identity";
import * as Session from "./session.ts";
import {
  CharmEntry,
  getGmailIntegrationCharms,
  initializeGmailIntegrationCharmsCell,
} from "@commontools/utils";

// ========================= Types and Interfaces =========================

export interface CharmRunnerConfig {
  intervalSeconds: number;
  logIntervalSeconds: number;
  integrations: Integration[];
  failurePolicy: FailurePolicy;
}

export interface CharmRunnerStats {
  totalRuns: number;
  totalSuccesses: number;
  totalFailures: number;
  startTime: number;
  charmsProcessed: Set<string>;
}

export interface CharmState {
  id: string;
  integrationId: string;
  enabled: boolean;
  lastRunTimestamp: number | null;
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  consecutiveFailures: number;
  lastError?: string;
  lastErrorTimestamp?: number;
  executionStats: {
    totalTimeMs: number;
    avgTimeMs: number;
    minTimeMs: number | null;
    maxTimeMs: number | null;
    lastRunTimeMs: number | null;
  };
}

export interface CharmExecutionResult {
  success: boolean;
  executionTimeMs: number;
  error?: Error;
  metadata?: Record<string, unknown>;
}

export interface FailurePolicy {
  shouldDisable(state: CharmState): boolean;
  getDescription(): string;
}

export interface Integration {
  id: string;
  name: string;
  description: string;
  fetchCharms(): Promise<Array<{ space: DID; charmId: string }>>;
  executeCharm(
    charm: Cell<Charm>,
    argument: Cell<any>,
    space: DID,
    manager: CharmManager
  ): Promise<CharmExecutionResult>;
}

// ========================= State Manager =========================

export class StateManager {
  private charmStates = new Map<string, CharmState>();
  private stats: CharmRunnerStats = {
    totalRuns: 0,
    totalSuccesses: 0,
    totalFailures: 0,
    startTime: Date.now(),
    charmsProcessed: new Set<string>(),
  };

  constructor(private logIntervalSeconds: number = 300) {
    // Set up periodic state logging
    setInterval(() => {
      this.logStates();
    }, logIntervalSeconds * 1000);
  }

  /**
   * Creates a unique identifier for a charm
   */
  private createCharmKey(space: DID, charmId: string): string {
    return `${space}/${charmId}`;
  }

  /**
   * Gets the state for a charm, creating it if it doesn't exist
   */
  getCharmState(
    space: DID,
    charmId: string,
    integrationId: string
  ): CharmState {
    const key = this.createCharmKey(space, charmId);
    let state = this.charmStates.get(key);

    if (!state) {
      state = {
        id: key,
        integrationId,
        enabled: true,
        lastRunTimestamp: null,
        totalRuns: 0,
        successfulRuns: 0,
        failedRuns: 0,
        consecutiveFailures: 0,
        executionStats: {
          totalTimeMs: 0,
          avgTimeMs: 0,
          minTimeMs: null,
          maxTimeMs: null,
          lastRunTimeMs: null,
        },
      };
      this.charmStates.set(key, state);
    }

    return state;
  }

  /**
   * Updates state after charm execution
   */
  updateAfterExecution(
    space: DID,
    charmId: string,
    integrationId: string,
    result: CharmExecutionResult
  ): CharmState {
    const state = this.getCharmState(space, charmId, integrationId);
    const key = this.createCharmKey(space, charmId);
    
    // Update global stats
    this.stats.totalRuns++;
    this.stats.charmsProcessed.add(key);
    if (result.success) {
      this.stats.totalSuccesses++;
    } else {
      this.stats.totalFailures++;
    }

    // Update charm-specific stats
    state.lastRunTimestamp = Date.now();
    state.totalRuns++;

    if (result.success) {
      state.successfulRuns++;
      state.consecutiveFailures = 0;
    } else {
      state.failedRuns++;
      state.consecutiveFailures++;
      state.lastError = result.error?.message || "Unknown error";
      state.lastErrorTimestamp = Date.now();
    }

    // Update execution time stats
    const { executionTimeMs } = result;
    state.executionStats.totalTimeMs += executionTimeMs;
    state.executionStats.avgTimeMs = state.executionStats.totalTimeMs / state.totalRuns;
    state.executionStats.lastRunTimeMs = executionTimeMs;
    
    if (state.executionStats.minTimeMs === null || executionTimeMs < state.executionStats.minTimeMs) {
      state.executionStats.minTimeMs = executionTimeMs;
    }
    
    if (state.executionStats.maxTimeMs === null || executionTimeMs > state.executionStats.maxTimeMs) {
      state.executionStats.maxTimeMs = executionTimeMs;
    }

    return state;
  }

  /**
   * Disables a charm
   */
  disableCharm(space: DID, charmId: string): void {
    const key = this.createCharmKey(space, charmId);
    const state = this.charmStates.get(key);
    
    if (state) {
      state.enabled = false;
      log(undefined, `Disabled charm ${key} due to repeated failures`);
    }
  }

  /**
   * Checks if a charm is enabled
   */
  isCharmEnabled(space: DID, charmId: string): boolean {
    const key = this.createCharmKey(space, charmId);
    const state = this.charmStates.get(key);
    
    return state?.enabled ?? true;
  }

  /**
   * Logs the current states of all charms
   */
  logStates(): void {
    const totalCharms = this.charmStates.size;
    const enabledCharms = Array.from(this.charmStates.values()).filter(
      (state) => state.enabled
    ).length;
    
    log(undefined, "===== Background Charm Runner Status =====");
    log(undefined, `Runtime: ${this.getRuntime()}`);
    log(undefined, `Total charms tracked: ${totalCharms} (${enabledCharms} enabled, ${totalCharms - enabledCharms} disabled)`);
    log(undefined, `Total runs: ${this.stats.totalRuns} (${this.stats.totalSuccesses} successes, ${this.stats.totalFailures} failures)`);
    log(undefined, `Success rate: ${this.getSuccessRate().toFixed(2)}%`);
    log(undefined, "");
    
    // Log details for problematic charms (with failures)
    const problematicCharms = Array.from(this.charmStates.values())
      .filter((state) => state.failedRuns > 0)
      .sort((a, b) => b.consecutiveFailures - a.consecutiveFailures);
    
    if (problematicCharms.length > 0) {
      log(undefined, "Problematic Charms:");
      problematicCharms.forEach((state) => {
        const status = state.enabled ? "ENABLED" : "DISABLED";
        log(undefined, `- ${state.id} [${status}]`);
        log(undefined, `  Integration: ${state.integrationId}`);
        log(undefined, `  Success rate: ${((state.successfulRuns / state.totalRuns) * 100).toFixed(2)}%`);
        log(undefined, `  Consecutive failures: ${state.consecutiveFailures}`);
        if (state.lastError) {
          log(undefined, `  Last error: ${state.lastError}`);
        }
      });
    }
    
    log(undefined, "==========================================");
  }

  /**
   * Calculates the success rate as a percentage
   */
  private getSuccessRate(): number {
    if (this.stats.totalRuns === 0) return 100;
    return (this.stats.totalSuccesses / this.stats.totalRuns) * 100;
  }

  /**
   * Formats the runtime in a human-readable format
   */
  private getRuntime(): string {
    const runtime = Date.now() - this.stats.startTime;
    const seconds = Math.floor((runtime / 1000) % 60);
    const minutes = Math.floor((runtime / (1000 * 60)) % 60);
    const hours = Math.floor((runtime / (1000 * 60 * 60)) % 24);
    const days = Math.floor(runtime / (1000 * 60 * 60 * 24));
    
    return `${days}d ${hours}h ${minutes}m ${seconds}s`;
  }
}

// ========================= Failure Policies =========================

/**
 * Policy that disables charms after a specified number of consecutive failures
 */
export class ConsecutiveFailuresPolicy implements FailurePolicy {
  constructor(private maxConsecutiveFailures: number = 5) {}
  
  shouldDisable(state: CharmState): boolean {
    return state.consecutiveFailures >= this.maxConsecutiveFailures;
  }
  
  getDescription(): string {
    return `Disable after ${this.maxConsecutiveFailures} consecutive failures`;
  }
}

// ========================= Integrations =========================

/**
 * Gmail Integration
 */
export class GmailIntegration implements Integration {
  id = "gmail";
  name = "Gmail Integration";
  description = "Integration for Gmail charms";
  
  private toolshedUrl: string;
  private operatorPass: string;
  private cellAddress?: string;

  constructor(toolshedUrl: string, operatorPass: string, cellAddress?: string) {
    this.toolshedUrl = toolshedUrl;
    this.operatorPass = operatorPass;
    this.cellAddress = cellAddress;
  }

  async fetchCharms(): Promise<Array<{ space: DID; charmId: string }>> {
    try {
      log(undefined, "Fetching Gmail integration charms...");
      const charms = await getGmailIntegrationCharms();
      
      // Validate charms
      const validCharms = charms.filter(({ space, charmId }) => {
        if (!isValidDID(space as string)) {
          log(undefined, `Skipping invalid space ID: ${space}. Must be a valid DID.`);
          return false;
        }
        
        if (!isValidCharmId(charmId)) {
          log(undefined, `Skipping invalid charm ID: ${charmId}. Must be a valid merkle ID.`);
          return false;
        }
        
        return true;
      });
      
      log(undefined, `Found ${validCharms.length} valid Gmail charms out of ${charms.length} total`);
      return validCharms as Array<{ space: DID; charmId: string }>;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log(undefined, `Error fetching Gmail charms: ${errorMessage}`);
      return [];
    }
  }

  async executeCharm(
    charm: Cell<Charm>,
    argument: Cell<any>,
    space: DID,
    manager: CharmManager
  ): Promise<CharmExecutionResult> {
    const startTime = Date.now();
    
    try {
      const auth = argument.key("auth");
      const googleUpdater = charm.key("googleUpdater");
      
      if (!isStream(googleUpdater) || !auth) {
        return {
          success: false,
          executionTimeMs: Date.now() - startTime,
          error: new Error("Invalid Gmail charm: missing googleUpdater or auth"),
        };
      }
      
      const { token, expiresAt } = auth.get();
      
      // Refresh token if needed
      if (token && expiresAt && Date.now() > expiresAt) {
        log(charm, "Token expired, refreshing");
        
        try {
          await this.refreshAuthToken(auth, charm, space);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          log(charm, `Error refreshing token: ${errorMessage}`);
          
          return {
            success: false,
            executionTimeMs: Date.now() - startTime,
            error: new Error(`Token refresh failed: ${errorMessage}`),
          };
        }
      } else if (!token) {
        return {
          success: false,
          executionTimeMs: Date.now() - startTime,
          error: new Error("Missing authentication token"),
        };
      }
      
      // Execute the charm
      log(charm, "Calling googleUpdater in charm");
      googleUpdater.send({});
      
      return {
        success: true,
        executionTimeMs: Date.now() - startTime,
        metadata: {
          tokenRefreshed: expiresAt && Date.now() > expiresAt,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log(charm, `Error executing Gmail charm: ${errorMessage}`);
      
      return {
        success: false,
        executionTimeMs: Date.now() - startTime,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  private async refreshAuthToken(
    auth: Cell<any>,
    charm: Cell<Charm>,
    space: DID,
  ): Promise<void> {
    const authCellId = JSON.parse(JSON.stringify(auth.getAsCellLink()));
    authCellId.space = space as string;
    log(charm, `Token expired, refreshing: ${authCellId}`);
    
    const refresh_url = new URL(
      "/api/integrations/google-oauth/refresh",
      this.toolshedUrl,
    );
    
    const refresh_response = await fetch(refresh_url, {
      method: "POST",
      body: JSON.stringify({ authCellId }),
    });
    
    const refresh_data = await refresh_response.json();
    if (!refresh_data.success) {
      throw new Error(`Error refreshing token: ${JSON.stringify(refresh_data)}`);
    }
    
    await storage.synced();
    log(charm, "Token refreshed successfully");
  }
}

/**
 * Manual Charm Integration
 * Used for charms specified on the command line
 */
export class ManualCharmIntegration implements Integration {
  id = "manual";
  name = "Manual Charm Integration";
  description = "Integration for manually specified charms";
  
  private charmsInput: string;
  private toolshedUrl: string;
  private operatorPass: string;
  
  constructor(charmsInput: string, toolshedUrl: string, operatorPass: string) {
    this.charmsInput = charmsInput;
    this.toolshedUrl = toolshedUrl;
    this.operatorPass = operatorPass;
  }
  
  async fetchCharms(): Promise<Array<{ space: DID; charmId: string }>> {
    try {
      if (!this.charmsInput) return [];
      
      log(undefined, "Processing manually specified charms");
      const charms = parseCharmsInput(this.charmsInput);
      
      log(undefined, `Found ${charms.length} valid manually specified charms`);
      return charms;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log(undefined, `Error processing manual charms: ${errorMessage}`);
      return [];
    }
  }
  
  async executeCharm(
    charm: Cell<Charm>,
    argument: Cell<any>,
    space: DID,
    manager: CharmManager
  ): Promise<CharmExecutionResult> {
    // Delegate to Gmail integration implementation since the execution is the same
    const gmailIntegration = new GmailIntegration(
      this.toolshedUrl,
      this.operatorPass,
    );
    
    return gmailIntegration.executeCharm(charm, argument, space, manager);
  }
}

// ========================= Core Runner =========================

export class BackgroundCharmRunner {
  private stateManager: StateManager;
  private failurePolicy: FailurePolicy;
  private integrations: Integration[];
  private intervalId?: number;
  private running = false;
  private managerCache = new Map<string, CharmManager>();
  
  constructor(private config: CharmRunnerConfig) {
    this.stateManager = new StateManager(config.logIntervalSeconds);
    this.failurePolicy = config.failurePolicy;
    this.integrations = config.integrations;
    
    log(undefined, "Background Charm Runner initialized with configuration:");
    log(undefined, `- Interval: ${config.intervalSeconds} seconds`);
    log(undefined, `- Failure policy: ${config.failurePolicy.getDescription()}`);
    log(undefined, `- Integrations: ${config.integrations.map(i => i.name).join(", ")}`);
  }
  
  async start(): Promise<void> {
    if (this.running) {
      log(undefined, "Background Charm Runner is already running");
      return;
    }
    
    this.running = true;
    log(undefined, "Starting Background Charm Runner");
    
    // Run immediately
    await this.runCycle();
    
    // Set up interval
    this.intervalId = setInterval(() => {
      this.runCycle().catch(error => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log(undefined, `Error in run cycle: ${errorMessage}`);
      });
    }, this.config.intervalSeconds * 1000) as unknown as number;
    
    log(undefined, `Background Charm Runner started with ${this.config.intervalSeconds}s interval`);
  }
  
  stop(): void {
    if (!this.running) {
      log(undefined, "Background Charm Runner is not running");
      return;
    }
    
    this.running = false;
    if (this.intervalId !== undefined) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    
    log(undefined, "Background Charm Runner stopped");
    this.stateManager.logStates();
  }
  
  private async runCycle(): Promise<void> {
    log(undefined, "Starting charm execution cycle");
    
    for (const integration of this.integrations) {
      try {
        await this.processIntegration(integration);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log(undefined, `Error processing integration ${integration.id}: ${errorMessage}`);
      }
    }
    
    log(undefined, "Charm execution cycle completed");
  }
  
  private async processIntegration(integration: Integration): Promise<void> {
    log(undefined, `Processing integration: ${integration.name}`);
    
    const charms = await integration.fetchCharms();
    if (charms.length === 0) {
      log(undefined, `No charms found for integration: ${integration.name}`);
      return;
    }
    
    log(undefined, `Found ${charms.length} charms for integration: ${integration.name}`);
    
    // Process each charm
    for (const { space, charmId } of charms) {
      // Skip disabled charms
      if (!this.stateManager.isCharmEnabled(space, charmId)) {
        log(undefined, `Skipping disabled charm: ${space}/${charmId}`);
        continue;
      }
      
      try {
        await this.processCharm(space, charmId, integration);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log(undefined, `Error processing charm ${space}/${charmId}: ${errorMessage}`);
      }
    }
  }
  
  private async processCharm(
    space: DID,
    charmId: string,
    integration: Integration
  ): Promise<void> {
    log(undefined, `Processing charm: ${space}/${charmId}`);
    
    // Get or create manager for this space
    const manager = await this.getManagerForSpace(space);
    
    // Get the charm
    const charm = await manager.get(charmId, false);
    if (!charm) {
      log(charmId, "Charm not found");
      return;
    }
    
    // Get running charm and argument
    const runningCharm = await manager.get(charm, true);
    const argument = manager.getArgument(charm);
    
    if (!runningCharm || !argument) {
      log(charm, "Charm not properly loaded");
      return;
    }
    
    // Execute the charm
    const result = await integration.executeCharm(
      runningCharm,
      argument,
      space,
      manager
    );
    
    // Update state
    const state = this.stateManager.updateAfterExecution(
      space,
      charmId,
      integration.id,
      result
    );
    
    // Check if charm should be disabled
    if (!result.success && this.failurePolicy.shouldDisable(state)) {
      log(charm, `Disabling charm due to failure policy: ${this.failurePolicy.getDescription()}`);
      this.stateManager.disableCharm(space, charmId);
    }
  }
  
  private async getManagerForSpace(space: DID): Promise<CharmManager> {
    const spaceKey = space.toString();
    
    if (this.managerCache.has(spaceKey)) {
      return this.managerCache.get(spaceKey)!;
    }
    
    // Create a new session and manager
    const session = await Session.open({
      passphrase: OPERATOR_PASS,
      name: "~background-runner",
      space,
    });
    
    const manager = new CharmManager(session);
    this.managerCache.set(spaceKey, manager);
    
    return manager;
  }
}

// ========================= Utility Functions =========================

/**
 * Custom logger that includes timestamp and charm ID
 */
function log(charm?: Cell<Charm> | string, ...args: any[]) {
  const timestamp = new Date().toISOString();
  let charmIdSuffix = "";
  
  if (charm) {
    if (typeof charm === "string") {
      charmIdSuffix = ` [${charm.slice(-10)}]`;
    } else {
      const id = getEntityId(charm)?.["/"];
      if (id) {
        charmIdSuffix = ` [${id.slice(-10)}]`;
      }
    }
  }
  
  console.log(`${timestamp}${charmIdSuffix}`, ...args);
}

/**
 * Validates if a string is a valid DID
 */
function isValidDID(did: string): boolean {
  return did?.startsWith("did:key:") && did.length > 10;
}

/**
 * Validates if a string looks like a valid merkle ID
 */
function isValidCharmId(id: string): boolean {
  return !!id && id.length === 59;
}

/**
 * Parses input in the form:
 * `did:key:abc../xyzcharmid,did:key:def.../zyxcharmid`
 */
function parseCharmsInput(
  charms: string,
): ({ space: DID; charmId: string })[] {
  const result: ({ space: DID; charmId: string })[] = [];
  
  charms.split(",").forEach((entry) => {
    const parts = entry.split("/");
    if (parts.length !== 2) {
      log(undefined, `Invalid charm format: ${entry}. Expected format: space/charmId`);
      return; // Skip this entry
    }
    
    const [space, charmId] = parts;
    
    if (!isValidDID(space)) {
      log(undefined, `Invalid space ID: ${space}. Must be a valid DID.`);
      return; // Skip this entry
    }
    
    if (!isValidCharmId(charmId)) {
      log(undefined, `Invalid charm ID: ${charmId}. Must be a valid merkle ID.`);
      return; // Skip this entry
    }
    
    result.push({ space: space as DID, charmId });
  });
  
  return result;
}

// ========================= Command Line Interface =========================

// Constants
const TOOLSHED_URL = Deno.env.get("TOOLSHED_API_URL") ??
  "https://toolshed.saga-castor.ts.net/";
const OPERATOR_PASS = Deno.env.get("OPERATOR_PASS") ?? "implicit trust";

// Initialize storage and Bobby server
storage.setRemoteStorage(new URL(TOOLSHED_URL));
setBobbyServerUrl(TOOLSHED_URL);

async function main() {
  // Parse command line arguments
  const args = parse(Deno.args, {
    string: ["charms", "cell", "integration"],
    integer: ["interval", "failures", "log-interval"],
    boolean: ["help", "initialize"],
    default: {
      interval: 60,
      failures: 5,
      "log-interval": 300,
      integration: "gmail",
    },
  });
  
  // Show help if requested
  if (args.help) {
    showHelp();
    Deno.exit(0);
  }
  
  // Handle initialization if requested
  if (args.initialize) {
    await initializeGmailIntegrationCharmsCell();
    log(undefined, "Initialized Gmail integration charms cell with empty array");
    Deno.exit(0);
  }
  
  // Create integrations based on arguments
  const integrations: Integration[] = [];
  
  if (args.charms) {
    // Manual charm configuration
    integrations.push(
      new ManualCharmIntegration(args.charms as string, TOOLSHED_URL, OPERATOR_PASS)
    );
  } else {
    // Cell-based Gmail integration
    integrations.push(
      new GmailIntegration(TOOLSHED_URL, OPERATOR_PASS, args.cell)
    );
  }
  
  // Create failure policy
  const failurePolicy = new ConsecutiveFailuresPolicy(args.failures as number);
  
  // Create runner configuration
  const config: CharmRunnerConfig = {
    intervalSeconds: args.interval as number,
    logIntervalSeconds: args["log-interval"] as number,
    integrations,
    failurePolicy,
  };
  
  // Create and start runner
  const runner = new BackgroundCharmRunner(config);
  
  // Handle graceful shutdown
  const shutdown = () => {
    console.log("Shutting down...");
    runner.stop();
    Deno.exit(0);
  };
  
  // Register signal handlers
  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);
  
  // Start the runner
  await runner.start();
  
  log(undefined, "Background Charm Runner started successfully");
  log(undefined, "Press Ctrl+C to stop");
}

function showHelp() {
  console.log("Background Charm Runner");
  console.log("Usage: deno run background-charm-runner.ts [options]");
  console.log("");
  console.log("Options:");
  console.log("  --charms=<space/charm>,*   Comma-separated list of space/charm IDs");
  console.log("  --interval=<seconds>       Update interval in seconds (default: 60)");
  console.log("  --failures=<number>        Disable after N consecutive failures (default: 5)");
  console.log("  --log-interval=<seconds>   Log status interval in seconds (default: 300)");
  console.log("  --initialize               Initialize Gmail integration charms cell");
  console.log("  --help                     Show this help message");
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    Deno.exit(1);
  });
}