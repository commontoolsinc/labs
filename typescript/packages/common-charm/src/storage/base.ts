import type { EntityId, Cancel } from "@commontools/runner";
import { log } from "../storage.js";

export interface StorageValue<T = any> {
  value: T;
  source?: EntityId;
}

/**
 * Metrics for storage operations
 */
export interface StorageMetrics {
  /** Number of send operations performed */
  sendCount: number;
  /** Number of sync operations performed */
  syncCount: number;
  /** Number of get operations performed */
  getCount: number;
  /** Number of sink subscriptions created */
  sinkCount: number;
  /** Number of currently active sink subscriptions */
  activeSinkCount: number;
  /** Average time for send operations in ms */
  avgSendTime: number;
  /** Average time for sync operations in ms */
  avgSyncTime: number;
  /** Last error message if any */
  lastError?: string;
  /** Timestamp when metrics were last reset */
  resetTime: number;
}

export interface StorageProvider {
  /**
   * Send a value to storage.
   *
   * @param batch - Batch of entity IDs & values to send.
   * @returns Promise that resolves when the value is sent.
   */
  send<T = any>(
    batch: { entityId: EntityId; value: StorageValue<T> }[],
  ): Promise<{ ok: {}; error?: undefined } | { ok?: undefined; error?: Error }>;

  /**
   * Sync a value from storage. Use `get()` to retrieve the value.
   *
   * @param entityId - Entity ID to sync.
   * @param expectedInStorage - Wait for the value, it's assumed to be in
   *   storage eventually.
   * @returns Promise that resolves when the value is synced.
   */
  sync(entityId: EntityId, expectedInStorage?: boolean): Promise<void>;

  /**
   * Get a value from the local cache reflecting storage. Call `sync()` first.
   *
   * @param entityId - Entity ID to get the value for.
   * @returns Value or undefined if the value is not in storage.
   */
  get<T = any>(entityId: EntityId): StorageValue<T> | undefined;

  /**
   * Subscribe to storage updates.
   *
   * @param entityId - Entity ID to subscribe to.
   * @param callback - Callback function.
   * @returns Cancel function to stop the subscription.
   */
  sink<T = any>(entityId: EntityId, callback: (value: StorageValue<T>) => void): Cancel;

  /**
   * Destroy the storage provider. Used for tests only.
   *
   * @returns Promise that resolves when the storage provider is destroyed.
   */
  destroy(): Promise<void>;

  /**
   * Get the storage provider's replica.
   *
   * @returns The storage provider's replica.
   */
  getReplica(): string | undefined;

  /**
   * Get metrics about storage operations.
   * 
   * @returns Metrics object with operation counts and timing information
   */
  getMetrics(): StorageMetrics;

  /**
   * Reset metrics counters.
   */
  resetMetrics(): void;
}

export abstract class BaseStorageProvider implements StorageProvider {
  protected subscribers = new Map<string, Set<(value: StorageValue) => void>>();
  protected waitingForSync = new Map<string, Promise<void>>();
  protected waitingForSyncResolvers = new Map<string, () => void>();

  // Metrics tracking
  protected metrics: StorageMetrics = {
    sendCount: 0,
    syncCount: 0,
    getCount: 0,
    sinkCount: 0,
    activeSinkCount: 0,
    avgSendTime: 0,
    avgSyncTime: 0,
    resetTime: Date.now(),
  };

  abstract send<T = any>(
    batch: { entityId: EntityId; value: StorageValue<T> }[],
  ): Promise<{ ok: {}; error?: undefined } | { ok?: undefined; error: Error }>;

  abstract sync(entityId: EntityId, expectedInStorage: boolean): Promise<void>;

  abstract get<T = any>(entityId: EntityId): StorageValue<T> | undefined;

  sink<T = any>(entityId: EntityId, callback: (value: StorageValue<T>) => void): Cancel {
    const key = JSON.stringify(entityId);

    if (!this.subscribers.has(key))
      this.subscribers.set(key, new Set<(value: StorageValue) => void>());
    const listeners = this.subscribers.get(key)!;
    listeners.add(callback);

    // Update metrics
    this.metrics.sinkCount++;
    this.metrics.activeSinkCount++;

    return () => {
      listeners.delete(callback);
      if (listeners.size === 0) this.subscribers.delete(key);
      
      // Update metrics
      this.metrics.activeSinkCount--;
    };
  }

  protected notifySubscribers(key: string, value: StorageValue): void {
    log("notify subscribers", key, JSON.stringify(value));
    const listeners = this.subscribers.get(key);
    if (this.waitingForSync.has(key) && listeners && listeners.size > 0)
      throw new Error("Subscribers are expected to only start after first sync.");
    this.resolveWaitingForSync(key);
    if (listeners) for (const listener of listeners) listener(value);
  }

  protected waitForSync(key: string): Promise<void> {
    if (!this.waitingForSync.has(key))
      this.waitingForSync.set(key, new Promise((r) => this.waitingForSyncResolvers.set(key, r)));
    log("waiting for sync", key, [...this.waitingForSync.keys()]);
    return this.waitingForSync.get(key)!;
  }

  protected resolveWaitingForSync(key: string): void {
    const resolver = this.waitingForSyncResolvers.get(key);
    if (resolver) {
      resolver();
      this.waitingForSync.delete(key);
    }
  }

  abstract destroy(): Promise<void>;

  abstract getReplica(): string | undefined;

  /**
   * Get metrics about storage operations.
   */
  getMetrics(): StorageMetrics {
    return { ...this.metrics };
  }

  /**
   * Reset metrics counters.
   */
  resetMetrics(): void {
    this.metrics = {
      sendCount: 0,
      syncCount: 0,
      getCount: 0,
      sinkCount: 0,
      activeSinkCount: this.metrics.activeSinkCount, // Keep current active count
      avgSendTime: 0,
      avgSyncTime: 0,
      resetTime: Date.now(),
    };
  }

  /**
   * Update metrics for a timed operation
   */
  protected updateTimedMetric(metric: 'avgSendTime' | 'avgSyncTime', time: number): void {
    const count = metric === 'avgSendTime' ? this.metrics.sendCount : this.metrics.syncCount;
    
    if (count <= 1) {
      this.metrics[metric] = time;
    } else {
      // Compute running average
      this.metrics[metric] = (this.metrics[metric] * (count - 1) + time) / count;
    }
  }
}
