import { type Immutable, isObject, isRecord } from "@commontools/utils/types";
import type { MemorySpace } from "@commontools/memory/interface";
import { getTopFrame } from "./builder/recipe.ts";
import {
  type AnyCell,
  type Cell,
  ID,
  ID_FIELD,
  type IDFields,
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
import {
  processDefaultValue,
  resolveSchema,
  validateAndTransform,
} from "./schema.ts";
import { toURI } from "./uri-utils.ts";
import { createRef } from "./create-ref.ts";
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
  findAndInlineDataURILinks,
  type NormalizedFullLink,
  type NormalizedLink,
} from "./link-utils.ts";
import type {
  IExtendedStorageTransaction,
  IReadOptions,
} from "./storage/interface.ts";
import { fromURI } from "./uri-utils.ts";
import { ContextualFlowControl } from "./cfc.ts";

/**
 * Module augmentation for runtime-specific cell methods.
 * These augmentations add implementation details specific to the runner runtime.
 */

declare module "@commontools/api" {
  /**
   * Augment Writable to add runtime-specific write methods with onCommit callbacks
   */
  interface IWritable<T> {
    set(
      value: AnyCellWrapping<T> | T,
      onCommit?: (tx: IExtendedStorageTransaction) => void,
    ): void;
  }

  /**
   * Augment Streamable to add onCommit callback support
   */
  interface IStreamable<T> {
    send(
      value: AnyCellWrapping<T> | T,
      onCommit?: (tx: IExtendedStorageTransaction) => void,
    ): void;
  }

  /**
   * Augment Cell to add all internal/system methods that are available
   * on Cell in the runner runtime.
   */
  interface IAnyCell<out T> {
    /**
     * Set a cause for this cell. Used to create a link when the cell doesn't have one yet.
     * @param cause - The cause to associate with this cell
     * @param options - Optional configuration
     * @returns This cell for method chaining
     */
    for(cause: unknown, options?: { force?: boolean }): Cell<T>;
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
        & { [TYPE]: string | undefined }
        & ("argument" extends keyof T ? unknown : { argument: any })
      >
      | undefined;
    getSourceCell<S extends JSONSchema = JSONSchema>(
      schema: S,
    ):
      | Cell<
        & Schema<S>
        & { [TYPE]: string | undefined }
        & ("argument" extends keyof Schema<S> ? unknown : { argument: any })
      >
      | undefined;
    setSourceCell(sourceCell: Cell<any>): void;
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
}

export type { AnyCell, Cell, Stream } from "@commontools/api";
import type {
  AnyCellWrapping,
  AsCell,
  ICell,
  IStreamable,
  KeyResultType,
} from "@commontools/api";

export type { MemorySpace } from "@commontools/memory/interface";

export function createCell<T>(
  runtime: IRuntime,
  link: NormalizedFullLink | undefined,
  tx?: IExtendedStorageTransaction,
  synced = false,
): Cell<T> {
  return new CellImpl(
    runtime,
    link,
    tx,
    synced,
  ) as unknown as Cell<T>; // Cast to set brand
}

/**
 * CellImpl - Unified cell implementation that handles both regular cells and
 * streams.
 */
export class CellImpl<T> implements ICell<T>, IStreamable<T> {
  private readOnlyReason: string | undefined;

  // Stream-specific fields
  private listeners = new Set<
    (event: AnyCellWrapping<T>) => Cancel | undefined
  >();
  private cleanup: Cancel | undefined;

  // Use NormalizedLink which may not have id/space yet
  private _link: NormalizedLink;
  private _cause: unknown | undefined;

  constructor(
    public readonly runtime: IRuntime,
    link: NormalizedLink = { path: [] },
    public readonly tx: IExtendedStorageTransaction | undefined,
    private synced: boolean = false,
    cause?: unknown,
  ) {
    // Always have at least a path
    this._link = link;
    this._cause = cause;
  }

  /**
   * Get the full link for this cell, ensuring it has id and space.
   * This will attempt to create a full link if one doesn't exist and we're in a valid context.
   */
  private get link(): NormalizedFullLink {
    // Check if we have a full link (with id and space)
    if (!this._link.id || !this._link.space) {
      // Try to ensure we have a full link
      this.ensureLink();

      // If still no full link after ensureLink, throw
      if (!this._link.id || !this._link.space) {
        throw new Error(
          "Cell link could not be created. Use .for() to set a cause before accessing the cell.",
        );
      }
    }
    return this._link as NormalizedFullLink;
  }

  /**
   * Check if this cell has a full link (with id and space)
   */
  private hasFullLink(): boolean {
    return this._link.id !== undefined && this._link.space !== undefined;
  }

  /**
   * Set a cause for this cell. This is used to create a link when the cell doesn't have one yet.
   * @param cause - The cause to associate with this cell
   * @param options - Optional configuration
   * @param options.force - If true, will create an extension if cause already exists. If false (default), ignores the call if link already exists.
   * @returns This cell for method chaining
   */
  for(cause: unknown, options?: { force?: boolean }): Cell<T> {
    const force = options?.force ?? false;

    // If full link already exists and force is false, ignore this call
    if (this.hasFullLink() && !force) {
      return this as unknown as Cell<T>;
    }

    // Store the cause
    this._cause = cause;

    // TODO(seefeld): Implement link creation from cause
    // For now, we'll defer link creation until it's actually needed
    // This will be implemented in the "force creation of cause" step

    return this as unknown as Cell<T>;
  }

  /**
   * Force creation of a full link for this cell from the stored cause.
   * This method populates id and space if they don't exist, using information from:
   * - The stored cause (from .for())
   * - The current handler context
   * - Derived information from the graph (for deriving nodes)
   *
   * @throws Error if not in a handler context and no cause was provided
   */
  private ensureLink(): void {
    // If we already have a full link (id and space), nothing to do
    if (this._link.id && this._link.space) {
      return;
    }

    // Check if we're in a handler context
    const frame = getTopFrame();

    // TODO(seefeld): Implement no-cause-but-in-handler case
    if (!frame?.cause || !this._cause) {
      throw new Error(
        "Cannot create cell link: not in a handler context and no cause was provided.\n" +
          "This typically happens when:\n" +
          "  - A cell is passed to another cell's .set() method without a link\n" +
          "  - A cell is used outside of a handler context\n" +
          "Solution: Use .for(cause) to set a cause before using the cell in ambiguous cases.",
      );
    }

    // We need a space to create a link
    // TODO(seefeld): Get space from frame
    if (!this._link.space) {
      throw new Error(
        "Cannot create cell link: space is required.\n" +
          "When creating cells without links, you must provide a space in the link.\n" +
          "Use runtime.getCell() or provide a link with a space when constructing the cell.",
      );
    }

    // Create an entity ID from the cause
    const entityId = createRef({ frame: frame!.cause }, this._cause);

    // Populate the id and type fields (keeping existing path, schema, etc.)
    this._link = {
      ...this._link,
      id: toURI(entityId),
      type: this._link.type ?? "application/json",
    };
  }

  get space(): MemorySpace {
    return this.link.space;
  }

  get path(): readonly PropertyKey[] {
    return this.link.path;
  }

  get schema(): JSONSchema | undefined {
    if (!this._link) return undefined;

    if (this.link.schema) return this.link.schema;

    // If no schema is defined, resolve link and get schema from there (which is
    // what .get() would do).
    const resolvedLink = resolveLink(
      this.runtime.readTx(this.tx),
      this.link,
      "writeRedirect",
    );
    return resolvedLink.schema;
  }

  get rootSchema(): JSONSchema | undefined {
    if (!this._link) return undefined;

    if (this.link.rootSchema) return this.link.rootSchema;

    // If no root schema is defined, resolve link and get root schema from there
    // (which is what .get() would do).
    const resolvedLink = resolveLink(
      this.runtime.readTx(this.tx),
      this.link,
      "writeRedirect",
    );
    return resolvedLink.rootSchema;
  }

  /**
   * Check if this cell contains a stream value
   */
  private isStream(resolvedToValueLink?: NormalizedFullLink): boolean {
    const tx = this.runtime.readTx(this.tx);

    if (!resolvedToValueLink) {
      resolvedToValueLink = resolveLink(tx, this.link);
    }

    const value = tx.readValueOrThrow(resolvedToValueLink, {
      meta: ignoreReadForScheduling,
    });
    return isStreamValue(value);
  }

  get(): Readonly<T> {
    if (!this.synced) this.sync(); // No await, just kicking this off
    return validateAndTransform(this.runtime, this.tx, this.link, this.synced);
  }

  set(
    newValue: AnyCellWrapping<T> | T,
    onCommit?: (tx: IExtendedStorageTransaction) => void,
  ): void {
    const resolvedToValueLink = resolveLink(
      this.runtime.readTx(this.tx),
      this.link,
    );

    // Check if we're dealing with a stream
    if (this.isStream(resolvedToValueLink)) {
      // Stream behavior
      const event = convertCellsToLinks(newValue) as AnyCellWrapping<T>;

      // Trigger on fully resolved link
      this.runtime.scheduler.queueEvent(
        resolvedToValueLink,
        event,
        undefined,
        onCommit,
      );

      this.cleanup?.();
      const [cancel, addCancel] = useCancelGroup();
      this.cleanup = cancel;

      this.listeners.forEach((callback) => addCancel(callback(event)));
      return;
    }

    // Regular cell behavior
    if (!this.tx) throw new Error("Transaction required for set");

    // No await for the sync, just kicking this off, so we have the data to
    // retry on conflict.
    if (!this.synced) this.sync();

    // Looks for arrays and makes sure each object gets its own doc.
    const transformedValue = recursivelyAddIDIfNeeded(newValue);

    // TODO(@ubik2) investigate whether i need to check classified as i walk down my own obj
    diffAndUpdate(
      this.runtime,
      this.tx,
      resolveLink(this.tx, this.link, "writeRedirect"),
      transformedValue,
      getTopFrame()?.cause,
    );

    // Register commit callback if provided
    if (onCommit) {
      this.tx.addCommitCallback(onCommit);
    }
  }

  send(
    event: AnyCellWrapping<T>,
    onCommit?: (tx: IExtendedStorageTransaction) => void,
  ): void {
    this.set(event, onCommit);
  }

  update<V extends (Partial<T> | AnyCellWrapping<Partial<T>>)>(
    values: V extends object ? AnyCellWrapping<V> : never,
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

    // If there's no current value, initialize based on schema, even if there is
    // no default value.
    if (currentValue === undefined) {
      const resolvedSchema = resolveSchema(this.schema, this.rootSchema);

      // TODO(seefeld,ubik2): This should all be moved to schema helpers. This
      // just wants to know whether the value could be an object.
      const allowsObject = resolvedSchema === undefined ||
        ContextualFlowControl.isTrueSchema(resolvedSchema) ||
        (isObject(resolvedSchema) &&
          (resolvedSchema.type === "object" ||
            (Array.isArray(resolvedSchema.type) &&
              resolvedSchema.type.includes("object")) ||
            (resolvedSchema.anyOf &&
              resolvedSchema.anyOf.some((s) =>
                typeof s === "object" && s.type === "object"
              ))));

      if (!allowsObject) {
        throw new Error(
          "Cannot update with object value - schema does not allow objects",
        );
      }

      this.tx.writeValueOrThrow(resolvedLink, {});
    }

    // Now update each property
    for (const [key, value] of Object.entries(values)) {
      (this as unknown as Cell<any>).key(key).set(value);
    }
  }

  push(
    ...value: T extends (infer U)[] ? (U | AnyCellWrapping<U>)[] : never
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
      const resolvedSchema = resolveSchema(this.schema, this.rootSchema);
      array = isObject(resolvedSchema) && Array.isArray(resolvedSchema?.default)
        ? processDefaultValue(
          this.runtime,
          this.tx,
          this.link,
          resolvedSchema.default,
        )
        : [];
    }

    // Append the new values to the array.
    diffAndUpdate(
      this.runtime,
      this.tx,
      resolvedLink,
      recursivelyAddIDIfNeeded([...array, ...value]),
      cause,
    );
  }

  equals(other: any): boolean {
    return areLinksSame(this, other);
  }

  key<K extends PropertyKey>(
    valueKey: K,
  ): KeyResultType<T, K, AsCell> {
    // Get child schema if we have one
    const childSchema = this._link.schema
      ? this.runtime.cfc.getSchemaAtPath(
        this._link.schema,
        [valueKey.toString()],
        this._link.rootSchema,
      )
      : undefined;

    // Build up the path even without a full link
    const childLink: NormalizedLink = {
      ...this._link,
      path: [...this._link.path, valueKey.toString()] as string[],
      ...(childSchema && { schema: childSchema }),
    };

    return new CellImpl(
      this.runtime,
      childLink,
      this.tx,
      this.synced,
      this._cause, // Inherit cause
    ) as unknown as KeyResultType<T, K, AsCell>;
  }

  asSchema<S extends JSONSchema = JSONSchema>(
    schema: S,
  ): Cell<Schema<S>>;
  asSchema<T>(
    schema?: JSONSchema,
  ): Cell<T>;
  asSchema(schema?: JSONSchema): Cell<any> {
    return new CellImpl(
      this.runtime,
      { ...this.link, schema: schema, rootSchema: schema },
      this.tx,
      false, // Reset synced flag, since schema is changing
    ) as unknown as Cell<any>;
  }

  withTx(newTx?: IExtendedStorageTransaction): Cell<T> {
    // For streams, this is a no-op, but we still create a new instance
    return new CellImpl(
      this.runtime,
      this.link,
      newTx,
      this.synced,
    ) as unknown as Cell<T>;
  }

  sink(callback: (value: Readonly<T>) => Cancel | undefined): Cancel {
    // Check if this is a stream
    if (this.isStream()) {
      // Stream behavior: add listener
      this.listeners.add(
        callback as (event: AnyCellWrapping<T>) => Cancel | undefined,
      );
      return () =>
        this.listeners.delete(
          callback as (event: AnyCellWrapping<T>) => Cancel | undefined,
        );
    } else {
      // Regular cell behavior: subscribe to changes
      if (!this.synced) this.sync(); // No await, just kicking this off
      return subscribeToReferencedDocs(callback, this.runtime, this.link);
    }
  }

  sync(): Promise<Cell<T>> | Cell<T> {
    this.synced = true;
    if (this.link.id.startsWith("data:")) {
      return this as unknown as Cell<T>;
    }
    return this.runtime.storageManager.syncCell<T>(this as unknown as Cell<T>);
  }

  resolveAsCell(): Cell<T> {
    const link = resolveLink(this.runtime.readTx(this.tx), this.link);
    return createCell(this.runtime, link, this.tx, this.synced);
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

    const tx = this.runtime.readTx(this.tx);
    // Resolve all links ON THE WAY to the target, but don't resolve the final link
    return tx.readValueOrThrow(resolveLink(tx, this.link, "top"), options) as
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
    this.tx.writeValueOrThrow(this.link, findAndInlineDataURILinks(value));
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

/**
 * Recursively adds IDs elements in arrays, unless they are already a link.
 *
 * This ensures that mutable arrays only consist of links to documents, at least
 * when written to only via .set, .update and .push above.
 *
 * TODO(seefeld): When an array has default entries and is rewritten as [...old,
 * new], this will still break, because the previous entries will point back to
 * the array itself instead of being new entries.
 *
 * @param value - The value to add IDs to.
 * @returns The value with IDs added.
 */
function recursivelyAddIDIfNeeded<T>(
  value: T,
  seen: Map<unknown, unknown> = new Map(),
): T {
  // Can't add IDs without top frame.
  if (!getTopFrame()) return value;

  // Not a record, no need to add IDs. Already a link, no need to add IDs.
  if (!isRecord(value) || isLink(value)) return value;

  // Already seen, return previously annotated result.
  if (seen.has(value)) return seen.get(value) as T;

  if (Array.isArray(value)) {
    const result: unknown[] = [];

    // Set before traversing, otherwise we'll infinite recurse.
    seen.set(value, result);

    result.push(...value.map((v) => {
      const value = recursivelyAddIDIfNeeded(v, seen);
      // For objects on arrays only: Add ID if not already present.
      if (
        isObject(value) && !isLink(value) && !(ID in value)
      ) {
        return { [ID]: getTopFrame()!.generatedIdCounter++, ...value };
      } else {
        return value;
      }
    }));
    return result as T;
  } else {
    const result: Record<string, unknown> = {};

    // Set before traversing, otherwise we'll infinite recurse.
    seen.set(value, result);

    Object.entries(value).forEach(([key, v]) => {
      result[key] = recursivelyAddIDIfNeeded(v, seen);
    });

    // Copy supported symbols from original value.
    [ID, ID_FIELD].forEach((symbol) => {
      if (symbol in value) {
        (result as IDFields)[symbol as keyof IDFields] =
          value[symbol as keyof IDFields];
      }
    });

    return result as T;
  }
}

/**
 * Converts cells and objects that can be turned to cells to links.
 *
 * @param value - The value to convert.
 * @returns The converted value.
 */
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
  } else if (isCell(value)) {
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
  return value instanceof CellImpl;
}

/**
 * Check if value is any kind of cell.
 *
 * @param {any} value - The value to check.
 * @returns {boolean}
 */
export function isAnyCell(value: any): value is AnyCell<any> {
  return value instanceof CellImpl;
}

/**
 * Type guard to check if a value is a Stream.
 * @param value - The value to check
 * @returns True if the value is a Stream
 */
export function isStream<T = any>(value: any): value is Stream<T> {
  return (value instanceof CellImpl && (value as any).isStream?.());
}

export type DeepKeyLookup<T, Path extends PropertyKey[]> = Path extends [] ? T
  : Path extends [infer First, ...infer Rest]
    ? First extends keyof T
      ? Rest extends PropertyKey[] ? DeepKeyLookup<T[First], Rest>
      : any
    : any
  : any;
