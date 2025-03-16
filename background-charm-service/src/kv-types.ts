import { Cell } from "@commontools/runner";
import { Charm } from "@commontools/charm";
import type { DID } from "@commontools/identity";
import { IntegrationCellConfig } from "./types.ts";

// KV store prefixes
export const KV_PREFIXES = {
  CHARM_STATE: ["charm_state"],
  SERVICE_STATE: ["service_state"],
  INTEGRATION_CONFIG: ["integration_config"],
  JOB_QUEUE: ["job_queue"],
  JOB_RESULTS: ["job_results"],
};

// Job types
export enum JobType {
  SCAN_INTEGRATION = "scan_integration",
  EXECUTE_CHARM = "execute_charm",
  MAINTENANCE = "maintenance",
}

// Job status
export type JobStatus = "pending" | "processing" | "completed" | "failed";

// Base job interface
export interface Job {
  id: string;
  type: JobType;
  createdAt: number;
  priority: number; 
  retryCount: number;
  maxRetries: number;
  status: JobStatus;
  // Internal property for tracking KV entry version
  _versionstamp?: string;
}

// Scan integration job
export interface ScanIntegrationJob extends Job {
  type: JobType.SCAN_INTEGRATION;
  integrationId: string;
}

// Execute charm job
export interface ExecuteCharmJob extends Job {
  type: JobType.EXECUTE_CHARM;
  integrationId: string;
  spaceId: string;
  charmId: string;
}

// Maintenance job
export interface MaintenanceJob extends Job {
  type: JobType.MAINTENANCE;
  task: "cleanup" | "stats" | "reset";
}

// Job result
export interface JobResult {
  jobId: string;
  success: boolean;
  error?: string;
  data?: unknown;
  completedAt: number;
  executionTimeMs: number;
}

// Charm state in KV store
export interface CharmStateEntry {
  // Identifiers
  charmId: string;
  integrationId: string;
  spaceId: string;
  
  // Status
  disabled: boolean;
  lastExecuted: number | null;
  
  // Error tracking
  consecutiveFailures: number;
  lastError: string | null;
  lastErrorTimestamp: number | null;
  
  // Performance stats
  totalExecutions: number;
  totalSuccesses: number;
  totalFailures: number;
  avgExecutionTimeMs: number;
  minExecutionTimeMs: number | null;
  maxExecutionTimeMs: number | null;
  lastExecutionTimeMs: number | null;
}

// Service state in KV store
export interface ServiceStateEntry {
  // Timing
  startTime: number;
  lastCycleStart: number | null;
  lastCycleEnd: number | null;
  
  // Stats
  cyclesCompleted: number;
  totalCharmsProcessed: number;
  totalSuccesses: number;
  totalFailures: number;
  
  // Version
  version: string;
}

// Service options
export interface KVServiceOptions {
  kv: Deno.Kv;
  cycleIntervalMs?: number;
  maxConcurrentJobs?: number;
  maxRetries?: number;
  charmTimeoutMs?: number;
  logIntervalMs?: number;
}