import { type Immutable, isObject, isRecord } from "@commontools/utils/types";
import type { MemorySpace } from "@commontools/memory/interface";
import { getTopFrame } from "./builder/recipe.ts";
import {
  type Cell,
  ID,
  ID_FIELD,
  isStreamValue,
  type JSONSchema,
  type OpaqueRef,
  type Schema,
  type Stream,
  TYPE,
} from "./builder/types.ts";
import { toOpaqueRef } from "./back-to-cell.ts";
import {
  createQueryResultProxy,
  getCellOrThrow,
  isQueryResultForDereferencing,
  makeOpaqueRef,
  type QueryResult,
} from "./query-result-proxy.ts";
import { diffAndUpdate } from "./data-updating.ts";
import { resolveLink } from "./link-resolution.ts";
import { ignoreReadForScheduling, txToReactivityLog } from "./scheduler.ts";
import { type Cancel, isCancel, useCancelGroup } from "./cancel.ts";
import { validateAndTransform } from "./schema.ts";
import { toURI } from "./uri-utils.ts";
import {
  type LegacyJSONCellLink,
  LINK_V1_TAG,
  type SigilLink,
  type SigilWriteRedirectLink,
  type URI,
} from "./sigil-types.ts";
import { areLinksSame, isLink } from "./link-utils.ts";
import type { IRuntime } from "./runtime.ts";
import {
  createSigilLinkFromParsedLink,
  type NormalizedFullLink,
} from "./link-utils.ts";
import type {
  IExtendedStorageTransaction,
  IReadOptions,
} from "./storage/interface.ts";
import { fromURI } from "./uri-utils.ts";

/**
 * This is the regular Cell interface.
 *
 * This abstracts away the paths behind an interface that e.g. the UX code or
 * modules that prefer cell interfaces can use.
 *
 * These methods are available in the system and in spell code:
 *
 * @method get Returns the current value of the cell.
 * @returns {T}
 *
 * @method set Alias for `send`. Sets a new value for the cell.
 * @method send Sets a new value for the cell.
 * @param {T} value - The new value to set.
 * @returns {void}
 *
 * @method update Updates multiple properties of an object cell at once.
 * @param {Partial<T>} values - The properties to update.
 * @returns {void}
 *
 * @method push Adds an item to the end of an array cell.
 * @param {U | Cell<U>} value - The value to add, where U is
 * the array element type.
 * @returns {void}
 *
 * @method equals Compares two cells for equality.
 * @param {Cell<any>} other - The cell to compare with.
 * @returns {boolean}
 *
 * @method key Returns a new cell for the specified key path.
 * @param {K} valueKey - The key to access in the cell's value.
 * @returns {Cell<T[K]>}
 *
 * Everything below is only available in the system, not in spell code:
 *
 * @method asSchema Creates a new cell with a specific schema.
 * @param {JSONSchema} schema - The schema to apply.
 * @returns {Cell<T>} - A cell with the specified schema.
 *
 * @method withTx Creates a new cell with a specific transaction.
 * @param {IExtendedStorageTransaction} tx - The transaction to use.
 * @returns {Cell<T>}
 *
 * @method sink Adds a callback that is called immediately and on cell changes.
 * @param {function} callback - The callback to be called when the cell changes.
 * @returns {function} - A function to Cleanup the callback.
 *
 * @method sync Syncs the cell to the storage.
 * @returns {Promise<void>}
 *
 * @method getAsQueryResult Returns a query result for the cell.
 * @param {Path} path - The optional path to follow.
 * @param {ReactivityLog} log - Optional reactivity log.
 * @returns {QueryResult<DeepKeyLookup<T, Path>>}
 *
 * @method getAsNormalizedFullLink Returns a normalized full link for the cell.
 * @returns {NormalizedFullLink}
 *
 * @method getAsLink Returns a cell link for the cell (new sigil format).
 * @returns {SigilLink}
 *
 * @method getRaw Raw access method, without following aliases (which would
 * write to the destination instead of the cell itself).
 * @param {IReadOptions} options - Optional read options.
 * @returns {Immutable<JSONValue> | undefined} - Raw readonly document data
 *
 * @method setRaw Raw write method that bypasses Cell validation,
 * transformation, and alias resolution. Writes directly to the cell without
 * following aliases.
 * @param {any} value - Raw value to write directly to document
 *
 * @method getSourceCell Returns the source cell with optional schema.
 * @param {JSONSchema} schema - Optional schema to apply.
 * @returns {Cell<T & {[TYPE]: string | undefined} & {argument: any}>}
 *
 * @method toJSON Returns a serializable cell link (not the contents) to the
 * cell. This is used e.g. when creating merkle references that refer to cells.
 * It currentlly doesn't contain the space. We'll eventually want to get a
 * relative link here, but that will require context toJSON doesn't get.
 * @returns {{cell: {"/": string} | undefined, path: PropertyKey[]}}
 *
 * @property entityId Returns the current entity ID of the cell.
 * @returns {EntityId}
 *
 * @property sourceURI Returns the source URI of the cell.
 * @returns {URI}
 *
 * @property schema Optional schema for the cell.
 * @returns {JSONSchema | undefined}
 *
 * @property runtime The runtime that was used to create the cell.
 * @returns {IRuntime}
 *
 * @property tx The transaction that was used to create the cell.
 * @returns {IExtendedStorageTransaction}
 *
 * @property rootSchema Optional root schema for cell's schema. This differs
 * from `schema` when the cell represents a child of the original cell (e.g. via
 * `key()`). We need to keep the root schema to resolve `$ref` in the schema.
 * @returns {JSONSchema | undefined}
 *
 * The following are just for debugging and might disappear: (This allows
 * clicking on a property in the debugger and getting the value)
 *
 * @method value Returns the current value of the cell.
 * @returns {T}
 *
 * @property cellLink The cell link representing this cell.
 * @returns {SigilLink}
 */
declare module "@commontools/api" {
  interface Cell<T> {
    get(): Readonly<T>;
    set(value: Cellify<T> | T): void;
    send(value: Cellify<T> | T): void;
    update<V extends Cellify<Partial<T> | Partial<T>>>(
      values: V extends object ? V : never,
    ): void;
    push(
      ...value: Array<
        | (T extends Array<infer U> ? (Cellify<U> | U) : any)
        | Cell
      >
    ): void;
    equals(other: any): boolean;
    key<K extends T extends Cell<infer S> ? keyof S : keyof T>(
      valueKey: K,
    ): Cell<
      T extends Cell<infer S> ? S[K & keyof S] : T[K] extends never ? any : T[K]
    >;
    asSchema<S extends JSONSchema = JSONSchema>(
      schema: S,
    ): Cell<Schema<S>>;
    asSchema<T>(
      schema?: JSONSchema,
    ): Cell<T>;
    withTx(tx?: IExtendedStorageTransaction): Cell<T>;
    sink(callback: (value: Readonly<T>) => Cancel | undefined | void): Cancel;
    sync(): Promise<Cell<T>> | Cell<T>;
    getAsQueryResult<Path extends PropertyKey[]>(
      path?: Readonly<Path>,
      tx?: IExtendedStorageTransaction,
    ): QueryResult<DeepKeyLookup<T, Path>>;
    getAsNormalizedFullLink(): NormalizedFullLink;
    getAsLink(
      options?: {
        base?: Cell<any>;
        baseSpace?: MemorySpace;
        includeSchema?: boolean;
      },
    ): SigilLink;
    getAsWriteRedirectLink(
      options?: {
        base?: Cell<any>;
        baseSpace?: MemorySpace;
        includeSchema?: boolean;
      },
    ): SigilWriteRedirectLink;
    getRaw(options?: IReadOptions): Immutable<T> | undefined;
    setRaw(value: any): void;
    getSourceCell<T>(
      schema?: JSONSchema,
    ):
      | Cell<
        & T
        // Add default types for TYPE and `argument`. A more specific type in T will
        // take precedence.
        & { [TYPE]: string | undefined }
        & ("argument" extends keyof T ? unknown : { argument: any })
      >
      | undefined;
    getSourceCell<S extends JSONSchema = JSONSchema>(
      schema: S,
    ):
      | Cell<
        & Schema<S>
        // Add default types for TYPE and `argument`. A more specific type in
        // `schema` will take precedence.
        & { [TYPE]: string | undefined }
        & ("argument" extends keyof Schema<S> ? unknown
          : { argument: any })
      >
      | undefined;
    setSourceCell(sourceCell: Cell<any>): void;
    // This just flags as frozen. It does not prevent modification
    freeze(reason: string): void;
    isFrozen(): boolean;
    toJSON(): LegacyJSONCellLink;
    runtime: IRuntime;
    tx: IExtendedStorageTransaction | undefined;
    schema?: JSONSchema;
    rootSchema?: JSONSchema;
    value: T;
    cellLink: SigilLink;
    space: MemorySpace;
    entityId: { "/": string };
    sourceURI: URI;
    path: readonly PropertyKey[];
    copyTrap: boolean;
    [toOpaqueRef]: () => OpaqueRef<any>;
  }

  interface Stream<T> {
    send(event: T): void;
    sink(callback: (event: Readonly<T>) => Cancel | undefined | void): Cancel;
    sync(): Promise<Stream<T>> | Stream<T>;
    getRaw(options?: IReadOptions): any;
    getAsNormalizedFullLink(): NormalizedFullLink;
    getAsLink(
      options?: {
        base?: Cell<any>;
        baseSpace?: MemorySpace;
        includeSchema?: boolean;
      },
    ): SigilLink;
    withTx(tx?: IExtendedStorageTransaction): Stream<T>;
    schema?: JSONSchema;
    rootSchema?: JSONSchema;
    runtime: IRuntime;
  }
}

export type { Cell, Stream } from "@commontools/api";

export type { MemorySpace } from "@commontools/memory/interface";

/**
 * Cellify is a type utility that allows any part of type T to be wrapped in
 * Cell<>, and allow any part of T that is currently wrapped in Cell<> to be
 * used unwrapped. This is designed for use with Cell<T> method parameters,
 * allowing flexibility in how values are passed.
 */
export type Cellify<T> =
  // Handle existing Cell<> types, allowing unwrapping
  T extends Cell<infer U> ? Cellify<U> | Cell<Cellify<U>>
    // Handle arrays
    : T extends Array<infer U> ? Array<Cellify<U>> | Cell<Array<Cellify<U>>>
    // Handle objects (excluding null), adding optional ID fields
    : T extends object ?
        | ({ [K in keyof T]: Cellify<T[K]> } & { [ID]?: any; [ID_FIELD]?: any })
        | Cell<
          { [K in keyof T]: Cellify<T[K]> } & { [ID]?: any; [ID_FIELD]?: any }
        >
    // Handle primitives
    : T | Cell<T>;

export function createCell<T>(
  runtime: IRuntime,
  link: NormalizedFullLink,
  tx?: IExtendedStorageTransaction,
  noResolve = false,
  synced = false,
): Cell<T> {
  let { schema, rootSchema } = link;

  // Resolve the path to check whether it's a stream.
  const readTx = runtime.readTx(tx);
  const resolvedLink = noResolve ? link : resolveLink(readTx, link);
  const value = readTx.readValueOrThrow(resolvedLink, {
    meta: ignoreReadForScheduling,
  });

  // Use schema from alias if provided and no explicit schema was set
  if (!schema && resolvedLink.schema) {
    schema = resolvedLink.schema;
    rootSchema = resolvedLink.rootSchema || resolvedLink.schema;
  }

  if (isStreamValue(value)) {
    return new StreamCell(
      runtime,
      { ...resolvedLink, schema, rootSchema },
      tx,
    ) as unknown as Cell<T>;
  } else {
    return new RegularCell(
      runtime,
      { ...link, schema, rootSchema },
      tx,
      synced,
    );
  }
}

class StreamCell<T> implements Stream<T> {
  private listeners = new Set<(event: T) => Cancel | undefined>();
  private cleanup: Cancel | undefined;

  constructor(
    public readonly runtime: IRuntime,
    private readonly link: NormalizedFullLink,
    private readonly tx?: IExtendedStorageTransaction,
  ) {}

  get schema(): JSONSchema | undefined {
    return this.link.schema;
  }

  get rootSchema(): JSONSchema | undefined {
    return this.link.rootSchema;
  }

  send(event: T): void {
    event = convertCellsToLinks(event) as T;

    // Use runtime from doc if available
    this.runtime.scheduler.queueEvent(this.link, event);

    this.cleanup?.();
    const [cancel, addCancel] = useCancelGroup();
    this.cleanup = cancel;

    this.listeners.forEach((callback) => addCancel(callback(event)));
  }

  sink(callback: (value: Readonly<T>) => Cancel | undefined): Cancel {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  // sync: No-op for streams, but maybe eventually it might mean wait for all
  // events to have been processed
  sync(): Stream<T> {
    return this;
  }

  getRaw(options?: IReadOptions): Immutable<T> | undefined {
    // readValueOrThrow requires JSONValue, while we require T
    return this.runtime.readTx(this.tx).readValueOrThrow(
      this.link,
      options,
    ) as Immutable<T> | undefined;
  }

  getAsNormalizedFullLink(): NormalizedFullLink {
    return this.link;
  }

  getAsLink(
    options?: {
      base?: Cell<any>;
      baseSpace?: MemorySpace;
      includeSchema?: boolean;
    },
  ): SigilLink {
    return createSigilLinkFromParsedLink(this.link, options);
  }

  withTx(_tx?: IExtendedStorageTransaction): Stream<T> {
    return this; // No-op for streams
  }
}

export class RegularCell<T> implements Cell<T> {
  private readOnlyReason: string | undefined;

  constructor(
    public readonly runtime: IRuntime,
    private readonly link: NormalizedFullLink,
    public readonly tx: IExtendedStorageTransaction | undefined,
    private synced: boolean = false,
  ) {}

  get space(): MemorySpace {
    return this.link.space;
  }

  get path(): readonly PropertyKey[] {
    return this.link.path;
  }

  get schema(): JSONSchema | undefined {
    return this.link.schema;
  }

  get rootSchema(): JSONSchema | undefined {
    return this.link.rootSchema;
  }

  get(): Readonly<T> {
    if (!this.synced) this.sync(); // No await, just kicking this off
    return validateAndTransform(this.runtime, this.tx, this.link, this.synced);
  }

  set(newValue: Cellify<T> | T): void {
    if (!this.tx) throw new Error("Transaction required for set");

    // No await for the sync, just kicking this off, so we have the data to
    // retry on conflict.
    if (!this.synced) this.sync();

    // TODO(@ubik2) investigate whether i need to check classified as i walk down my own obj
    diffAndUpdate(
      this.runtime,
      this.tx,
      resolveLink(this.tx, this.link, "writeRedirect"),
      newValue,
      getTopFrame()?.cause,
    );
  }

  send(newValue: Cellify<T> | T): void {
    this.set(newValue);
  }

  update<V extends Cellify<Partial<T> | Partial<T>>>(
    values: V extends object ? V : never,
  ): void {
    if (!this.tx) throw new Error("Transaction required for update");
    if (!isRecord(values)) {
      throw new Error("Can't update with non-object value");
    }

    // No await for the sync, just kicking this off, so we have the data to
    // retry on conflict.
    if (!this.synced) this.sync();

    // Get current value, following aliases and references
    const resolvedLink = resolveLink(this.tx, this.link);
    const currentValue = this.tx.readValueOrThrow(resolvedLink);

    // If there's no current value, initialize based on schema
    if (currentValue === undefined) {
      if (this.schema) {
        // Check if schema allows objects
        const allowsObject = this.schema.type === "object" ||
          (Array.isArray(this.schema.type) &&
            this.schema.type.includes("object")) ||
          (this.schema.anyOf &&
            this.schema.anyOf.some((s) =>
              typeof s === "object" && s.type === "object"
            ));

        if (!allowsObject) {
          throw new Error(
            "Cannot update with object value - schema does not allow objects",
          );
        }
      }
      this.tx.writeValueOrThrow(resolvedLink, {});
    }

    // Now update each property
    for (const [key, value] of Object.entries(values)) {
      // Workaround for type checking, since T can be Cell<> and that's fine.
      (this.key as any)(key).set(value);
    }
  }

  push(...value: T extends Array<infer U> ? U[] : never): void;
  push(
    ...value: Array<
      | (T extends Array<infer U> ? (Cellify<U> | U) : any)
      | Cell
    >
  ): void;
  push(
    ...value: any[]
  ): void {
    if (!this.tx) throw new Error("Transaction required for push");

    // No await for the sync, just kicking this off, so we have the data to
    // retry on conflict.
    if (!this.synced) this.sync();

    // Follow aliases and references, since we want to get to an assumed
    // existing array.
    const resolvedLink = resolveLink(this.tx, this.link);
    const currentValue = this.tx.readValueOrThrow(resolvedLink);
    const cause = getTopFrame()?.cause;

    let array = currentValue as unknown[];
    if (array !== undefined && !Array.isArray(array)) {
      throw new Error("Can't push into non-array value");
    }

    // If this is an object and it doesn't have an ID, add one.
    const valuesToWrite = value.map((val: any) =>
      (!isLink(val) && isObject(val) &&
          (val as { [ID]?: unknown })[ID] === undefined && getTopFrame())
        ? { [ID]: getTopFrame()!.generatedIdCounter++, ...val }
        : val
    );

    // If there is no array yet, create it first. We have to do this as a
    // separate operation, so that in the next steps [ID] is properly anchored
    // in the array.
    if (array === undefined) {
      diffAndUpdate(
        this.runtime,
        this.tx,
        resolvedLink,
        [],
        cause,
      );
      array = Array.isArray(this.schema?.default) ? this.schema.default : [];
    }

    // Append the new values to the array.
    diffAndUpdate(
      this.runtime,
      this.tx,
      resolvedLink,
      [...array, ...valuesToWrite],
      cause,
    );
  }

  equals(other: any): boolean {
    return areLinksSame(this, other);
  }

  key<K extends T extends Cell<infer S> ? keyof S : keyof T>(
    valueKey: K,
  ): Cell<
    T extends Cell<infer S> ? S[K & keyof S] : T[K] extends never ? any : T[K]
  > {
    const childSchema = this.runtime.cfc.getSchemaAtPath(
      this.schema,
      [valueKey.toString()],
      this.rootSchema,
    );
    return createCell(
      this.runtime,
      {
        ...this.link,
        path: [...this.path, valueKey.toString()] as string[],
        schema: childSchema,
      },
      this.tx,
      false,
      this.synced,
    ) as Cell<
      T extends Cell<infer S> ? S[K & keyof S] : T[K] extends never ? any : T[K]
    >;
  }

  asSchema<S extends JSONSchema = JSONSchema>(
    schema: S,
  ): Cell<Schema<S>>;
  asSchema<T>(
    schema?: JSONSchema,
  ): Cell<T>;
  asSchema(schema?: JSONSchema): Cell<any> {
    return new RegularCell(
      this.runtime,
      { ...this.link, schema: schema, rootSchema: schema },
      this.tx,
      false, // Reset synced flag, since schmema is changing
    ) as Cell<any>;
  }

  withTx(newTx?: IExtendedStorageTransaction): Cell<T> {
    return new RegularCell(this.runtime, this.link, newTx, this.synced);
  }

  sink(callback: (value: Readonly<T>) => Cancel | undefined): Cancel {
    if (!this.synced) this.sync(); // No await, just kicking this off
    return subscribeToReferencedDocs(callback, this.runtime, this.link);
  }

  sync(): Promise<Cell<T>> | Cell<T> {
    this.synced = true;
    if (this.link.id.startsWith("data:")) return this;
    return this.runtime.storageManager.syncCell<T>(this);
  }

  getAsQueryResult<Path extends PropertyKey[]>(
    path?: Readonly<Path>,
    tx?: IExtendedStorageTransaction,
  ): QueryResult<DeepKeyLookup<T, Path>> {
    if (!this.synced) this.sync(); // No await, just kicking this off
    const subPath = path || [];
    return createQueryResultProxy(
      this.runtime,
      tx ?? this.tx ?? this.runtime.edit(),
      {
        ...this.link,
        path: [...this.path, ...subPath.map((p) => p.toString())] as string[],
      },
    );
  }

  getAsNormalizedFullLink(): NormalizedFullLink {
    return this.link;
  }

  getAsLink(
    options?: {
      base?: Cell<any>;
      baseSpace?: MemorySpace;
      includeSchema?: boolean;
    },
  ): SigilLink {
    return createSigilLinkFromParsedLink(this.link, {
      ...options,
      overwrite: "this",
    });
  }

  getAsWriteRedirectLink(
    options?: {
      base?: Cell<any>;
      baseSpace?: MemorySpace;
      includeSchema?: boolean;
    },
  ): SigilWriteRedirectLink {
    return createSigilLinkFromParsedLink(this.link, {
      ...options,
      overwrite: "redirect",
    }) as SigilWriteRedirectLink;
  }

  getRaw(options?: IReadOptions): Immutable<T> | undefined {
    if (!this.synced) this.sync(); // No await, just kicking this off
    return this.runtime.readTx(this.tx).readValueOrThrow(this.link, options) as
      | Immutable<T>
      | undefined;
  }

  setRaw(value: any): void {
    if (!this.tx) throw new Error("Transaction required for setRaw");

    // No await for the sync, just kicking this off, so we have the data to
    // retry on conflict.
    if (!this.synced) this.sync();

    try {
      value = JSON.parse(JSON.stringify(value));
    } catch (e) {
      console.error("Can't set raw value, it's not JSON serializable", e);
      return;
    }
    this.tx.writeValueOrThrow(this.link, value);
  }

  getSourceCell<T>(
    schema?: JSONSchema,
  ):
    | Cell<
      & T
      // Add default types for TYPE and `argument`. A more specific type in T will
      // take precedence.
      & { [TYPE]: string | undefined }
      & ("argument" extends keyof T ? unknown : { argument: any })
    >
    | undefined;
  getSourceCell<S extends JSONSchema = JSONSchema>(
    schema: S,
  ):
    | Cell<
      & Schema<S>
      // Add default types for TYPE and `argument`. A more specific type in
      // `schema` will take precedence.
      & { [TYPE]: string | undefined }
      & ("argument" extends keyof Schema<S> ? unknown
        : { argument: any })
    >
    | undefined;
  getSourceCell(schema?: JSONSchema): Cell<any> | undefined {
    if (!this.synced) this.sync(); // No await, just kicking this off
    let sourceCellId = this.runtime.readTx(this.tx).readOrThrow(
      { ...this.link, path: ["source"] },
    ) as string | undefined;
    if (!sourceCellId) return undefined;
    if (isRecord(sourceCellId)) {
      sourceCellId = toURI(sourceCellId);
    } else if (
      typeof sourceCellId === "string" && sourceCellId.startsWith('{"/":')
    ) {
      sourceCellId = toURI(JSON.parse(sourceCellId));
    }

    if (typeof sourceCellId !== "string" || !sourceCellId.startsWith("of:")) {
      throw new Error("Source cell ID must start with 'of:'");
    }
    return createCell(this.runtime, {
      space: this.link.space,
      path: [],
      id: toURI(sourceCellId),
      type: "application/json",
      schema: schema,
    }, this.tx) as Cell<any>;
  }

  setSourceCell(sourceCell: Cell<any>): void {
    if (!this.tx) throw new Error("Transaction required for setSourceCell");

    // No await for the sync, just kicking this off, so we have the data to
    // retry on conflict.
    if (!this.synced) this.sync();

    const sourceLink = sourceCell.getAsNormalizedFullLink();
    if (sourceLink.path.length > 0) {
      throw new Error("Source cell must have empty path for now");
    }
    this.tx.writeOrThrow(
      { ...this.link, path: ["source"] },
      // TODO(@ubik2): Transition source links to sigil links?
      { "/": fromURI(sourceLink.id) },
    );
  }

  freeze(reason: string): void {
    this.readOnlyReason = reason;
  }

  isFrozen(): boolean {
    return !!this.readOnlyReason;
  }

  toJSON(): LegacyJSONCellLink {
    // Keep old format for backward compatibility
    return {
      cell: {
        "/":
          (this.link.id.startsWith("data:")
            ? this.link.id
            : fromURI(this.link.id)),
      },
      path: this.path as (string | number)[],
    };
  }

  get value(): T {
    return this.get();
  }

  get cellLink(): SigilLink {
    return createSigilLinkFromParsedLink(this.link);
  }

  get entityId(): { "/": string } {
    return { "/": fromURI(this.link.id) };
  }

  get sourceURI(): URI {
    return this.link.id;
  }

  get copyTrap(): boolean {
    throw new Error(
      "Copy trap: Something is trying to traverse a cell.",
    );
  }

  [toOpaqueRef](): OpaqueRef<any> {
    return makeOpaqueRef(this.link);
  }
}

function subscribeToReferencedDocs<T>(
  callback: (value: T) => Cancel | undefined,
  runtime: IRuntime,
  link: NormalizedFullLink,
): Cancel {
  // Get the value once to determine all the docs that need to be subscribed to.
  const tx = runtime.edit();
  const value = validateAndTransform(
    runtime,
    tx,
    link,
    true,
  );
  const log = txToReactivityLog(tx);

  // Call the callback once with initial value.
  let cleanup: Cancel | undefined = callback(value);

  // Technically unnecessary since we don't expect/allow callbacks to sink to
  // write to other cells, and we retry by design anyway below when read data
  // changed. But ideally we enforce read-only as well.
  tx.commit();

  const cancel = runtime.scheduler.subscribe((tx) => {
    if (isCancel(cleanup)) cleanup();

    // Run once with tx to capture _this_ cell's read dependencies.
    validateAndTransform(runtime, tx, link, true);

    // Using a new transaction for the callback, as we're only interested in
    // dependencies for the initial get, not further cells the callback might
    // read. The callback is responsible for calling sink on those cells if it
    // wants to stay updated.

    const extraTx = runtime.edit();

    const newValue = validateAndTransform(runtime, extraTx, link, true);
    cleanup = callback(newValue);

    // no async await here, but that also means no retry. TODO(seefeld): Should
    // we add a retry? So far all sinks are read-only, so they get re-triggered
    // on changes already.
    extraTx.commit();
  }, log);

  return () => {
    cancel();
    if (isCancel(cleanup)) cleanup();
  };
}

export function convertCellsToLinks(
  value: readonly any[] | Record<string, any> | any,
  path: string[] = [],
  seen: Map<any, string[]> = new Map(),
): any {
  if (seen.has(value)) {
    return {
      "/": {
        [LINK_V1_TAG]: { path: seen.get(value) },
      },
    };
  }

  if (isQueryResultForDereferencing(value)) {
    value = getCellOrThrow(value).getAsLink();
  } else if (isCell(value) || isStream(value)) {
    value = value.getAsLink();
  } else if (isRecord(value) || typeof value === "function") {
    // Only add here, otherwise they are literals or already cells:
    seen.set(value, path);

    // Process toJSON if it exists like JSON.stringify does.
    if ("toJSON" in value && typeof value.toJSON === "function") {
      value = value.toJSON();
      if (!isRecord(value)) return value;
      // Fall through to process, so even if there is a .toJSON on the
      // result we don't call it again.
    } else if (typeof value === "function") {
      // Handle functions without toJSON like JSON.stringify does.
      value = undefined;
    }

    // Recursively process arrays and objects.
    if (Array.isArray(value)) {
      value = value.map((value, index) =>
        convertCellsToLinks(value, [...path, String(index)], seen)
      );
    } else {
      value = Object.fromEntries(
        Object.entries(value).map(([key, value]) => [
          key,
          convertCellsToLinks(value, [...path, String(key)], seen),
        ]),
      );
    }
  }

  return value;
}

/**
 * Check if value is a simple cell.
 *
 * @param {any} value - The value to check.
 * @returns {boolean}
 */
export function isCell(value: any): value is Cell<any> {
  return value instanceof RegularCell;
}

/**
 * Type guard to check if a value is a Stream.
 * @param value - The value to check
 * @returns True if the value is a Stream
 */
export function isStream(value: any): value is Stream<any> {
  return value instanceof StreamCell;
}

export type DeepKeyLookup<T, Path extends PropertyKey[]> = Path extends [] ? T
  : Path extends [infer First, ...infer Rest]
    ? First extends keyof T
      ? Rest extends PropertyKey[] ? DeepKeyLookup<T[First], Rest>
      : any
    : any
  : any;
