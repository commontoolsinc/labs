/**
 * Common utility functions shared across the service
 */
import { Cell, isStream, Stream } from "@commontools/runner";
import { Charm } from "@commontools/charm";
import { WorkerPool } from "./worker-pool.ts";

export type WorkerPoolOptions = {
  maxWorkers: number;
  maxWorkerLifetimeMs: number;
  workerMaxBusyTimeMs: number;
  maxWorkerTasks: number;
  maxQueueLength: number;
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
};

// Create a singleton worker pool that can be shared across the application
let sharedWorkerPool: WorkerPool<any, any> | null = null;

export function getSharedWorkerPool(
  maxWorkers: number,
): WorkerPool<any, any> {
  if (!sharedWorkerPool) {
    const workerUrl = new URL("./charm-worker.ts", import.meta.url).href;
    sharedWorkerPool = new WorkerPool({
      maxWorkers,
      maxWorkerLifetimeMs: 8 * 60 * 60 * 1000, // 8 hours
      maxWorkerTasks: 1000,
      maxQueueLength: 1000,
      workerMaxBusyTimeMs: 2 * 60 * 1000, // 2 min
      workerUrl,
      workerOptions: {
        type: "module",
        deno: {
          permissions: {
            read: true,
            write: true,
            net: true,
            env: true,
          },
        },
      },
    });
  }
  return sharedWorkerPool;
}

export function findUpdaterStream(charm: Cell<Charm>): Stream<any> | null {
  const stream = charm.key("bgUpdater");
  if (isStream(stream)) {
    return stream;
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
