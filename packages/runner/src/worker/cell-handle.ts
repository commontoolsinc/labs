/**
 * RemoteCell - Main thread proxy for cells living in the worker
 *
 * This class provides a cell-like interface that delegates all operations
 * to the worker via IPC. It implements enough of the Cell interface to work
 * with the rendering system.
 */

import type { Cancel } from "../cancel.ts";
import type { JSONSchema } from "../builder/types.ts";
import {
  LINK_V1_TAG,
  type SigilLink,
  type SigilWriteRedirectLink,
} from "../sigil-types.ts";
import {
  isLegacyAlias,
  isSigilLink,
  type NormalizedFullLink,
} from "../link-utils.ts";
import type { RuntimeWorker } from "./runtime-worker.ts";
import {
  type CellGetResponse,
  type CellRef,
  RuntimeWorkerMessageType,
} from "./ipc-protocol.ts";

/**
 * Symbol used to identify cell-like objects for duck typing.
 * This allows RemoteCell to be recognized by isCellLike().
 */
export const CELL_MARKER = Symbol.for("common:cell");

/**
 * RemoteCell provides a cell interface for cells living in a web worker.
 *
 * Key behaviors:
 * - get() returns cached value or throws if not synced
 * - sync() fetches fresh value from worker
 * - sink() subscribes to value changes via worker
 * - set() sends new value to worker (optimistic update)
 * - key() returns a new RemoteCell for the child path
 */
export class RemoteCell<T = unknown> {
  private _worker: RuntimeWorker;
  private _cellRef: CellRef;
  private _cachedValue: T | undefined;
  private _hasValue = false;
  private _subscriptionId: string | undefined;
  private _callbacks = new Map<number, (value: Readonly<T>) => void>();
  private _nextCallbackId = 0;

  /**
   * Marker for duck-type cell detection
   */
  readonly [CELL_MARKER] = true;

  constructor(worker: RuntimeWorker, cellRef: CellRef) {
    this._worker = worker;
    this._cellRef = cellRef;
  }

  runtime(): RuntimeWorker {
    return this._worker;
  }

  /**
   * Get the entity ID from the cell's link.
   */
  id(): string {
    const link = this._cellRef.link["/"][LINK_V1_TAG].id!;
    if (!link) throw new Error("No entity ID found for cell.");
    return (link && link.startsWith("of:")) ? link.substring(3) : link;
  }

  // ============================================================================
  // IReadable implementation
  // ============================================================================

  /**
   * Get the current cached value.
   * Throws if the value hasn't been loaded yet. Call sync() first.
   * Rehydrates any SigilLinks in the value back into RemoteCell instances.
   */
  get(): Readonly<T> {
    if (!this._hasValue) {
      throw new Error(
        "Cell value not loaded. Call sync() first or use sink() for reactive access.",
      );
    }
    return this._rehydrateLinks(this._cachedValue) as Readonly<T>;
  }

  /**
   * Sample is the same as get for RemoteCell (no reactive context tracking).
   */
  sample(): Readonly<T> {
    return this.get();
  }

  // ============================================================================
  // IWritable implementation
  // ============================================================================

  /**
   * Set the cell's value.
   * Sends the value to the worker and optimistically updates the cache.
   */
  set(value: T): this {
    // Optimistically update cache
    this._cachedValue = value;
    this._hasValue = true;

    // Notify local subscribers immediately (optimistic)
    for (const callback of this._callbacks.values()) {
      try {
        callback(value as Readonly<T>);
      } catch (error) {
        console.error("[RemoteCell] Callback error:", error);
      }
    }

    // Send to worker (fire and forget)
    this._worker
      .sendRequest({
        type: RuntimeWorkerMessageType.CellSet,
        cellRef: this._cellRef,
        value: value as any,
      })
      .catch((error) => {
        console.error("[RemoteCell] Set failed:", error);
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
  push(...values: T extends (infer U)[] ? U[] : never): void {
    if (!this._hasValue) {
      throw new Error("Cell value not loaded. Call sync() first.");
    }
    const current = this._cachedValue as unknown as unknown[];
    if (!Array.isArray(current)) {
      throw new Error("push() can only be used on array cells");
    }
    this.set([...current, ...values] as unknown as T);
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
        type: RuntimeWorkerMessageType.CellSend,
        cellRef: this._cellRef,
        event: event as any,
      })
      .catch((error) => {
        console.error("[RemoteCell] Send failed:", error);
      });
  }

  // ============================================================================
  // IKeyable implementation
  // ============================================================================

  /**
   * Get a child cell at the specified key.
   * Returns a new RemoteCell with an extended path.
   */
  key<K extends keyof T>(valueKey: K): RemoteCell<T[K]> {
    const childRef = this._extendPath(String(valueKey));
    const child = new RemoteCell<T[K]>(this._worker, childRef);

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
   * Values are rehydrated to convert SigilLinks back to RemoteCell instances.
   * The callback's return value (if a Cancel function) is called before the next update.
   */
  sink(callback: (value: Readonly<T>) => Cancel | undefined | void): Cancel {
    const callbackId = this._nextCallbackId++;

    // Track cleanup function returned by callback
    let cleanup: Cancel | undefined | void;

    // Wrapper that handles cleanup before invoking callback
    const wrappedCallback = (value: Readonly<T>) => {
      if (typeof cleanup === "function") {
        try {
          cleanup();
        } catch (error) {
          console.error("[RemoteCell] Cleanup error:", error);
        }
      }
      cleanup = undefined;
      try {
        cleanup = callback(value);
      } catch (error) {
        console.error("[RemoteCell] Callback error:", error);
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
          console.error("[RemoteCell] Cleanup error:", error);
        }
      }
      this._callbacks.delete(callbackId);
      if (this._callbacks.size === 0) {
        this._unsubscribe();
      }
    };
  }

  private _ensureSubscription(): void {
    if (this._subscriptionId) return;

    this._subscriptionId = crypto.randomUUID();

    this._worker.subscribe(
      this._subscriptionId,
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
   * Returns this cell for chaining.
   */
  async sync(): Promise<this> {
    const response = await this._worker.sendRequest<CellGetResponse>({
      type: RuntimeWorkerMessageType.CellSync,
      cellRef: this._cellRef,
    });

    let value = response.value;

    // If the response value is a link, resolve it by syncing that cell.
    // This follows the same semantics as regular Cell.get() which
    // dereferences nested cell references automatically.
    // Track visited links to prevent infinite loops.
    const visited = new Set<string>();
    while (isSigilLink(value)) {
      const linkKey = JSON.stringify(value);
      if (visited.has(linkKey)) {
        // Circular reference - stop resolving
        break;
      }
      visited.add(linkKey);

      // Create a cell for this link and sync it
      const linkedCellRef: CellRef = {
        link: value,
        schema: this._cellRef.schema,
      };
      const linkedResponse = await this._worker.sendRequest<CellGetResponse>({
        type: RuntimeWorkerMessageType.CellSync,
        cellRef: linkedCellRef,
      });
      value = linkedResponse.value;
    }

    this._cachedValue = value as T;
    this._hasValue = true;

    return this;
  }

  // ============================================================================
  // Link serialization
  // ============================================================================

  /**
   * Get the cell's reference as a SigilLink.
   */
  getAsLink(): SigilLink {
    return this._cellRef.link;
  }

  /**
   * Get the cell's reference as a NormalizedFullLink.
   */
  getAsNormalizedFullLink(): NormalizedFullLink {
    const linkData = this._cellRef.link["/"][LINK_V1_TAG];
    return {
      id: linkData.id!,
      space: linkData.space!,
      path: (linkData.path ?? []).map((p) => p.toString()),
      type: "application/json",
      ...(linkData.schema !== undefined && { schema: linkData.schema }),
    };
  }

  /**
   * Get the cell's reference as a write redirect link.
   */
  getAsWriteRedirectLink(): SigilWriteRedirectLink {
    const linkData = this._cellRef.link["/"][LINK_V1_TAG];
    return {
      "/": {
        [LINK_V1_TAG]: {
          ...linkData,
          overwrite: "redirect" as const,
        },
      },
    };
  }

  // ============================================================================
  // Additional methods for compatibility
  // ============================================================================

  /**
   * Compare this cell with another value for equality.
   * Used for cycle detection in rendering.
   */
  equals(other: unknown): boolean {
    if (this === other) return true;
    if (!other) return false;

    // Compare with another RemoteCell
    if (isRemoteCell(other)) {
      return this._areCellRefsSame(this._cellRef, other._cellRef);
    }

    // Compare with objects that have getAsLink
    if (
      typeof other === "object" &&
      "getAsLink" in other &&
      typeof (other as any).getAsLink === "function"
    ) {
      const otherLink = (other as any).getAsLink();
      return this._areLinksSame(this._cellRef.link, otherLink);
    }

    return false;
  }

  /**
   * Compare two CellRefs for equality.
   */
  private _areCellRefsSame(ref1: CellRef, ref2: CellRef): boolean {
    return this._areLinksSame(ref1.link, ref2.link);
  }

  /**
   * Compare two SigilLinks for equality.
   */
  private _areLinksSame(link1: SigilLink, link2: SigilLink): boolean {
    const data1 = link1["/"][LINK_V1_TAG];
    const data2 = link2["/"][LINK_V1_TAG];

    if (data1.id !== data2.id) return false;
    if (data1.space !== data2.space) return false;

    const path1 = data1.path ?? [];
    const path2 = data2.path ?? [];
    if (path1.length !== path2.length) return false;
    for (let i = 0; i < path1.length; i++) {
      if (path1[i] !== path2[i]) return false;
    }

    return true;
  }

  /**
   * Create a new RemoteCell with a different schema.
   */
  asSchema<S extends JSONSchema>(schema: S): RemoteCell<unknown> {
    const newCell = new RemoteCell(this._worker, {
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

  /**
   * Get the cell reference.
   */
  getCellRef(): CellRef {
    return this._cellRef;
  }

  // ============================================================================
  // Private helpers
  // ============================================================================

  private _extendPath(key: string): CellRef {
    const currentLink = this._cellRef.link["/"][LINK_V1_TAG];
    const currentPath = currentLink.path ?? [];

    return {
      link: {
        "/": {
          [LINK_V1_TAG]: {
            ...currentLink,
            path: [...currentPath, key],
          },
        },
      },
      schema: undefined, // Child schema is unknown
    };
  }

  /**
   * Recursively walk a value tree and replace SigilLinks and LegacyAliases
   * with RemoteCell instances. This rehydrates serialized cell references back
   * into cell-like objects that can be used with the rendering system.
   */
  private _rehydrateLinks(value: unknown): unknown {
    // Base case: SigilLink -> RemoteCell
    if (isSigilLink(value)) {
      const cellRef: CellRef = { link: value, schema: undefined };
      return new RemoteCell(this._worker, cellRef);
    }

    // Base case: LegacyAlias -> RemoteCell
    // LegacyAlias has path relative to the root cell's entity
    if (isLegacyAlias(value)) {
      const alias = value.$alias;
      const aliasPath = alias.path.map((p) => String(p));

      // Get the root entity's ID and space from this cell's link
      const rootLinkData = this._cellRef.link["/"][LINK_V1_TAG];

      // Create a new cell reference with the alias path
      // The alias path is always from the root entity, not relative to current path
      const cellRef: CellRef = {
        link: {
          "/": {
            [LINK_V1_TAG]: {
              id: rootLinkData.id,
              space: rootLinkData.space,
              path: aliasPath,
              ...(alias.schema !== undefined && { schema: alias.schema }),
            },
          },
        },
        schema: alias.schema,
      };
      return new RemoteCell(this._worker, cellRef);
    }

    // Arrays: map each element
    if (Array.isArray(value)) {
      return value.map((item) => this._rehydrateLinks(item));
    }

    // Objects: recursively process properties, preserving special VNode structure
    if (value !== null && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        result[key] = this._rehydrateLinks(val);
      }
      // Preserve any symbol properties (like [UI])
      const symbolKeys = Object.getOwnPropertySymbols(value);
      for (const sym of symbolKeys) {
        result[sym as unknown as string] = this._rehydrateLinks(
          (value as Record<symbol, unknown>)[sym],
        );
      }
      return result;
    }

    // Primitives pass through unchanged
    return value;
  }
}

/**
 * Check if a value is a RemoteCell.
 */
export function isRemoteCell(value: unknown): value is RemoteCell {
  return (
    value != null &&
    typeof value === "object" &&
    CELL_MARKER in value &&
    (value as Record<symbol, boolean>)[CELL_MARKER] === true
  );
}
