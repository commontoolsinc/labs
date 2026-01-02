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
  type URI,
} from "@commontools/runner/shared";
import type { RuntimeClient } from "./client.ts";
import {
  type CellGetResponse,
  type CellRef,
  JSONValue,
  RuntimeClientMessageType,
} from "./ipc.ts";
import { DID } from "@commontools/identity";
import { isRecord } from "@commontools/utils/types";

export interface SyncedCellHandle<T> extends CellHandle<T> {
}

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
  private _rt: RuntimeClient;
  private _cellRef: CellRef;
  private _cachedValue: T | undefined;
  private _hasValue = false;
  private _subscriptionId: string | undefined;
  private _callbacks = new Map<number, (value: Readonly<T>) => void>();
  private _nextCallbackId = 0;

  constructor(worker: RuntimeClient, cellRef: CellRef, value?: T) {
    this._rt = worker;
    this._cellRef = cellRef;
    if (value !== undefined) {
      this._cachedValue = value;
      this._hasValue = true;
    }
  }

  runtime(): RuntimeClient {
    return this._rt;
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
   * Throws if the value is undefined, because this has not yet been `sync()`ed,
   * or if the property is not set on the schema. This helps properly reflect `T`.
   *
   * Use `getMaybe()` to handle `undefined` scenarios.
   */
  get(): Readonly<T> {
    if (this._cachedValue === undefined) {
      throw new Error(
        "Cell value is not available. May need to sync the cell, or cell may not reference not loaded. Call sync() first or use sink() for reactive access.",
      );
    }
    return this._cachedValue as Readonly<T>;
  }

  // Get the current cached value or undefined if not yet synced.
  getMaybe(): Readonly<T> | undefined {
    if (!this._hasValue) {
      return undefined;
    }
    return this.get();
  }

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

    this._rt
      .sendRequest({
        type: RuntimeClientMessageType.CellSet,
        cellRef: this._cellRef,
        value: CellHandle.serialize(value),
      })
      .catch((error) => {
        console.error("[CellHandle] Set failed:", error);
      });

    return this;
  }

  send(event: T): void {
    this._rt
      .sendRequest({
        type: RuntimeClientMessageType.CellSend,
        cellRef: this._cellRef,
        event: CellHandle.serialize(event),
      })
      .catch((error) => {
        console.error("[CellHandle] Send failed:", error);
      });
  }

  /**
   * Get a child cell at the specified key.
   * Returns a new CellHandle with an extended path.
   */
  key<K extends keyof T>(valueKey: K): CellHandle<T[K]> {
    const childRef = this._extendPath(String(valueKey));
    const child = new CellHandle<T[K]>(this._rt, childRef);

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

  /**
   * Subscribe to cell value changes.
   * The callback is called immediately with the current value (even if undefined),
   * and then whenever the value changes.
   * Values are rehydrated to convert SigilLinks back to CellHandle instances.
   * The callback's return value (if a Cancel function) is called before the next update.
   */
  subscribe(
    callback: (value: T | undefined) => Cancel | undefined | void,
  ): Cancel {
    const callbackId = this._nextCallbackId++;
    let cleanup: Cancel | undefined | void;

    const wrappedCallback = (value: T | undefined) => {
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

    // Always call callback immediately with current value
    // This matches Cell behavior - callback is always called, even if value is undefined
    wrappedCallback(this._cachedValue);

    return () => {
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

  private _ensureSubscription(): void {
    if (this._subscriptionId) return;

    this._subscriptionId = this._rt.subscribe(
      this._cellRef,
      (value: unknown) => {
        const rehydrated = CellHandle.deserialize(this, value) as Readonly<T>;
        // Skip if value hasn't changed
        if (this._hasValue && valuesEqual(rehydrated, this._cachedValue)) {
          return;
        }
        this._cachedValue = rehydrated as T;
        this._hasValue = true;
        for (const callback of this._callbacks.values()) {
          callback(rehydrated);
        }
      },
      this._hasValue,
    );
  }

  private _unsubscribe(): void {
    if (!this._subscriptionId) return;

    this._rt.unsubscribe(this._subscriptionId);
    this._subscriptionId = undefined;
  }

  /**
   * Fetch the current value from the worker.
   * If the value is itself a link, follows it to get the actual value.
   */
  async sync(): Promise<this> {
    let value;
    let depth = 5;
    const visited = new Set<string>();

    let cellRef = this._cellRef;
    while (!value && depth-- > 0) {
      if (visited.has(cellRef.id)) {
        break;
      }
      visited.add(cellRef.id);
      const response = await this._rt.sendRequest<CellGetResponse>({
        type: RuntimeClientMessageType.CellSync,
        cellRef,
      });

      const reference = parseAsCellRef(response.value, this.ref());
      if (!reference) {
        value = response.value;
        break;
      }
      cellRef = reference;
    }

    this._cachedValue = CellHandle.deserialize<T>(this, value) as T;
    this._hasValue = true;

    return this;
  }

  async deepSync(_maxDepth: number = 10): Promise<this> {
    await this.sync();
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
    const newCell = new CellHandle(this._rt, {
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

  private _extendPath(key: string): CellRef {
    return {
      id: this._cellRef.id,
      space: this._cellRef.space,
      path: [...this._cellRef.path, key],
      type: this._cellRef.type,
      // Child schema is unknown, so we don't include it
    };
  }

  toJSON(): CellRef {
    return { ...this.ref() };
  }

  /**
   * Recursively hydrate any object, converting any links (SigilLink,
   * LegacyAlias) into CellHandle instances.
   */
  static deserialize<T>(
    base: CellHandle<T>,
    value: unknown,
  ): unknown {
    if (
      !value && typeof value === "string" || typeof value === "boolean" ||
      typeof value === "number"
    ) {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.deserialize(base, item));
    }

    if (isRecord(value)) {
      const reference = parseAsCellRef(
        value as JSONValue | undefined,
        base.ref(),
      );
      if (reference) {
        return new CellHandle(base._rt, reference);
      }

      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        result[key] = this.deserialize(base, val);
      }
      return result;
    }

    return value;
  }

  /**
   * Recursively converts any CellHandle references in the object into CellRefs.
   * This is a CellHandle compatible form of `convertCellsToLinks`.
   */
  static serialize(
    value: readonly any[] | Record<string, any> | any,
  ): any {
    if (isCellHandle(value)) {
      value = value.ref();
    } else if (isRecord(value)) {
      if (Array.isArray(value)) {
        value = value.map((value) => CellHandle.serialize(value));
      } else {
        value = Object.fromEntries(
          Object.entries(value).map(([key, value]) => [
            key,
            CellHandle.serialize(value),
          ]),
        );
      }
    } else if (
      !(typeof value === "string" || typeof value === "number" ||
        typeof value === "boolean" || value === undefined || value === null)
    ) {
      throw new Error(`Unknown type: ${value}`);
    }

    return value;
  }
}

export function isCellHandle<T = unknown>(
  value: unknown,
): value is CellHandle<T> {
  return value instanceof CellHandle;
}

/**
 * Deep equality check for cell values.
 * Handles primitives, arrays, objects, and CellHandles.
 */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (isCellHandle(a) && isCellHandle(b)) {
    return a.equals(b);
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!valuesEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;

  const aKeys = Object.keys(a as object);
  const bKeys = Object.keys(b as object);
  if (aKeys.length !== bKeys.length) return false;

  for (const key of aKeys) {
    if (!(key in (b as object))) return false;
    if (
      !valuesEqual(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      )
    ) {
      return false;
    }
  }

  return true;
}

function parseAsCellRef(
  value: JSONValue | undefined,
  from: CellRef,
): CellRef | undefined {
  if (isSigilLink(value)) {
    const linkData = value["/"][LINK_V1_TAG];
    if (!linkData.id) {
      console.warn("Missing id in link.");
      return;
    }

    return {
      id: linkData.id,
      space: linkData.space ?? from.space,
      path: (linkData.path ?? []).map((p) => p.toString()),
      type: "application/json",
      ...(linkData.schema !== undefined && { schema: linkData.schema }),
    };
  } else if (isLegacyAlias(value)) {
    const alias = value.$alias;
    const aliasPath = alias.path.map((p) => String(p));

    let entityId: URI;
    if (alias.cell && typeof alias.cell === "object" && "/" in alias.cell) {
      const rawId = (alias.cell as { "/": string })["/"];
      entityId = (rawId.startsWith("of:") ? rawId : `of:${rawId}`) as URI;
    } else {
      entityId = from.id;
    }

    return {
      id: entityId,
      space: from.space,
      path: aliasPath,
      type: "application/json",
      ...(alias.schema !== undefined && { schema: alias.schema }),
    };
  }
}
