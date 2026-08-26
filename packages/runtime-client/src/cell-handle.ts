/**
 * CellHandle - Represents a `Cell` in a runtime.
 */

import {
  FabricInstance,
  FabricPrimitive,
  FabricSpecialObject,
  type FabricValue,
  valueEqual,
} from "@commonfabric/data-model/fabric-value";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { DID } from "@commonfabric/identity";
import { type CfcCellLinkRefPayload } from "@commonfabric/runner/cfc";
import {
  cfcLabelViewsEqual,
  rebaseCfcLabelView,
} from "@commonfabric/runner/cfc/label-view-core";
import {
  type Cancel,
  isSigilLink,
  type JSONSchema,
  linkRefFrom,
  linkRefPayload,
  linkRefPayloadToString,
  refuseFabricInstance,
  type SigilLink,
} from "@commonfabric/runner/shared";
import { getLogger } from "@commonfabric/utils/logger";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

import { InitializedRuntimeConnection } from "./client/connection.ts";
import {
  type CellRef,
  type CfcLabelView,
  JSONValue,
  RequestType,
  type SqliteParams,
  type WireCellValue,
} from "./protocol/mod.ts";
import { $conn, type RuntimeClient } from "./runtime-client.ts";

// Logger for schema warnings - disabled by default.
// Enable via: globalThis.commonfabric.logger["cell-handle"].disabled = false
const logger = getLogger("cell-handle", { enabled: false });

export const $onCellUpdate = Symbol("$onCellUpdate");

/**
 * A cell's value as the _client_ holds it: what a cell holds, with a
 * `CellHandle` wherever a cell sits. That is the substitution `vnode-types.ts`
 * already makes for the render types -- `Cell` replaced by `CellHandle` --
 * applied to a cell's own value.
 *
 * What a cell holds is a `FabricValue`, so that is an arm of this rather than
 * something restated: a `FabricBytes` in a cell is a value the client holds
 * like any other, and this stays true of whatever `FabricValue` comes to admit.
 * The container arms are here too, since theirs hold `FabricValue` where these
 * hold handles as well.
 *
 * That the connection cannot presently _carry_ all of it is a fact about
 * `WireCellValue`, not about this: see the note there.
 */
export type ClientCellValue =
  | FabricValue
  | readonly ClientCellValue[]
  | { readonly [key: string]: ClientCellValue }
  | CellHandle<unknown>;

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
  #strictWriteTail: Promise<void> | undefined;

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

  /**
   * The FULL schemed id — identical to `ref().id` and safe to use as
   * identity (keys, equality, round-trips). The hash preimage is kind-free,
   * so the URI scheme is the only thing distinguishing a computed doc from
   * a state sibling of the same cause; this accessor never strips it. For
   * the piece-root routing/display form (bare, `of:`-stripped), use
   * `PageHandle.id()` — see docs/specs/computed-cell-identity.md.
   */
  id(): string {
    return this.#ref.id;
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
    // A plain set is a blind last-write-wins overwrite (CellSet).
    await this.#applyLocalAndSend(value, RequestType.CellSet);
  }

  /** Set the cell's value and reject when the runtime refuses the write. */
  async setStrict(value: T): Promise<void> {
    this.#requireSchema("setStrict");
    const writing = this.#strictWriteTail
      ? this.#strictWriteTail.then(() =>
        this.#applyLocalAndSend(value, RequestType.CellSet, true)
      )
      : this.#applyLocalAndSend(value, RequestType.CellSet, true);
    const tail = writing.catch(() => {});
    this.#strictWriteTail = tail;
    void tail.then(() => {
      if (this.#strictWriteTail === tail) this.#strictWriteTail = undefined;
    });
    await writing;
  }

  // Optimistic local update (mirrors the old set()) plus the remote write. The
  // request _type_ encodes the intent: CellSet is a blind overwrite, CellPush
  // is a read-modify-write append that the runtime keeps as compare-and-set.
  #applyLocalAndSend(
    value: T,
    type: RequestType.CellSet | RequestType.CellPush,
    propagateFailure = false,
  ): Promise<void> {
    // Serialized _first_, because it can refuse. The local update below is
    // optimistic about the _write_ -- it assumes a value the connection
    // accepts will land -- and not about whether the value can be sent at all.
    // Were the refusal to come after, a value the runtime is never going to
    // see would already be this handle's cached value and would already have
    // reached every subscriber, leaving the display showing state that does
    // not exist.
    //
    // `T` is unconstrained, so this says what the write path requires rather
    // than what the class guarantees. Constraining `T` to `ClientCellValue` is
    // the honest fix and is not a small one: the schema-derived types
    // (`ObjectFromProperties<...>`) and the looser `Props` of `vnode-types.ts`
    // do not satisfy it, an interface having no implicit index signature where
    // an identical type alias does.
    //
    // TODO(danfuzz): constrain `T`, once those types are assignable.
    const serialized = CellHandle.serialize(value as ClientCellValue);
    const cell = this.ref();

    if (propagateFailure) {
      const before = this.#value;
      return this.#conn.request<RequestType.CellSet>({
        type: RequestType.CellSet,
        cell,
        value: serialized,
        awaitCommit: true,
      }).then(() => {
        if (this.#value === before) this.#publishValue(value);
      });
    }

    this.#publishValue(value);

    const request = type === RequestType.CellPush
      ? this.#conn.request<RequestType.CellPush>({
        type: RequestType.CellPush,
        cell,
        value: serialized,
      })
      : this.#conn.request<RequestType.CellSet>({
        type: RequestType.CellSet,
        cell,
        value: serialized,
      });
    return request.catch((error) => {
      if (!this.#conn.signal.aborted) {
        console.error("[CellHandle] Write failed:", error);
      }
    });
  }

  #publishValue(value: T): void {
    this.#value = value;
    for (const callback of this.#callbacks.values()) {
      try {
        // A local update does not change the label; carry the current one.
        callback(value as Readonly<T>, this.#cfcLabel);
      } catch (error) {
        console.error("[CellHandle] Callback error:", error);
      }
    }
  }

  async send(event: T): Promise<void> {
    await this.#send(event);
  }

  /** Send a stream event and reject when the runtime refuses it. */
  async sendStrict(event: T): Promise<void> {
    await this.#send(event, true);
  }

  #send(event: T, propagateFailure = false): Promise<void> {
    const request = this.#conn.request<RequestType.CellSend>({
      type: RequestType.CellSend,
      cell: this.ref(),
      event: CellHandle.serialize(event as ClientCellValue),
      ...(propagateFailure && { awaitCommit: true }),
    });
    if (propagateFailure) return request;
    return request.catch((error) => {
      if (!this.#conn.signal.aborted) {
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

  // A push is read-modify-write: build the appended array locally, then send it
  // as a CellPush (not CellSet) so the runtime keeps the read-target as a commit
  // precondition (compare-and-set) — a concurrent push aborts rather than being
  // clobbered by a blind overwrite.
  push<U>(
    this: CellHandle<U[]>,
    ...values: T extends (infer U)[] ? U[] : never
  ): void {
    const current = this.#value as unknown as unknown[];
    if (!Array.isArray(current)) {
      throw new Error("push() can only be used on array cells");
    }
    void this.#applyLocalAndSend(
      [...current, ...values] as unknown as U[],
      RequestType.CellPush,
    );
  }

  /** The cell's current display CFC label, for label-aware subscribers. */
  get cfcLabel(): CfcLabelView | undefined {
    return this.#cfcLabel;
  }

  /** Whether this handle subscribed asking for reactive CFC-label delivery. */
  get wantsCfcLabel(): boolean {
    return this.#wantsCfcLabel;
  }

  /**
   * Subscribe to cell value changes.
   * The callback is called immediately with the current value (even if undefined)
   * and whenever the value changes.
   * The callback's return value (if a Cancel function) is called before the next update.
   */
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

  /** Demand lazy producers before fetching the current value. */
  async pull(): Promise<Readonly<T> | undefined> {
    const response = await this.#conn.request<RequestType.CellPull>({
      type: RequestType.CellPull,
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

  /** Run a read-only query when this handle refers to a SQLite database. */
  async querySqlite<Row = Record<string, unknown>>(
    sql: string,
    params?: ReadonlyArray<ClientCellValue> | Record<string, ClientCellValue>,
  ): Promise<Row[]> {
    const response = await this.#conn.request<RequestType.SqliteQuery>({
      type: RequestType.SqliteQuery,
      cell: this.ref(),
      sql,
      ...(params !== undefined && {
        params: CellHandle.serializeSqliteParams(params),
      }),
    });
    return response.rows.map((row) => CellHandle.deserialize(this, row) as Row);
  }

  /** Commit a SQL write when this handle refers to a SQLite database. */
  async execSqlite(
    sql: string,
    params?: ReadonlyArray<ClientCellValue> | Record<string, ClientCellValue>,
  ): Promise<void> {
    await this.#conn.request<RequestType.SqliteExec>({
      type: RequestType.SqliteExec,
      cell: this.ref(),
      sql,
      ...(params !== undefined && {
        params: CellHandle.serializeSqliteParams(params),
      }),
    });
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
    // and dereferences it (e.g., when passed through event.detail.sourceCell).
    //
    // The ref-carried `cfcLabelView` is deliberately NOT serialized (inv-12
    // Stage 0, like `toWireString`): toJSON output is exactly what
    // JSON.stringify hands the VDOM event path when a handle lands in
    // CustomEvent.detail, and that raw sigil link re-enters the worker
    // without passing getCell/cellRefToSigilLink — a main-thread display
    // copy must not ride back in as label state (codex/cubic review on the
    // Stage 0 PR; the worker also strips inbound views defensively).
    return linkRefFrom<CfcCellLinkRefPayload>({
      id: this.#ref.id,
      space: this.#ref.space,
      scope: this.#ref.scope,
      path: this.#ref.path,
      ...(this.#ref.schema !== undefined && { schema: this.#ref.schema }),
      ...(this.#ref.overwrite !== undefined &&
        { overwrite: this.#ref.overwrite }),
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
    const valueChanged = !valuesOrCellsEqual(applied, this.#value);
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
   * Recursively hydrate any object, converting any sigil links into
   * CellHandle instances. Legacy `$alias` records are plain data — they are
   * only meaningful as bindings inside Pattern objects, which the client
   * never interprets.
   */
  static deserialize<T>(
    base: CellHandle<T>,
    value: unknown,
  ): unknown {
    if (value instanceof FabricSpecialObject) return value;

    if (
      !value && typeof value === "string" || typeof value === "boolean" ||
      typeof value === "number"
    ) {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((item) => CellHandle.deserialize(base, item));
    }

    // A `FabricPrimitive` is a leaf, so a walk that stops at it has already
    // done the right thing -- and this goes _before_ the record branch, which
    // rebuilds from enumerable own properties a fabric class does not have and
    // would put `{}` here in place of the value.
    if (value instanceof FabricPrimitive) return value;

    // An instance is a container, reached by its codec contents rather than by
    // property name, so a sigil link can sit inside one where this walk cannot
    // see it -- and a value handed back unhydrated would carry that link where
    // a `CellHandle` belongs.
    //
    // Nothing reaches this today, de facto rather than by construction: the
    // connection carries a value by structured cloning, which strips a fabric
    // class before it arrives, and `CellHandle.serialize()` refuses one on the
    // way out.
    if (value instanceof FabricInstance) {
      refuseFabricInstance(value, "when hydrating a value off the connection");
    }

    if (isObjectOrArray(value)) {
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

  private static serializeSqliteParams(
    params: ReadonlyArray<ClientCellValue> | Record<string, ClientCellValue>,
  ): SqliteParams {
    const serialize = (value: ClientCellValue) =>
      value instanceof FabricBytes ? value : CellHandle.serialize(value);
    return Array.isArray(params) ? params.map(serialize) : Object.fromEntries(
      Object.entries(params).map(([key, value]) => [key, serialize(value)]),
    );
  }

  /**
   * Converts a value the client holds into the one the connection carries,
   * which is the same data with a `CellRef` wherever a `CellHandle` sat.
   *
   * Refuses a `FabricSpecialObject`, which the connection cannot carry.
   *
   * `CellHandle.deserialize()` is the inverse.
   */
  static serialize(value: ClientCellValue): WireCellValue {
    if (isCellHandle(value)) return value.ref();

    if (Array.isArray(value)) {
      return value.map((element) => CellHandle.serialize(element));
    }

    // A `FabricSpecialObject` is a `ClientCellValue` -- a cell holds one like
    // any other value -- but `WireCellValue` has no representation for it, so
    // this refuses rather than converting. It goes _before_ the record test:
    // such a value is also a record, and that branch would otherwise rebuild
    // it from enumerable own properties it is not supposed to have, putting
    // `{}` on the wire in place of a `FabricBytes` and losing the bytes with
    // nothing to show for it.
    //
    // A _de facto_ tripwire, in the sense of "Flag-gated tripwires" in
    // `docs/development/EXPERIMENTAL_OPTIONS.md`: no flag gates this, and a
    // `FabricBytes` is an ordinary shipped value, so what makes the refusal
    // safe is that nothing writes one from the client today. The first thing
    // that does will throw here, in the change that adds it.
    //
    // TODO(danfuzz): carry the whole `FabricValue` domain across this
    // connection, at which point this becomes a conversion rather than a
    // refusal. `codec-realm` is the mechanism, and the gap it closes is the
    // one marked on `WireCellValue` in `protocol/types.ts`.
    if (value instanceof FabricSpecialObject) {
      throw new Error(
        `Cannot yet handle \`${value.constructor.name}\` (a ` +
          "`FabricSpecialObject`) on this connection.",
      );
    }

    if (isObjectOrArray(value)) {
      return Object.fromEntries(
        Object.entries(value).map((
          [key, member],
        ) => [key, CellHandle.serialize(member)]),
      );
    }

    if (
      typeof value === "string" || typeof value === "number" ||
      typeof value === "boolean" || value === undefined || value === null
    ) {
      return value;
    }

    // Reachable two ways. A `bigint` and a `symbol` are `FabricValue` arms, so
    // a cell holds either and `ClientCellValue` admits either, while
    // `WireCellValue` has neither -- the same gap the refusal above covers,
    // for the two arms that are not objects. And `CellHandle<T>` does not
    // constrain `T`, so `set()` and `send()` cast on the way in and a caller
    // can arrive here with anything at all.
    //
    // `typeof` names the kind, since the value's own text rarely explains the
    // refusal: a `1n` prints as `1`, which reads like a number that was
    // rejected for no reason. `String()` rather than interpolation, a symbol
    // throwing on implicit conversion and replacing this refusal with a
    // `TypeError` naming nothing.
    throw new Error(
      `Cannot send a \`${typeof value}\` on this connection: ${String(value)}`,
    );
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

  // A leaf, carried through whole as `deserialize()` hydrates one: the record
  // branch below would rebuild it from enumerable own properties it does not
  // have.
  if (current instanceof FabricPrimitive) {
    return current;
  }

  // A container this walk cannot descend, so it cannot preserve a handle
  // inside one against the incoming value the way it does for a record.
  // Unreachable for the same reason as in `deserialize()`.
  if (current instanceof FabricInstance) {
    refuseFabricInstance(current, "when applying a delivered value");
  }

  // For plain objects, recursively apply to each property
  if (isObjectOrArray(current)) {
    const prevRecord = (isObjectNotArray(previous))
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
  if ((a.scope ?? "space") !== (b.scope ?? "space")) return false;
  if (a.path.length !== b.path.length) return false;
  for (let i = 0; i < a.path.length; i++) {
    if (a.path[i] !== b.path[i]) return false;
  }
  if (!cfcLabelViewsEqual(a.cfcLabelView, b.cfcLabelView)) return false;
  return true;
}

/**
 * Compares two values a cell can hold, deciding whether a delivered update is
 * a change this handle's subscribers hear about.
 *
 * Distinct from `valueEqual()`, which it calls: that settles a `FabricValue`
 * by content, and this also knows about cells. A `CellHandle` compares by the
 * cell it names rather than by what that cell holds, so two handles on one
 * cell are equal and a handle is equal to nothing else.
 */
function valuesOrCellsEqual(a: unknown, b: unknown): boolean {
  // `Object.is`, not `===`: an unchanged `NaN` leaf must compare equal (else
  // every delivery of a NaN-bearing value re-notifies all subscribers), and a
  // `0` -> `-0` change must compare unequal (else the update is dropped).
  if (Object.is(a, b)) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  // Either side being a handle is enough to ask. A handle holds its state
  // privately, so the record branch below would read `{}` off it and call it
  // equal to anything else without enumerable own keys -- `{}` itself among
  // them, so replacing a handle with a record would be judged a no-change and
  // reach no subscriber. A handle is a reference to a cell and equals only
  // another reference to the same cell.
  if (isCellHandle(a) || isCellHandle(b)) {
    return isCellHandle(a) && isCellHandle(b) && a.equals(b);
  }

  // A `FabricPrimitive` is compared by the data model rather than by this
  // walk, and _before_ the record branch, for the same reason: two
  // `FabricBytes` over different bytes both present as `{}` there and would
  // compare equal. A primitive is a leaf, so comparing its content is the
  // whole comparison.
  //
  // There is no arm for a `FabricInstance`. `applyValue()` is this function's
  // only caller and refuses one before it returns, so neither argument can
  // hold one -- an arm here would be unreachable rather than defensive, and
  // untestable with it.
  if (a instanceof FabricPrimitive || b instanceof FabricPrimitive) {
    return valueEqual(a as FabricValue, b as FabricValue);
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!valuesOrCellsEqual(a[i], b[i])) return false;
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
      !valuesOrCellsEqual(
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
  }
}
