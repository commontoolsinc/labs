// Server-side per-space concurrency limiting for LLM requests
// This prevents CPU saturation and ensures fair scheduling across spaces

const DEFAULT_MAX_CONCURRENT_PER_SPACE = 5;
const DEFAULT_SPACE = "__default__";
// Clean up idle space queues after 5 minutes of inactivity
const IDLE_CLEANUP_MS = 5 * 60 * 1000;

interface SpaceQueue {
  currentCount: number;
  maxConcurrent: number;
  waitQueue: Array<() => void>;
  lastActivity: number;
}

// Map of space ID to its queue
const spaceQueues = new Map<string, SpaceQueue>();

// Default concurrency limit for new spaces
let defaultMaxConcurrent = DEFAULT_MAX_CONCURRENT_PER_SPACE;

// Cleanup timer reference
let cleanupTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Get or create a queue for a space
 */
function getOrCreateQueue(spaceId: string): SpaceQueue {
  let queue = spaceQueues.get(spaceId);
  if (!queue) {
    queue = {
      currentCount: 0,
      maxConcurrent: defaultMaxConcurrent,
      waitQueue: [],
      lastActivity: Date.now(),
    };
    spaceQueues.set(spaceId, queue);
    scheduleCleanup();
  }
  return queue;
}

/**
 * Acquire a slot for a request. If the space's concurrency limit is reached,
 * the request will wait until a slot becomes available.
 *
 * @param spaceId - The space identifier. If not provided, uses a default space.
 * @returns A promise that resolves when a slot is acquired
 */
export function acquireSlot(spaceId?: string): Promise<void> {
  const effectiveSpaceId = spaceId || DEFAULT_SPACE;
  const queue = getOrCreateQueue(effectiveSpaceId);
  queue.lastActivity = Date.now();

  if (queue.currentCount < queue.maxConcurrent) {
    queue.currentCount++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    queue.waitQueue.push(resolve);
  });
}

/**
 * Release a slot after a request completes.
 *
 * @param spaceId - The space identifier. Must match the one used in acquireSlot.
 */
export function releaseSlot(spaceId?: string): void {
  const effectiveSpaceId = spaceId || DEFAULT_SPACE;
  const queue = spaceQueues.get(effectiveSpaceId);

  if (!queue) {
    console.warn(
      `[throttle] Attempted to release slot for unknown space: ${effectiveSpaceId}`,
    );
    return;
  }

  queue.lastActivity = Date.now();
  const next = queue.waitQueue.shift();
  if (next) {
    // Pass the slot directly to the next waiter
    next();
  } else {
    queue.currentCount--;
  }
}

/**
 * Set the default concurrency limit for new spaces.
 * Does not affect existing spaces - use setSpaceConcurrencyLimit for that.
 *
 * @param max - Maximum concurrent requests per space. 0 or negative means unlimited.
 */
export function setLLMConcurrencyLimit(max: number): void {
  defaultMaxConcurrent = max <= 0 ? Infinity : max;
}

/**
 * Set the concurrency limit for a specific space.
 * If the new limit is higher than before, waiting requests may be released.
 *
 * @param spaceId - The space identifier
 * @param max - Maximum concurrent requests. 0 or negative means unlimited.
 */
export function setSpaceConcurrencyLimit(spaceId: string, max: number): void {
  const queue = getOrCreateQueue(spaceId);
  const oldMax = queue.maxConcurrent;
  queue.maxConcurrent = max <= 0 ? Infinity : max;

  // If we increased the limit, release waiting requests
  if (queue.maxConcurrent > oldMax) {
    const toRelease = Math.min(
      queue.maxConcurrent - oldMax,
      queue.waitQueue.length,
    );
    for (let i = 0; i < toRelease; i++) {
      const next = queue.waitQueue.shift();
      if (next) {
        queue.currentCount++;
        next();
      }
    }
  }
}

/**
 * Get concurrency statistics for a specific space or all spaces.
 *
 * @param spaceId - Optional space identifier. If not provided, returns aggregate stats.
 */
export function getLLMConcurrencyStats(spaceId?: string): {
  active: number;
  queued: number;
  spaces?: number;
} {
  if (spaceId) {
    const queue = spaceQueues.get(spaceId);
    if (!queue) {
      return { active: 0, queued: 0 };
    }
    return { active: queue.currentCount, queued: queue.waitQueue.length };
  }

  // Aggregate stats across all spaces
  let totalActive = 0;
  let totalQueued = 0;
  for (const queue of spaceQueues.values()) {
    totalActive += queue.currentCount;
    totalQueued += queue.waitQueue.length;
  }
  return { active: totalActive, queued: totalQueued, spaces: spaceQueues.size };
}

/**
 * Get detailed statistics for all spaces.
 * Useful for debugging and monitoring.
 */
export function getAllSpaceStats(): Map<
  string,
  {
    active: number;
    queued: number;
    maxConcurrent: number;
    lastActivity: number;
  }
> {
  const stats = new Map<
    string,
    {
      active: number;
      queued: number;
      maxConcurrent: number;
      lastActivity: number;
    }
  >();
  for (const [spaceId, queue] of spaceQueues.entries()) {
    stats.set(spaceId, {
      active: queue.currentCount,
      queued: queue.waitQueue.length,
      maxConcurrent: queue.maxConcurrent,
      lastActivity: queue.lastActivity,
    });
  }
  return stats;
}

/**
 * Schedule periodic cleanup of idle space queues
 */
function scheduleCleanup(): void {
  if (cleanupTimer) {
    return; // Already scheduled
  }
  cleanupTimer = setTimeout(cleanupIdleQueues, IDLE_CLEANUP_MS);
}

/**
 * Clean up space queues that have been idle for too long.
 * A queue is considered idle if it has no active requests, no waiting requests,
 * and hasn't been used for IDLE_CLEANUP_MS.
 */
function cleanupIdleQueues(): void {
  cleanupTimer = null;
  const now = Date.now();
  const toDelete: string[] = [];

  for (const [spaceId, queue] of spaceQueues.entries()) {
    // Don't delete the default space
    if (spaceId === DEFAULT_SPACE) {
      continue;
    }

    // Check if the queue is truly idle
    const isIdle = queue.currentCount === 0 &&
      queue.waitQueue.length === 0 &&
      (now - queue.lastActivity) >= IDLE_CLEANUP_MS;

    if (isIdle) {
      toDelete.push(spaceId);
    }
  }

  for (const spaceId of toDelete) {
    spaceQueues.delete(spaceId);
  }

  // Reschedule cleanup if there are still queues
  if (spaceQueues.size > 0) {
    scheduleCleanup();
  }
}

/**
 * Force cleanup of all idle queues. Useful for testing.
 */
export function forceCleanup(): void {
  if (cleanupTimer) {
    clearTimeout(cleanupTimer);
    cleanupTimer = null;
  }
  cleanupIdleQueues();
}

/**
 * Reset all throttling state. Useful for testing.
 * WARNING: This will clear all queues and waiting requests!
 */
export function resetThrottleState(): void {
  if (cleanupTimer) {
    clearTimeout(cleanupTimer);
    cleanupTimer = null;
  }
  spaceQueues.clear();
  defaultMaxConcurrent = DEFAULT_MAX_CONCURRENT_PER_SPACE;
}
