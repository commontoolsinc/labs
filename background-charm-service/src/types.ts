import { Cell } from "@commontools/runner";
import { Charm, CharmManager } from "@commontools/charm";
import type { DID } from "@commontools/identity";

/**
 * Configuration for the Background Charm Service
 */
export interface CharmServiceConfig {
  // Basic settings
  intervalSeconds: number;
  logIntervalSeconds: number;
  
  // Failure policy configuration
  maxConsecutiveFailures: number;
  
  // Integration cell configuration
  integrationCells: IntegrationCellConfig[];
}

/**
 * Configuration for an integration cell
 */
export interface IntegrationCellConfig {
  // Unique identifier for this integration 
  id: string;
  
  // User-friendly name for logs
  name: string;
  
  // Space ID where the integration cell is located
  spaceId: string;
  
  // Cell ID for the integration cell
  cellId: string;
  
  // Custom fetcher function for retrieving charms
  fetchCharms: () => Promise<Array<{space: DID; charmId: string}>>;
  
  // Validator function that determines if a charm belongs to this integration
  isValidIntegrationCharm?: (charm: Cell<Charm>) => boolean;
}

/**
 * State tracking for a charm
 */
export interface CharmState {
  // Unique identifier for this charm (space/charmId)
  id: string;
  
  // Integration this charm belongs to
  integrationId: string;
  
  // Whether this charm is currently enabled
  enabled: boolean;
  
  // Execution statistics
  lastRunTimestamp: number | null;
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  consecutiveFailures: number;
  
  // Last error information
  lastError?: string;
  lastErrorTimestamp?: number;
  
  // Performance metrics
  executionStats: {
    totalTimeMs: number;
    avgTimeMs: number;
    minTimeMs: number | null;
    maxTimeMs: number | null;
    lastRunTimeMs: number | null;
  };
}

/**
 * Result of a charm execution
 */
export interface CharmExecutionResult {
  success: boolean;
  executionTimeMs: number;
  error?: Error;
  metadata?: Record<string, unknown>;
}

/**
 * Overall statistics for the charm service
 */
export interface CharmServiceStats {
  totalRuns: number;
  totalSuccesses: number;
  totalFailures: number;
  startTime: number;
  charmsProcessed: Set<string>;
}