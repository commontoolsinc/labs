import { CharmStateEntry, KV_PREFIXES, ServiceStateEntry } from "./types.ts";
import { log } from "./utils.ts";

/**
 * Manages state storage and retrieval in Deno KV
 */
export class StateManager {
  private kv: Deno.Kv;
  private logIntervalMs: number;
  private logIntervalId: number | null = null;

  constructor(kv: Deno.Kv, logIntervalMs: number = 300000) {
    this.kv = kv;
    this.logIntervalMs = logIntervalMs;
  }

  /**
   * Initialize the state manager
   */
  async initialize(): Promise<void> {
    // Initialize service state if it doesn't exist
    const serviceState = await this.getServiceState();
    if (!serviceState) {
      await this.setServiceState({
        startTime: Date.now(),
        lastCycleStart: null,
        lastCycleEnd: null,
        cyclesCompleted: 0,
        totalCharmsProcessed: 0,
        totalSuccesses: 0,
        totalFailures: 0,
        version: "1.0.0",
      });
      log("Initialized service state in KV store");
    }

    // Set up periodic logging
    this.setupLogging();
  }

  /**
   * Set up periodic state logging
   */
  private setupLogging(): void {
    if (this.logIntervalId !== null) {
      clearInterval(this.logIntervalId);
    }

    this.logIntervalId = setInterval(() => {
      this.logState();
    }, this.logIntervalMs) as unknown as number;

    log(`State logging set up with interval ${this.logIntervalMs}ms`);
  }

  /**
   * Stop periodic logging
   */
  stop(): void {
    if (this.logIntervalId !== null) {
      clearInterval(this.logIntervalId);
      this.logIntervalId = null;
    }
  }

  // ====== CHARM STATE METHODS ======

  /**
   * Get the state of a charm
   */
  async getCharmState(
    spaceId: string,
    charmId: string,
  ): Promise<CharmStateEntry | null> {
    const key = [...KV_PREFIXES.CHARM_STATE, spaceId, charmId];
    const result = await this.kv.get<CharmStateEntry>(key);
    return result.value;
  }

  /**
   * Create or update a charm state
   */
  async setCharmState(state: CharmStateEntry): Promise<void> {
    const key = [
      ...KV_PREFIXES.CHARM_STATE,
      state.spaceId,
      state.charmId,
    ];
    await this.kv.set(key, state);
  }

  /**
   * Update part of a charm state, creating it if it doesn't exist
   */
  async updateCharmState(
    spaceId: string,
    charmId: string,
    updates: Partial<CharmStateEntry>,
  ): Promise<CharmStateEntry> {
    // Get existing state or create default
    const existing = await this.getCharmState(spaceId, charmId);
    const baseState: CharmStateEntry = existing || {
      charmId,
      spaceId,
      disabled: false,
      lastExecuted: null,
      consecutiveFailures: 0,
      lastError: null,
      lastErrorTimestamp: null,
      totalExecutions: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      avgExecutionTimeMs: 0,
      minExecutionTimeMs: null,
      maxExecutionTimeMs: null,
      lastExecutionTimeMs: null,
    };

    // Create updated state
    const updatedState = { ...baseState, ...updates };

    // Save to KV
    await this.setCharmState(updatedState);

    return updatedState;
  }

  /**
   * Update charm state after execution
   */
  async updateAfterExecution(
    spaceId: string,
    charmId: string,
    success: boolean,
    executionTimeMs: number,
    error?: Error,
  ): Promise<CharmStateEntry> {
    // Get current state
    const existing = await this.getCharmState(spaceId, charmId);

    // Create base state if it doesn't exist
    const baseState: CharmStateEntry = existing || {
      charmId,
      spaceId,
      disabled: false,
      lastExecuted: null,
      consecutiveFailures: 0,
      lastError: null,
      lastErrorTimestamp: null,
      totalExecutions: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      avgExecutionTimeMs: 0,
      minExecutionTimeMs: null,
      maxExecutionTimeMs: null,
      lastExecutionTimeMs: null,
    };

    // Calculate new execution stats
    const totalExecutions = baseState.totalExecutions + 1;
    const totalSuccesses = baseState.totalSuccesses + (success ? 1 : 0);
    const totalFailures = baseState.totalFailures + (success ? 0 : 1);
    const totalTimeMs =
      (baseState.avgExecutionTimeMs * baseState.totalExecutions) +
      executionTimeMs;
    const avgExecutionTimeMs = totalTimeMs / totalExecutions;
    const minExecutionTimeMs = baseState.minExecutionTimeMs === null
      ? executionTimeMs
      : Math.min(baseState.minExecutionTimeMs, executionTimeMs);
    const maxExecutionTimeMs = baseState.maxExecutionTimeMs === null
      ? executionTimeMs
      : Math.max(baseState.maxExecutionTimeMs, executionTimeMs);

    // Calculate consecutive failures
    const consecutiveFailures = success ? 0 : baseState.consecutiveFailures + 1;

    // Build updates
    const updates: Partial<CharmStateEntry> = {
      lastExecuted: Date.now(),
      totalExecutions,
      totalSuccesses,
      totalFailures,
      consecutiveFailures,
      avgExecutionTimeMs,
      minExecutionTimeMs,
      maxExecutionTimeMs,
      lastExecutionTimeMs: executionTimeMs,
    };

    // Add error info if applicable
    if (!success && error) {
      updates.lastError = error.message;
      updates.lastErrorTimestamp = Date.now();
    }

    // Update service stats in the background
    this.updateServiceStatsAfterExecution(success).catch((err) => {
      log(`Error updating service stats: ${err.message}`);
    });

    // Apply updates
    return this.updateCharmState(spaceId, charmId, updates);
  }

  /**
   * Disable a charm
   */
  async disableCharm(
    spaceId: string,
    charmId: string,
  ): Promise<void> {
    await this.updateCharmState(spaceId, charmId, {
      disabled: true,
    });
    log(`Disabled charm ${spaceId}/${charmId}`);
  }

  /**
   * Check if a charm is disabled
   */
  async isCharmDisabled(
    spaceId: string,
    charmId: string,
  ): Promise<boolean> {
    // FIXME(ja): we should check if the charm is no longer in the charm list too!
    const state = await this.getCharmState(spaceId, charmId);
    return state?.disabled || false;
  }

  /**
   * Get all charm states
   */
  async getAllCharmStates(): Promise<CharmStateEntry[]> {
    const entries = this.kv.list<CharmStateEntry>({
      prefix: KV_PREFIXES.CHARM_STATE,
    });
    const states: CharmStateEntry[] = [];

    for await (const entry of entries) {
      states.push(entry.value);
    }

    return states;
  }

  // ====== SERVICE STATE METHODS ======

  /**
   * Get the service state
   */
  async getServiceState(): Promise<ServiceStateEntry | null> {
    const result = await this.kv.get<ServiceStateEntry>(
      KV_PREFIXES.SERVICE_STATE,
    );
    return result.value;
  }

  /**
   * Set the service state
   */
  async setServiceState(state: ServiceStateEntry): Promise<void> {
    await this.kv.set(KV_PREFIXES.SERVICE_STATE, state);
  }

  /**
   * Update part of the service state
   */
  async updateServiceState(
    updates: Partial<ServiceStateEntry>,
  ): Promise<ServiceStateEntry> {
    const existing = await this.getServiceState();
    if (!existing) {
      throw new Error("Service state not initialized");
    }

    const updated = { ...existing, ...updates };
    await this.setServiceState(updated);
    return updated;
  }

  /**
   * Update service stats after charm execution
   */
  private async updateServiceStatsAfterExecution(
    success: boolean,
  ): Promise<void> {
    const state = await this.getServiceState();
    if (!state) return;

    const updates: Partial<ServiceStateEntry> = {
      totalCharmsProcessed: state.totalCharmsProcessed + 1,
    };

    if (success) {
      updates.totalSuccesses = state.totalSuccesses + 1;
    } else {
      updates.totalFailures = state.totalFailures + 1;
    }

    await this.updateServiceState(updates);
  }

  /**
   * Update cycle stats
   */
  async updateCycleStats(isStart: boolean): Promise<void> {
    const updates: Partial<ServiceStateEntry> = isStart
      ? { lastCycleStart: Date.now() }
      : {
        lastCycleEnd: Date.now(),
        cyclesCompleted: (await this.getServiceState())!.cyclesCompleted + 1,
      };

    await this.updateServiceState(updates);
  }

  /**
   * Log the current state
   */
  async logState(): Promise<void> {
    try {
      const serviceState = await this.getServiceState();
      if (!serviceState) {
        log("No service state found");
        return;
      }

      const allCharmStates = await this.getAllCharmStates();
      const totalCharms = allCharmStates.length;
      const disabledCharms = allCharmStates.filter((s) => s.disabled).length;

      // Calculate runtime
      const uptime = this.formatUptime(Date.now() - serviceState.startTime);

      // Calculate success rate
      const totalRuns = serviceState.totalSuccesses +
        serviceState.totalFailures;
      const successRate = totalRuns > 0
        ? (serviceState.totalSuccesses / totalRuns * 100).toFixed(2)
        : "100.00";

      // Log service stats
      log("===== KV Background Charm Service Status =====");
      log(`Uptime: ${uptime}`);
      log(
        `Total charms: ${totalCharms} (${
          totalCharms - disabledCharms
        } enabled, ${disabledCharms} disabled)`,
      );
      log(
        `Total executions: ${totalRuns} (${serviceState.totalSuccesses} successes, ${serviceState.totalFailures} failures)`,
      );
      log(`Success rate: ${successRate}%`);
      log(`Cycles completed: ${serviceState.cyclesCompleted}`);
      log("");

      // Log problematic charms
      const problematicCharms = allCharmStates
        .filter((s) => s.consecutiveFailures > 0)
        .sort((a, b) => b.consecutiveFailures - a.consecutiveFailures);

      if (problematicCharms.length > 0) {
        log("Problematic Charms:");
        for (const state of problematicCharms.slice(0, 10)) { // Show top 10 most problematic
          const status = state.disabled ? "DISABLED" : "ENABLED";
          log(`- ${state.spaceId}/${state.charmId} [${status}]`);
          log(
            `  Success rate: ${
              (state.totalSuccesses / state.totalExecutions * 100).toFixed(2)
            }%`,
          );
          log(`  Consecutive failures: ${state.consecutiveFailures}`);
          if (state.lastError) {
            log(`  Last error: ${state.lastError}`);
          }
        }
      }

      log("============================================");
    } catch (error) {
      log(
        `Error logging state: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Format uptime in a human-readable format
   */
  private formatUptime(ms: number): string {
    const seconds = Math.floor((ms / 1000) % 60);
    const minutes = Math.floor((ms / (1000 * 60)) % 60);
    const hours = Math.floor((ms / (1000 * 60 * 60)) % 24);
    const days = Math.floor(ms / (1000 * 60 * 60 * 24));

    return `${days}d ${hours}h ${minutes}m ${seconds}s`;
  }
}
