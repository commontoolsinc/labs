/**
 * CellHandle - Main thread proxy for cells living in the worker
 *
 * This class provides a cell-like interface that delegates all operations
 * to the worker via IPC. It implements enough of the Cell interface to work
 * with the rendering system.
 */

import {
  type Cancel,
  isLegacyAlias,
  isSigilLink,
  type JSONSchema,
  LINK_V1_TAG,
  Subscribe,
  SubscriptionCallback,
  type URI,
} from "@commontools/runner/shared";
import type { RuntimeClient } from "./client.ts";
import {
  type CellGetResponse,
  type CellRef,
  RuntimeClientMessageType,
} from "./ipc.ts";
import { DID } from "@commontools/identity";

/**
 * CellHandle provides a cell interface for cells living in a web worker.
 *
 * Key behaviors:
 * - get() returns cached value or throws if not synced
 * - sync() fetches fresh value from worker
 * - sink() subscribes to value changes via worker
 * - set() sends new value to worker (optimistic update)
 * - key() returns a new CellHandle for the child path
 */
export class CellHandle<T = unknown> {
  private _worker: RuntimeClient;
  private _cellRef: CellRef;
  private _cachedValue: T | undefined;
  private _hasValue = false;
  private _subscriptionId: string | undefined;
  private _callbacks = new Map<number, (value: Readonly<T>) => void>();
  private _nextCallbackId = 0;

  constructor(worker: RuntimeClient, cellRef: CellRef, value?: T) {
    this._worker = worker;
    this._cellRef = cellRef;
    if (value !== undefined) {
      this._cachedValue = value;
      this._hasValue = true;
    }
  }

  runtime(): RuntimeClient {
    return this._worker;
  }

  ref(): CellRef {
    return this._cellRef;
  }

  space(): DID {
    return this._cellRef.space;
  }

  id(): string {
    const id = this._cellRef.id;
    return (id && id.startsWith("of:")) ? id.substring(3) : id;
  }

  // ============================================================================
  // IReadable implementation
  // ============================================================================

  /**
   * Get the current cached value.
   * Throws if the value hasn't been loaded yet. Call sync() first.
   * Rehydrates any SigilLinks in the value back into CellHandle instances.
   */
  get(): Readonly<T> {
    if (!this._hasValue) {
      throw new Error(
        "Cell value not loaded. Call sync() first or use sink() for reactive access.",
      );
    }
    return this._rehydrateLinks(this._cachedValue) as Readonly<T>;
  }

  // ============================================================================
  // IWritable implementation
  // ============================================================================

  /**
   * Set the cell's value.
   * Sends the value to the worker and optimistically updates the cache.
   */
  set(value: T): this {
    this._cachedValue = value;
    this._hasValue = true;

    for (const callback of this._callbacks.values()) {
      try {
        callback(value as Readonly<T>);
      } catch (error) {
        console.error("[CellHandle] Callback error:", error);
      }
    }

    this._worker
      .sendRequest({
        type: RuntimeClientMessageType.CellSet,
        cellRef: this._cellRef,
        value: value as any,
      })
      .catch((error) => {
        console.error("[CellHandle] Set failed:", error);
      });

    return this;
  }

  /**
   * Update the cell with partial values (merge).
   */
  update(values: Partial<T>): this {
    const current = this._hasValue ? this._cachedValue : ({} as T);
    const merged = { ...current, ...values } as T;
    return this.set(merged);
  }

  /**
   * Push values to an array cell.
   */
  push<U>(
    this: CellHandle<U[]>,
    ...values: T extends (infer U)[] ? U[] : never
  ): void {
    if (!this._hasValue) {
      throw new Error("Cell value not loaded. Call sync() first.");
    }
    const current = this._cachedValue as unknown as unknown[];
    if (!Array.isArray(current)) {
      throw new Error("push() can only be used on array cells");
    }
    this.set([...current, ...values] as unknown as U[]);
  }

  // ============================================================================
  // IStreamable implementation
  // ============================================================================

  /**
   * Send an event to a stream cell.
   */
  send(event: T): void {
    this._worker
      .sendRequest({
        type: RuntimeClientMessageType.CellSend,
        cellRef: this._cellRef,
        event: event as any,
      })
      .catch((error) => {
        console.error("[CellHandle] Send failed:", error);
      });
  }

  // ============================================================================
  // IKeyable implementation
  // ============================================================================

  /**
   * Get a child cell at the specified key.
   * Returns a new CellHandle with an extended path.
   */
  key<K extends keyof T>(valueKey: K): CellHandle<T[K]> {
    const childRef = this._extendPath(String(valueKey));
    const child = new CellHandle<T[K]>(this._worker, childRef);

    // If we have a cached value, pre-populate the child's cache
    if (this._hasValue && this._cachedValue != null) {
      const childValue = (this._cachedValue as Record<string, unknown>)[
        String(valueKey)
      ];
      if (childValue !== undefined) {
        child._cachedValue = childValue as T[K];
        child._hasValue = true;
      }
    }

    return child;
  }

  // ============================================================================
  // Subscription (sink) support
  // ============================================================================

  /**
   * Subscribe to cell value changes.
   * The callback is called immediately with the current value (even if undefined),
   * and then whenever the value changes.
   * Values are rehydrated to convert SigilLinks back to CellHandle instances.
   * The callback's return value (if a Cancel function) is called before the next update.
   */
  subscribe(
    callback: SubscriptionCallback<Readonly<T>>,
  ): Cancel {
    const callbackId = this._nextCallbackId++;

    // Track cleanup function returned by callback
    let cleanup: Cancel | undefined | void;

    // Wrapper that handles cleanup before invoking callback
    const wrappedCallback = (value: Readonly<T>) => {
      if (typeof cleanup === "function") {
        try {
          cleanup();
        } catch (error) {
          console.error("[CellHandle] Cleanup error:", error);
        }
      }
      cleanup = undefined;
      try {
        cleanup = callback(value);
      } catch (error) {
        console.error("[CellHandle] Callback error:", error);
      }
    };

    this._callbacks.set(callbackId, wrappedCallback);
    this._ensureSubscription();

    // Always call callback immediately with current value (rehydrated)
    // This matches Cell behavior - callback is always called, even if value is undefined
    const rehydrated = this._rehydrateLinks(this._cachedValue) as Readonly<T>;
    wrappedCallback(rehydrated);

    // Return cancel function
    return () => {
      // Clean up current render
      if (typeof cleanup === "function") {
        try {
          cleanup();
        } catch (error) {
          console.error("[CellHandle] Cleanup error:", error);
        }
      }
      this._callbacks.delete(callbackId);
      if (this._callbacks.size === 0) {
        this._unsubscribe();
      }
    };
  }

  [Subscribe](callback: SubscriptionCallback<T>): Cancel {
    return this.subscribe(callback);
  }

  private _ensureSubscription(): void {
    if (this._subscriptionId) return;

    this._subscriptionId = this._worker.subscribe(
      this._cellRef,
      (value: unknown) => {
        this._cachedValue = value as T;
        this._hasValue = true;

        // Rehydrate value and notify all callbacks
        const rehydrated = this._rehydrateLinks(value) as Readonly<T>;
        for (const callback of this._callbacks.values()) {
          callback(rehydrated);
        }
      },
      this._hasValue,
    );
  }

  private _unsubscribe(): void {
    if (!this._subscriptionId) return;

    this._worker.unsubscribe(this._subscriptionId);
    this._subscriptionId = undefined;
  }

  // ============================================================================
  // Sync support
  // ============================================================================

  /**
   * Fetch the current value from the worker.
   * If the value is itself a link, follows it to get the actual value.
   */
  async sync(): Promise<this> {
    const response = await this._worker.sendRequest<CellGetResponse>({
      type: RuntimeClientMessageType.CellSync,
      cellRef: this._cellRef,
    });

    let value = response.value;

    // If the response value is a link, resolve it by syncing that cell.
    // This follows the same semantics as regular Cell.get() which
    // dereferences nested cell references automatically.
    // Track visited links to prevent infinite loops.
    const visited = new Set<string>();
    while (isSigilLink(value)) {
      const linkData = value["/"][LINK_V1_TAG];
      if (!linkData.id) throw new Error("Missing id in link.");
      if (visited.has(linkData.id)) {
        // Circular reference - stop resolving
        break;
      }
      visited.add(linkData.id);

      const linkedCellRef: CellRef = {
        id: linkData.id ?? this._cellRef.id,
        space: linkData.space ?? this._cellRef.space,
        path: (linkData.path ?? []).map((p) => p.toString()),
        type: "application/json",
        ...(linkData.schema !== undefined && { schema: linkData.schema }),
      };
      const linkedResponse = await this._worker.sendRequest<CellGetResponse>({
        type: RuntimeClientMessageType.CellSync,
        cellRef: linkedCellRef,
      });
      value = linkedResponse.value;
    }

    this._cachedValue = value as T;
    this._hasValue = true;

    return this;
  }

  equals(other: unknown): boolean {
    if (this === other) return true;
    if (!isCellHandle(other)) return false;
    const link1 = this.ref();
    const link2 = other.ref();

    if (link1.id !== link2.id) return false;
    if (link1.space !== link2.space) return false;
    if (link1.path.length !== link2.path.length) return false;
    for (let i = 0; i < link1.path.length; i++) {
      if (link1.path[i] !== link2.path[i]) return false;
    }
    return true;
  }

  /**
   * Create a new CellHandle with a different schema.
   */
  asSchema<S extends JSONSchema>(schema: S): CellHandle<unknown> {
    const newCell = new CellHandle(this._worker, {
      ...this._cellRef,
      schema,
    });
    // Preserve cached value if we have one
    if (this._hasValue) {
      newCell._cachedValue = this._cachedValue;
      newCell._hasValue = true;
    }
    return newCell;
  }

  // ============================================================================
  // Private helpers
  // ============================================================================

  private _extendPath(key: string): CellRef {
    return {
      id: this._cellRef.id,
      space: this._cellRef.space,
      path: [...this._cellRef.path, key],
      type: this._cellRef.type,
      // Child schema is unknown, so we don't include it
    };
  }

  /**
   * Recursively walk a value tree and replace SigilLinks and LegacyAliases
   * with CellHandle instances. This rehydrates serialized cell references back
   * into cell-like objects that can be used with the rendering system.
   */
  private _rehydrateLinks(value: unknown, debugPath: string = "root"): unknown {
    // Base case: SigilLink -> CellHandle
    if (isSigilLink(value)) {
      // Extract schema from the SigilLink if present
      const linkData = value["/"][LINK_V1_TAG];

      // Ensure the link has a space - use the current cell's space if not present
      // This handles charm references that don't include the space (same-space refs)
      const cellRef: CellRef = {
        id: linkData.id ?? this._cellRef.id,
        space: linkData.space ?? this._cellRef.space,
        path: (linkData.path ?? []).map((p) => p.toString()),
        type: "application/json",
        ...(linkData.schema !== undefined && { schema: linkData.schema }),
      };
      return new CellHandle(this._worker, cellRef);
    }

    // Base case: LegacyAlias -> CellHandle
    // LegacyAlias has path relative to either:
    // 1. A specific cell (alias.cell is { "/": "entity-id" })
    // 2. The root cell's entity (alias.cell is undefined)
    if (isLegacyAlias(value)) {
      const alias = value.$alias;
      const aliasPath = alias.path.map((p) => String(p));

      // Determine the entity ID to use:
      // - If alias.cell exists, it's { "/": "entity-id" } format pointing to the process cell
      // - Otherwise, use the current cell's entity ID
      let entityId: URI;
      if (alias.cell && typeof alias.cell === "object" && "/" in alias.cell) {
        // alias.cell is { "/": "entity-id" } format - convert to URI format
        const rawId = (alias.cell as { "/": string })["/"];
        entityId = (rawId.startsWith("of:") ? rawId : `of:${rawId}`) as URI;
      } else {
        // Fall back to current cell's entity ID
        entityId = this._cellRef.id;
      }

      // Create a new cell reference with the alias path
      const cellRef: CellRef = {
        id: entityId,
        space: this._cellRef.space,
        path: aliasPath,
        type: "application/json",
        ...(alias.schema !== undefined && { schema: alias.schema }),
      };
      return new CellHandle(this._worker, cellRef);
    }

    // Arrays: map each element
    if (Array.isArray(value)) {
      return value.map((item, i) =>
        this._rehydrateLinks(item, `${debugPath}[${i}]`)
      );
    }

    // Objects: recursively process properties, preserving special VNode structure
    if (value !== null && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        result[key] = this._rehydrateLinks(val, `${debugPath}.${key}`);
      }
      return result;
    }

    // Primitives pass through unchanged
    return value;
  }

  toJSON(): CellRef {
    return { ...this.ref() };
  }
}

export function isCellHandle<T = unknown>(
  value: unknown,
): value is CellHandle<T> {
  return value instanceof CellHandle;
}
