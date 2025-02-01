// redis-storage-provider.ts
import type { EntityId } from "@commontools/runner";
import { log } from "./storage.js";
import type { StorageValue, StorageProvider } from "./storage-providers.js";
import { BaseStorageProvider } from "./storage-providers.js";

/**
 * RedisStorageProvider implements StorageProvider by opening a WebSocket
 * connection to a backend (written in Deno) that uses Redis pub/sub.
 */
export class RedisStorageProvider extends BaseStorageProvider implements StorageProvider {
  // Maintain a local cache of JSON-stringified StorageValue for each entity key.
  private lastValues = new Map<string, string>();

  // Create a WebSocket connection to the backend.
  private socket: WebSocket;

  constructor(url: string = "ws://localhost:8080") {
    super();
    this.socket = new WebSocket(url);

    this.socket.addEventListener("open", () => {
      log("RedisStorageProvider connected to", url);
    });

    this.socket.addEventListener("message", this.handleMessage.bind(this));

    this.socket.addEventListener("error", (error) => {
      console.error("RedisStorageProvider websocket error:", error);
    });

    this.socket.addEventListener("close", () => {
      log("RedisStorageProvider websocket closed");
    });
  }

  /**
   * Handle incoming messages from the backend.
   *
   * Expected message formats:
   *
   * 1. Update message:
   *    {
   *      type: "update",
   *      entityId: { ... },  // original entity id object
   *      value: { value: any, source?: EntityId }
   *    }
   *
   * 2. Sync response:
   *    {
   *      type: "syncResponse",
   *      entityId: { ... },
   *      value: { value: any, source?: EntityId }
   *    }
   */
  private handleMessage(event: MessageEvent) {
    try {
      const data = JSON.parse(event.data);
      // Normalize the key by JSON-stringifying the entity ID.
      const key = JSON.stringify(data.entityId);

      if (data.type === "update" || data.type === "syncResponse") {
        const value: StorageValue = data.value;
        const valueString = JSON.stringify(value);
        if (this.lastValues.get(key) !== valueString) {
          this.lastValues.set(key, valueString);
          log("RedisStorageProvider received update", key, valueString);
          this.notifySubscribers(key, value);
        }
        // Always resolve waiting sync promises, even if value is undefined.
        this.resolveWaitingForSync(key);
      } else {
        log("RedisStorageProvider received unknown message type", data);
      }
    } catch (e) {
      console.error("Error processing message in RedisStorageProvider:", e);
    }
  }

  /**
   * Send a batch of updates to the backend.
   *
   * For each update, if the locally cached version is different from the new
   * one then update the cache and send a "send" message.
   */
  async send<T = any>(batch: { entityId: EntityId; value: StorageValue<T> }[]): Promise<void> {
    for (const { entityId, value } of batch) {
      const key = JSON.stringify(entityId);
      const valueString = JSON.stringify(value);

      if (this.lastValues.get(key) !== valueString) {
        this.lastValues.set(key, valueString);
        const message = {
          type: "send",
          entityId,
          value,
        };
        this.sendMessage(message);
        log("RedisStorageProvider sent update", key, valueString);
      }
    }
  }

  /**
   * Request a sync for the given entity from the backend.
   *
   * This sends a "sync" message and then waits for the backend to reply with
   * the current state (via a "syncResponse" or "update" message).
   */
  async sync(entityId: EntityId, expectedInStorage: boolean = false): Promise<void> {
    const key = JSON.stringify(entityId);
    const message = {
      type: "sync",
      entityId,
    };
    this.sendMessage(message);
    log("RedisStorageProvider sent sync request for", key);
    return this.waitForSync(key);
  }

  /**
   * Return the locally cached value for the given entity.
   */
  get<T = any>(entityId: EntityId): StorageValue<T> | undefined {
    const key = JSON.stringify(entityId);
    const valueString = this.lastValues.get(key);
    if (valueString) {
      return JSON.parse(valueString) as StorageValue<T>;
    }
    return undefined;
  }

  /**
   * Close the WebSocket connection and clear all local caches and subscribers.
   */
  async destroy(): Promise<void> {
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    ) {
      this.socket.close();
    }
    this.lastValues.clear();
    this.subscribers.clear();
    // Clear any pending sync promises.
    this.waitingForSync.clear();
    this.waitingForSyncResolvers.clear();
    log("RedisStorageProvider destroyed");
  }

  /**
   * Helper to send a message over the WebSocket.
   *
   * If the socket is not yet open, wait until it is.
   */
  private sendMessage(message: any) {
    const messageString = JSON.stringify(message);
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(messageString);
    } else {
      this.socket.addEventListener(
        "open",
        () => {
          this.socket.send(messageString);
        },
        { once: true },
      );
    }
  }
}
