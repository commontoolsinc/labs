import type { EntityId } from "@commontools/runner";
import { log } from "../storage.js";
import { BaseStorageProvider, type StorageValue } from "./base.js";

/**
 * In-memory storage provider for testing and development.
 */
export class InMemoryStorageProvider extends BaseStorageProvider {
  private storage = new Map<string, StorageValue<any>>();

  async send<T = any>(
    batch: { entityId: EntityId; value: StorageValue<T> }[],
  ): Promise<{ ok: {}; error?: undefined } | { ok?: undefined; error: Error }> {
    // Track metrics
    this.metrics.sendCount++;
    const startTime = performance.now();
    
    try {
      for (const { entityId, value } of batch) {
        const key = JSON.stringify(entityId);
        this.storage.set(key, value);
        this.notifySubscribers(key, value);
        log("send memory", key, JSON.stringify(value));
      }
      
      // Update metrics
      this.updateTimedMetric('avgSendTime', performance.now() - startTime);
      return { ok: {} };
    } catch (error) {
      // Track error in metrics
      this.metrics.lastError = error instanceof Error ? error.message : String(error);
      return { error: error instanceof Error ? error : new Error(String(error)) };
    }
  }

  async sync(entityId: EntityId, expectedInStorage: boolean = false): Promise<void> {
    // Track metrics
    this.metrics.syncCount++;
    const startTime = performance.now();
    
    try {
      const key = JSON.stringify(entityId);
      const value = this.storage.get(key);
      log("sync memory", key, value);
      
      if (value === undefined && expectedInStorage) {
        return this.waitForSync(key);
      }
      
      // Update metrics
      this.updateTimedMetric('avgSyncTime', performance.now() - startTime);
    } catch (error) {
      // Track error in metrics
      this.metrics.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  get<T = any>(entityId: EntityId): StorageValue<T> | undefined {
    // Track metrics
    this.metrics.getCount++;
    
    const key = JSON.stringify(entityId);
    return this.storage.get(key) as StorageValue<T> | undefined;
  }

  async destroy(): Promise<void> {
    this.storage.clear();
  }

  getReplica(): string | undefined {
    return "memory";
  }
}
