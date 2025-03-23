/**
 * Common utility functions shared across the service
 */
import { Cell, isStream, Stream } from "@commontools/runner";
import { Charm } from "@commontools/charm";

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
