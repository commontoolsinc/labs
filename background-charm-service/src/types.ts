import { Cell } from "@commontools/runner";
import type { BGCharmEntry } from "@commontools/utils";

export type CharmStateEntry = {
  bgCharmEntry: Cell<BGCharmEntry>;

  // local status
  disabled: boolean;
  lastExecuted: number | null;
  lastFinished: number | null;

  // Error tracking
  consecutiveFailures: number;
  lastError: string | null;
  lastErrorTimestamp: number | null;
};

export interface CharmExecutionResult {
  success: boolean;
  executionTimeMs: number;
  error?: Error;
  metadata?: Record<string, unknown>;
}

// Job status
export type JobStatus = "pending" | "processing" | "completed" | "failed";

// Base job interface
export interface Job {
  bgCharmEntry: Cell<BGCharmEntry>;
  createdAt: number;
  priority: number;
  retryCount: number;
  maxRetries: number;
  status: JobStatus;
  timeoutMs: number;
}

// Execute charm job
export interface ExecuteCharmJob extends Job {
  integrationId: string;
  spaceId: string;
  charmId: string;
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
