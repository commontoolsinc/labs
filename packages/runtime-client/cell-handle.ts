/**
 * CellHandle - Represents a `Cell` in a runtime.
 */

import {
  type Cancel,
  isLegacyAlias,
  isSigilLink,
  type JSONSchema,
  linkRefFrom,
  linkRefPayload,
  linkRefPayloadToString,
  type SigilLink,
} from "@commonfabric/runner/shared";
import {
  cfcLabelViewsEqual,
  rebaseCfcLabelView,
} from "@commonfabric/runner/cfc/label-view-core";
import { type CfcCellLinkRefPayload } from "@commonfabric/runner/cfc";
import { $conn, type RuntimeClient } from "./runtime-client.ts";
import { isRuntimeDisposedError } from "./shared/disposed-error.ts";
import {
  type CellRef,
  type CfcLabelView,
  JSONValue,
  RequestType,
} from "./protocol/mod.ts";
import { DID } from "@commonfabric/identity";
import { isRecord } from "@commonfabric/utils/types";
import { InitializedRuntimeConnection } from "./client/connection.ts";
import { getLogger } from "@commonfabric/utils/logger";

// Logger for schema warnings - disabled by default.
// Enable via: globalThis.commonfabric.logger["cell-handle"].disabled = false
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
  #cfcLabel: CfcLabelView | undefined;
  // Whether any subscriber asked for the CFC label. Sticky: once a label-aware
  // subscription exists on this handle, label changes also fire its callbacks.
  #wantsCfcLabel = false;
  #callbacks = new Map<
    number,
    (value: Readonly<T>, cfcLabel: CfcLabelView | undefined) => void
  >();
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
   * globalThis.commonfabric.logger["cell-handle"].disabled = false
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
        // Optimistic local set doesn't change the label; carry the current one.
        callback(value as Readonly<T>, this.#cfcLabel);
      } catch (error) {
        console.error("[CellHandle] Callback error:", error);
      }
    }

    await this.#conn.request<RequestType.CellSet>({
      type: RequestType.CellSet,
      cell: this.ref(),
      value: CellHandle.serialize(value),
    }).catch((error) => {
      if (!isRuntimeDisposedError(error)) {
        console.error("[CellHandle] Set failed:", error);
      }
    });
  }

  async send(event: T): Promise<void> {
    await this.#conn.request<RequestType.CellSend>({
      type: RequestType.CellSend,
      cell: this.ref(),
      event: CellHandle.serialize(event),
    }).catch((error) => {
      if (!isRuntimeDisposedError(error)) {
        console.error("[CellHandle] Send failed:", error);
      }
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
  /** The cell's current display CFC label, for label-aware subscribers. */
  get cfcLabel(): CfcLabelView | undefined {
    return this.#cfcLabel;
  }

  /** Whether this handle subscribed asking for reactive CFC-label delivery. */
  get wantsCfcLabel(): boolean {
    return this.#wantsCfcLabel;
  }

  subscribe(
    callback: (
      value: T | undefined,
      cfcLabel?: CfcLabelView | undefined,
    ) => Cancel | undefined | void,
    options: { includeCfcLabel?: boolean } = {},
  ): Cancel {
    this.#requireSchema("subscribe");
    // If a label-aware subscription is added AFTER a value-only one already
    // opened the backend subscription, that backend sub carries no label and
    // the connection would dedup this one away. Re-establish it so it delivers
    // labels (the worker recreates its sink with includeCfcLabel). This works
    // when this handle is the sole subscriber of its ref; a value-only handle
    // sharing the exact same ref would keep the backend sub label-less.
    const upgradeToCfcLabel = options.includeCfcLabel === true &&
      !this.#wantsCfcLabel && this.#callbacks.size > 0;
    if (options.includeCfcLabel) {
      this.#wantsCfcLabel = true;
    }
    const callbackId = this.#nextCallbackId++;
    let cleanup: Cancel | undefined | void;

    const wrappedCallback = (
      value: T | undefined,
      cfcLabel: CfcLabelView | undefined,
    ) => {
      if (typeof cleanup === "function") {
        try {
          cleanup();
        } catch (error) {
          console.error("[CellHandle] Cleanup error:", error);
        }
      }
      cleanup = undefined;
      try {
        cleanup = callback(value, cfcLabel);
      } catch (error) {
        console.error("[CellHandle] Callback error:", error);
      }
    };

    this.#callbacks.set(callbackId, wrappedCallback);
    if (upgradeToCfcLabel) {
      // Tear down the label-less backend sub, then re-open it label-aware.
      void this.#conn.unsubscribe(this).finally(() => {
        this.#conn.subscribe(this);
      });
    } else {
      this.#conn.subscribe(this);
    }

    // Always call callback immediately with current value
    // This matches Cell behavior - callback is always called, even if value is undefined
    wrappedCallback(this.#value, this.#cfcLabel);

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

  async getCfcLabel(): Promise<CfcLabelView | undefined> {
    const response = await this.#conn.request<
      RequestType.CellGetCfcLabel
    >({
      type: RequestType.CellGetCfcLabel,
      cell: this.ref(),
    });
    return response.cfcLabel;
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
    const { schema: _schema, ...rest } = this.#ref;
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
      scope: this.#ref.scope,
      path: [...this.#ref.path, key],
      // Child schema is unknown, so we don't include it
      ...(this.#ref.cfcLabelView !== undefined && {
        cfcLabelView: rebaseCfcLabelView(this.#ref.cfcLabelView, [key]),
      }),
    };
  }

  toJSON(): SigilLink {
    // Wrap in sigil link format so the runtime recognizes this as a link
    // and dereferences it (e.g., when passed through event.detail.sourceCell)
    return linkRefFrom<CfcCellLinkRefPayload>({
      id: this.#ref.id,
      space: this.#ref.space,
      scope: this.#ref.scope,
      path: this.#ref.path,
      ...(this.#ref.schema !== undefined && { schema: this.#ref.schema }),
      ...(this.#ref.overwrite !== undefined &&
        { overwrite: this.#ref.overwrite }),
      ...(this.#ref.cfcLabelView !== undefined && {
        cfcLabelView: this.#ref.cfcLabelView,
      }),
    });
  }

  /**
   * Encodes this cell's link to a wire string (the `fcl1:` cell-link form) for
   * transport across a string boundary (e.g. an HTTP body) from which it will
   * be decoded back to a link. Only the plain addressing fields cross the wire;
   * `schema` and the cfc label view are deliberately omitted (see
   * {@link linkRefPayloadToString}).
   */
  toWireString(): string {
    return linkRefPayloadToString({
      id: this.#ref.id,
      space: this.#ref.space,
      ...(this.#ref.scope !== undefined && { scope: this.#ref.scope }),
      path: this.#ref.path,
      ...(this.#ref.overwrite !== undefined &&
        { overwrite: this.#ref.overwrite }),
    });
  }

  // Called when cell has been updated from the backend with
  // a raw value that may contain CellRefs.
  [$onCellUpdate](
    value: unknown,
    labelUpdate?: { cfcLabel: CfcLabelView | undefined },
  ): void {
    const applied = applyValue(
      value,
      this.#value,
      this as CellHandle<unknown>,
    ) as T;
    const valueChanged = !valuesEqual(applied, this.#value);
    // A label-only change (value identical) still fires label-aware subscribers.
    // `labelUpdate` is present only on notifications that carried a label, so a
    // value-only notification never spuriously churns the label.
    const labelChanged = labelUpdate !== undefined && this.#wantsCfcLabel &&
      !cfcLabelViewsEqual(labelUpdate.cfcLabel, this.#cfcLabel);
    if (!valueChanged && !labelChanged) {
      return;
    }

    if (valueChanged) this.#value = applied;
    if (labelUpdate !== undefined) this.#cfcLabel = labelUpdate.cfcLabel;
    for (const callback of this.#callbacks.values()) {
      callback(this.#value as Readonly<T>, this.#cfcLabel);
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
  if (!cfcLabelViewsEqual(a.cfcLabelView, b.cfcLabelView)) return false;
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
    const linkData = linkRefPayload(value);

    return {
      id: linkData.id ?? from.id,
      space: linkData.space ?? from.space,
      scope: linkData.scope === "space" || linkData.scope === "user" ||
          linkData.scope === "session"
        ? linkData.scope
        : from.scope,
      path: (linkData.path ?? []).map((p) => p.toString()),
      ...(linkData.schema !== undefined && { schema: linkData.schema }),
      ...((linkData as { cfcLabelView?: CfcLabelView }).cfcLabelView !==
          undefined && {
        cfcLabelView: (linkData as { cfcLabelView?: CfcLabelView })
          .cfcLabelView,
      }),
    };
  } else if (isLegacyAlias(value)) {
    const alias = value.$alias;
    const aliasPath = alias.path.map((p) => String(p));

    // Named-cell/partialCause aliases carry no absolute id of their own;
    // resolve to the base cell's document.
    return {
      id: from.id,
      space: from.space,
      scope: from.scope,
      path: aliasPath,
      ...(alias.schema !== undefined && { schema: alias.schema }),
    };
  }
}
