/**
 * Common utility functions shared across the service
 */
import { Cell, isStream, Stream } from "@commontools/runner";
import { Charm } from "@commontools/charm";
import { log } from "../utils.ts";
import { WorkerPool } from "./worker-pool.ts";

// Create a singleton worker pool that can be shared across the application
let sharedWorkerPool: WorkerPool<any, any> | null = null;

/**
 * Get or create the shared worker pool
 */
export function getSharedWorkerPool(options: {
  maxWorkers: number;
  workerUrl: string;
  workerOptions?: {
    type?: "classic" | "module";
    name?: string;
    deno?: {
      permissions?: {
        read?: boolean;
        write?: boolean;
        net?: boolean;
        env?: boolean;
        run?: boolean;
        ffi?: boolean;
        hrtime?: boolean;
      };
    };
  };
  taskTimeout?: number;
  healthCheckIntervalMs?: number;
}): WorkerPool<any, any> {
  if (!sharedWorkerPool) {
    sharedWorkerPool = new WorkerPool(options);
    log(`Created shared worker pool with ${options.maxWorkers} max workers`);
  }
  return sharedWorkerPool;
}

/**
 * Find an updater stream in a charm by checking common stream names
 * This is a centralized implementation of the findUpdaterStream functionality
 */
export function findUpdaterStream(charm: Cell<Charm>): Stream<any> | null {
  // Check for known updater streams
  const streamNames = [
    "bgUpdater",
  ];

  for (const name of streamNames) {
    const stream = charm.key(name);
    if (isStream(stream)) {
      // Log which stream we found to help debugging
      log(
        `Found stream '${name}' in charm ${
          charm.entityId ? charm.entityId["/"] : "unknown"
        }`,
      );
      return stream;
    }
  }

  // If no stream found, log all available keys in the charm
  const charmId = charm.entityId ? charm.entityId["/"] : "unknown";
  try {
    const keys = Object.keys(charm.toJSON());
    log(
      `No updater stream found in charm ${charmId}. Available keys: ${
        keys.join(", ")
      }`,
    );
  } catch (error) {
    log(
      `No updater stream found in charm ${charmId} and could not enumerate keys`,
    );
  }

  return null;
}

/**
 * Format error for logging
 */
export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

/**
 * Format uptime in a human-readable format
 */
export function formatUptime(ms: number): string {
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor((ms / (1000 * 60 * 60)) % 24);
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));

  return `${days}d ${hours}h ${minutes}m ${seconds}s`;
}

/**
 * Create an AbortController with a timeout
 */
export function createTimeoutController(timeoutMs: number): {
  controller: AbortController;
  timeoutId: number;
  clear: () => void;
} {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs) as unknown as number;

  return {
    controller,
    timeoutId,
    clear: () => clearTimeout(timeoutId),
  };
}
