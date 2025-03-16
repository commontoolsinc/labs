import { Cell } from "@commontools/runner";
import { Charm, CharmManager } from "@commontools/charm";
import type { DID } from "@commontools/identity";
import { CharmState, CharmExecutionResult, CharmServiceStats } from "./types.ts";
import { log } from "./utils.ts";

/**
 * Manages state tracking for all charms processed by the service
 */
export class StateManager {
  private charmStates = new Map<string, CharmState>();
  private stats: CharmServiceStats = {
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
    
    log(undefined, "===== Background Charm Service Status =====");
    log(undefined, `Runtime: ${this.getRuntime()}`);
    log(undefined, `Total charms tracked: ${totalCharms} (${enabledCharms} enabled, ${totalCharms - enabledCharms} disabled)`);
    log(undefined, `Total runs: ${this.stats.totalRuns} (${this.stats.totalSuccesses} successes, ${this.stats.totalFailures} failures)`);
    log(undefined, `Success rate: ${this.getSuccessRate().toFixed(2)}%`);
    log(undefined, "");
    
    // Group charms by integration
    const charmsByIntegration = new Map<string, CharmState[]>();
    Array.from(this.charmStates.values()).forEach(state => {
      if (!charmsByIntegration.has(state.integrationId)) {
        charmsByIntegration.set(state.integrationId, []);
      }
      charmsByIntegration.get(state.integrationId)!.push(state);
    });
    
    // Log integration summaries
    charmsByIntegration.forEach((states, integrationId) => {
      const enabledCount = states.filter(s => s.enabled).length;
      const totalRuns = states.reduce((sum, s) => sum + s.totalRuns, 0);
      const failedRuns = states.reduce((sum, s) => sum + s.failedRuns, 0);
      
      log(undefined, `Integration: ${integrationId}`);
      log(undefined, `- Charms: ${states.length} (${enabledCount} enabled)`);
      log(undefined, `- Total runs: ${totalRuns}`);
      log(undefined, `- Success rate: ${totalRuns > 0 ? ((totalRuns - failedRuns) / totalRuns * 100).toFixed(2) : 100}%`);
    });
    
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