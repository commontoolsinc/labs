/**
 * CellHandle - Represents a `Cell` in a runtime.
 */

import {
  type Cancel,
  isLegacyAlias,
  isSigilLink,
  type JSONSchema,
  LINK_V1_TAG,
  type URI,
} from "@commontools/runner/shared";
import { $conn, type RuntimeClient } from "./runtime-client.ts";
import { type CellRef, JSONValue, RequestType } from "./protocol/mod.ts";
import { DID } from "@commontools/identity";
import { isRecord } from "@commontools/utils/types";
import { InitializedRuntimeConnection } from "./client/connection.ts";
import { getLogger } from "@commontools/utils/logger";

// Logger for schema warnings - disabled by default.
// Enable via: globalThis.commontools.logger["cell-handle"].disabled = false
const logger = getLogger("cell-handle", { enabled: false });

export const $onCellUpdate = Symbol("$onCellUpdate");

/**
 * CellHandle provides a cell interface for cells living in a web worker.
 */
export class CellHandle<T = unknown> {
  #rt: RuntimeClient;
  #conn: InitializedRuntimeConnection;
  #ref: CellRef;
  #value: T | undefined;
  #callbacks = new Map<number, (value: Readonly<T>) => void>();
  #nextCallbackId = 0;
  #schemaWarned = false;

  constructor(worker: RuntimeClient, cellRef: CellRef, value?: T) {
    this.#rt = worker;
    this.#conn = worker[$conn]();
    this.#ref = cellRef;
    this.#value = value;
  }

  /**
   * Check if this cell has a schema defined. Warns if no schema is set.
   * Warning is disabled by default; enable via:
   * globalThis.commontools.logger["cell-handle"].disabled = false
   */
  #requireSchema(method: string): void {
    if (!this.#ref.schema && !this.#schemaWarned) {
      this.#schemaWarned = true;
      // Use callback for lazy evaluation - stack trace only generated if logging is enabled
      logger.warn(`no-schema-${method}`, () => {
        const stack = new Error().stack;
        return [
          `${method}() called without schema on cell ${this.#ref.id}:${
            this.#ref.path.join(".")
          }. ` +
          `Please bind a schema using asSchema() or pass a schema to the cell controller's bind() method.\n` +
          `Stack trace:\n${stack}`,
        ];
      });
    }
  }

  runtime(): RuntimeClient {
    return this.#rt;
  }

  ref(): CellRef {
    return this.#ref;
  }

  space(): DID {
    return this.#ref.space;
  }

  id(): string {
    const id = this.#ref.id;
    return (id && id.startsWith("of:")) ? id.substring(3) : id;
  }

  /**
   * Get the current cached value.
   */
  get(): Readonly<T> | undefined {
    this.#requireSchema("get");
    return this.#value !== undefined ? this.#value as Readonly<T> : undefined;
  }

  /**
   * Set the cell's value locally, as well as in the runtime.
   */
  async set(value: T): Promise<void> {
    this.#requireSchema("set");
    this.#value = value;

    for (const callback of this.#callbacks.values()) {
      try {
        callback(value as Readonly<T>);
      } catch (error) {
        console.error("[CellHandle] Callback error:", error);
      }
    }

    await this.#conn.request<RequestType.CellSet>({
      type: RequestType.CellSet,
      cell: this.ref(),
      value: CellHandle.serialize(value),
    }).catch((error) => {
      console.error("[CellHandle] Set failed:", error);
    });
  }

  async send(event: T): Promise<void> {
    await this.#conn.request<RequestType.CellSend>({
      type: RequestType.CellSend,
      cell: this.ref(),
      event: CellHandle.serialize(event),
    }).catch((error) => {
      console.error("[CellHandle] Send failed:", error);
    });
  }

  /**
   * Get a child cell at the specified key.
   * Returns a new CellHandle with an extended path.
   */
  key<K extends keyof T>(valueKey: K): CellHandle<T[K]> {
    const childRef = this._extendPath(String(valueKey));
    const child = new CellHandle<T[K]>(this.#rt, childRef);

    // If we have a cached value, pre-populate the child's cache
    if (this.#value != null) {
      const childValue = (this.#value as Record<string, unknown>)[
        String(valueKey)
      ];
      if (childValue !== undefined) {
        child.#value = childValue as T[K];
      }
    }

    return child;
  }

  push<U>(
    this: CellHandle<U[]>,
    ...values: T extends (infer U)[] ? U[] : never
  ): void {
    const current = this.#value as unknown as unknown[];
    if (!Array.isArray(current)) {
      throw new Error("push() can only be used on array cells");
    }
    this.set([...current, ...values] as unknown as U[]);
  }

  /**
   * Subscribe to cell value changes.
   * The callback is called immediately with the current value (even if undefined)
   * and whenever the value changes.
   * The callback's return value (if a Cancel function) is called before the next update.
   */
  subscribe(
    callback: (value: T | undefined) => Cancel | undefined | void,
  ): Cancel {
    this.#requireSchema("subscribe");
    const callbackId = this.#nextCallbackId++;
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

    this.#callbacks.set(callbackId, wrappedCallback);
    this.#conn.subscribe(this);

    // Always call callback immediately with current value
    // This matches Cell behavior - callback is always called, even if value is undefined
    wrappedCallback(this.#value);

    return () => {
      if (typeof cleanup === "function") {
        try {
          cleanup();
        } catch (error) {
          console.error("[CellHandle] Cleanup error:", error);
        }
      }
      this.#callbacks.delete(callbackId);
      if (this.#callbacks.size === 0) {
        this.#conn.unsubscribe(this);
      }
    };
  }

  /**
   * Fetch the current value from the worker.
   * If the value is itself a link, follows it to get the actual value.
   */
  async sync(): Promise<Readonly<T> | undefined> {
    const response = await this.#conn.request<
      RequestType.CellGet
    >({
      type: RequestType.CellGet,
      cell: this.ref(),
    });

    this.#value = CellHandle.deserialize<T>(this, response.value) as T;
    return this.#value;
  }

  /**
   * Resolve links in this cell to get the actual cell it points to.
   * Returns a new CellHandle pointing to the resolved cell.
   */
  async resolveAsCell(): Promise<CellHandle<T>> {
    const response = await this.#conn.request<
      RequestType.CellResolveAsCell
    >({
      type: RequestType.CellResolveAsCell,
      cell: this.ref(),
    });

    return new CellHandle<T>(this.#rt, response.cell);
  }

  equals(other: unknown): boolean {
    if (this === other) return true;
    if (!isCellHandle(other)) return false;
    return cellRefsEqual(this.ref(), other.ref());
  }

  /**
   * Create a new CellHandle with a different schema.
   */
  asSchema<U = unknown>(schema: JSONSchema): CellHandle<U> {
    const { schema: _schema, rootSchema: _rootSchema, ...rest } = this.#ref;
    const newCell = new CellHandle(this.#rt, {
      ...rest,
      schema,
    });
    newCell.#value = this.#value;
    return newCell as CellHandle<U>;
  }

  private _extendPath(key: string): CellRef {
    return {
      id: this.#ref.id,
      space: this.#ref.space,
      path: [...this.#ref.path, key],
      type: this.#ref.type,
      // Child schema is unknown, so we don't include it
    };
  }

  toJSON(): CellRef {
    return { ...this.ref() };
  }

  // Called when cell has been updated from the backend with
  // a raw value that may contain CellRefs.
  [$onCellUpdate](value: unknown): void {
    const instanceId = (this as any).__debugId ?? "no-id";
    const applied = applyValue(
      value,
      this.#value,
      this as CellHandle<unknown>,
    ) as T;
    const isEqual = valuesEqual(applied, this.#value);
    console.log("[DEBUG CellHandle.$onCellUpdate]", {
      instanceId,
      path: this.#ref.path,
      incomingValue: value,
      appliedValue: applied,
      previousValue: this.#value,
      isEqual,
      callbackCount: this.#callbacks.size,
    });
    if (isEqual) {
      return;
    }

    this.#value = applied;
    for (const callback of this.#callbacks.values()) {
      console.log(
        "[DEBUG CellHandle.$onCellUpdate] firing callback for instance:",
        instanceId,
      );
      callback(this.#value);
    }
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
      return value.map((item) => CellHandle.deserialize(base, item));
    }

    if (isRecord(value)) {
      const reference = parseAsCellRef(
        value as JSONValue | undefined,
        base.ref(),
      );
      if (reference) {
        return new CellHandle(base.#rt, reference);
      }

      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        result[key] = CellHandle.deserialize(base, val);
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
 * Applies `current` to `previous`, returning the result.
 * Notably, this preserves `CellHandle` instances when encountering
 * a `CellRef` referencing the same `CellHandle`.
 */
function applyValue(
  current: unknown,
  previous: unknown,
  base: CellHandle,
): unknown {
  const cellRef = parseAsCellRef(current as JSONValue, base.ref());

  if (cellRef) {
    if (isCellHandle(previous) && cellRefsEqual(cellRef, previous.ref())) {
      return previous;
    }
    return new CellHandle(base.runtime(), cellRef);
  }

  // Currently, `current` will not contain `CellHandle`s,
  // but for completeness.
  if (isCellHandle(current)) {
    if (isCellHandle(previous) && current.equals(previous)) {
      return previous;
    }
    return current;
  }

  // For arrays, recursively apply to each element
  if (Array.isArray(current)) {
    const prevArray = Array.isArray(previous) ? previous : [];
    return current.map((item, index) =>
      applyValue(item, prevArray[index], base)
    );
  }

  // For plain objects, recursively apply to each property
  if (isRecord(current)) {
    const prevRecord = (isRecord(previous) && !Array.isArray(previous))
      ? previous as Record<string, unknown>
      : {};
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(current)) {
      result[key] = applyValue(val, prevRecord[key], base);
    }
    return result;
  }

  // For primitives, just return current
  return current;
}

function cellRefsEqual(a: CellRef, b: CellRef): boolean {
  if (a.id !== b.id) return false;
  if (a.space !== b.space) return false;
  if (a.path.length !== b.path.length) return false;
  for (let i = 0; i < a.path.length; i++) {
    if (a.path[i] !== b.path[i]) return false;
  }
  return true;
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

    return {
      id: linkData.id ?? from.id,
      space: linkData.space ?? from.space,
      path: (linkData.path ?? []).map((p) => p.toString()),
      type: "application/json",
      ...(linkData.schema !== undefined && { schema: linkData.schema }),
      ...(linkData.rootSchema !== undefined &&
        { rootSchema: linkData.rootSchema }),
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
      ...(alias.rootSchema !== undefined && { rootSchema: alias.rootSchema }),
    };
  }
}
