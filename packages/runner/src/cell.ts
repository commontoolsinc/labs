import {
  type Immutable,
  isFunction,
  isObject,
  isRecord,
} from "@commontools/utils/types";
import {
  toDeepStorableValue,
  toStorableValue,
} from "@commontools/memory/storable-value";
import type { MemorySpace } from "@commontools/memory/interface";
import { getTopFrame, recipe } from "./builder/recipe.ts";
import { createNodeFactory } from "./builder/module.ts";
import {
  type AnyCell,
  type AnyCellWrapping,
  type Apply,
  type Cell,
  type CellKind,
  type CellTypeConstructor,
  type Frame,
  type HKT,
  type ICell,
  ID,
  ID_FIELD,
  type IDFields,
  isStreamValue,
  type IsThisObject,
  type IStreamable,
  type JSONSchema,
  type NodeFactory,
  type NodeRef,
  type Opaque,
  type OpaqueCell,
  type OpaqueRef,
  type RecipeFactory,
  type Schema,
  SELF,
  type Stream,
  TYPE,
} from "./builder/types.ts";
import { toCell } from "./back-to-cell.ts";
import { isOpaqueRefMarker } from "./builder/types.ts";
import {
  type CellResult,
  createQueryResultProxy,
  getCellOrThrow,
  isCellResultForDereferencing,
} from "./query-result-proxy.ts";
import { diffAndUpdate } from "./data-updating.ts";
import { resolveLink } from "./link-resolution.ts";
import {
  type Action,
  ignoreReadForScheduling,
  txToReactivityLog,
} from "./scheduler.ts";
import { type Cancel, isCancel, useCancelGroup } from "./cancel.ts";
import {
  processDefaultValue,
  resolveSchema,
  validateAndTransform,
} from "./schema.ts";
import { toURI } from "./uri-utils.ts";
import { createRef } from "./create-ref.ts";
import {
  LINK_V1_TAG,
  type SigilLink,
  type SigilWriteRedirectLink,
  type URI,
} from "./sigil-types.ts";
import type { Runtime } from "./runtime.ts";
import {
  areLinksSame,
  createSigilLinkFromParsedLink,
  findAndInlineDataURILinks,
  isCellLink,
  type NormalizedFullLink,
  type NormalizedLink,
} from "./link-utils.ts";
import type {
  ChangeGroup,
  IExtendedStorageTransaction,
  IReadOptions,
} from "./storage/interface.ts";
import {
  createChildCellTransaction,
  createNonReactiveTransaction,
} from "./storage/extended-storage-transaction.ts";
import { fromURI } from "./uri-utils.ts";
import { ContextualFlowControl } from "./cfc.ts";
import { getLogger } from "@commontools/utils/logger";
import { ensureNotRenderThread } from "@commontools/utils/env";
ensureNotRenderThread();

const logger = getLogger("cell");

type SinkOptions = {
  changeGroup?: ChangeGroup;
};

// Shared map factory instance for all cells
let mapFactory: NodeFactory<any, any> | undefined;

// WeakMap to store connected nodes for each cell instance
const cellNodes = new WeakMap<OpaqueCell<unknown>, Set<NodeRef>>();

/**
 * Module augmentation for runtime-specific cell methods.
 * These augmentations add implementation details specific to the runner runtime.
 */

declare module "@commontools/api" {
  /**
   * Augment Writable to add runtime-specific write methods with onCommit callbacks
   */
  interface IWritable<T, C extends AnyBrandedCell<any>> {
    set(
      value: AnyCellWrapping<T> | T,
      onCommit?: (tx: IExtendedStorageTransaction) => void,
    ): C;
  }

  /**
   * Augment Streamable to add onCommit callback support.
   * Event is optional only when T is void (matching public API).
   */
  interface IStreamable<T> {
    send(
      ...args: T extends void ? [] | [AnyCellWrapping<T> | T] | [
          AnyCellWrapping<T> | T,
          (tx: IExtendedStorageTransaction) => void,
        ]
        : [AnyCellWrapping<T> | T] | [
          AnyCellWrapping<T> | T,
          (tx: IExtendedStorageTransaction) => void,
        ]
    ): void;
  }

  /**
   * Augment Cell to add all internal/system methods that are available
   * on Cell in the runner runtime.
   */
  interface IAnyCell<out T> {
    asSchema<S extends JSONSchema = JSONSchema>(
      schema: S,
    ): Cell<Schema<S>>;
    asSchema<T>(
      schema?: JSONSchema,
      rootSchema?: JSONSchema,
    ): Cell<T>;
    asSchemaFromLinks<T = unknown>(): Cell<T>;
    withTx(tx?: IExtendedStorageTransaction): Cell<T>;
    sink(
      callback: (value: Readonly<T>) => Cancel | undefined | void,
      options?: SinkOptions,
    ): Cancel;
    sync(): Promise<Cell<T>> | Cell<T>;
    pull(): Promise<Readonly<T>>;
    getAsQueryResult<Path extends PropertyKey[]>(
      path?: Readonly<Path>,
      tx?: IExtendedStorageTransaction,
      writable?: boolean,
    ): CellResult<DeepKeyLookup<T, Path>>;
    getAsNormalizedFullLink(): NormalizedFullLink;
    getAsLink(
      options?: {
        base?: Cell<any>;
        baseSpace?: MemorySpace;
        includeSchema?: boolean;
        keepStreams?: boolean;
        keepAsCell?: boolean;
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
    setSchema(newSchema: JSONSchema): void;
    connect(node: NodeRef): void;
    export(): {
      cell: OpaqueCell<any>;
      path: readonly PropertyKey[];
      schema?: JSONSchema;
      rootSchema?: JSONSchema;
      nodes: Set<NodeRef>;
      frame: Frame;
      value?: Opaque<T> | T;
      name?: string;
      external?: unknown;
    };
    getAsOpaqueRefProxy(
      boundTarget?: (...args: unknown[]) => unknown,
    ): OpaqueRef<T>;
    toJSON(): SigilLink | null;
    runtime: Runtime;
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

    // TODO(seefeld): Remove once default schemas are properly propagated
    setInitialValue(value: T): void;

    /** Set the self-reference for SELF symbol support in patterns */
    setSelfRef(selfRef: OpaqueRef<any>): void;
  }

  interface ICreatable<C extends AnyBrandedCell<any>> {
    for(cause: unknown, allowIfSet?: boolean): C;
  }
}

export type { AnyCell, Cell, Stream } from "@commontools/api";

export type { MemorySpace } from "@commontools/memory/interface";

const cellMethods = new Set<keyof ICell<unknown>>([
  "get",
  "sample",
  "set",
  "send",
  "update",
  "push",
  "remove",
  "removeAll",
  "equals",
  "equalLinks",
  "key",
  "map",
  "mapWithPattern",
  "toJSON",
  "for",
  "asSchema",
  "withTx",
  "sink",
  "sync",
  "pull",
  "getAsQueryResult",
  "getAsNormalizedFullLink",
  "getAsLink",
  "getAsWriteRedirectLink",
  "getRaw",
  "setRaw",
  "getSourceCell",
  "setSourceCell",
  "getArgumentCell",
  "freeze",
  "isFrozen",
  "setSchema",
  "connect",
  "export",
  "getAsOpaqueRefProxy",
  "setInitialValue",
  "setSelfRef",
]);

export function createCell<T>(
  runtime: Runtime,
  link?: NormalizedLink,
  tx?: IExtendedStorageTransaction,
  synced = false,
  kind?: CellKind,
): Cell<T> {
  return new CellImpl(
    runtime,
    tx,
    link, // Pass the link directly (or undefined)
    synced,
    undefined, // No shared causeContainer
    kind,
  ) as unknown as Cell<T>; // Cast to set brand
}

/**
 * Shared container for entity ID and cause information across sibling cells.
 * When cells are created via .asSchema(), .withTx(), they share the same
 * logical identity (same entity id) but may have different paths or schemas.
 * The container stores only the entity reference parts that need to be synchronized.
 */
interface CauseContainer {
  // Root cell that created this cause container
  cell: OpaqueCell<unknown>;
  // Entity reference - shared across all siblings
  id: URI | undefined;
  space: MemorySpace | undefined;
  // Cause for creating the entity ID
  cause: unknown | undefined;
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

  // Each cell has its own link (space, path, schema)
  private _link: NormalizedLink;

  // Shared container for entity ID and cause - siblings share the same instance
  private _causeContainer: CauseContainer;

  private _frame: Frame | undefined;

  private _kind: CellKind;

  // Self-reference for pattern SELF symbol support
  private _selfRef?: OpaqueRef<any>;

  constructor(
    public readonly runtime: Runtime,
    public readonly tx: IExtendedStorageTransaction | undefined,
    link?: NormalizedLink,
    private synced: boolean = false,
    causeContainer?: CauseContainer,
    kind?: CellKind,
  ) {
    this._frame = getTopFrame();

    // Store this cell's own link
    this._link = link ?? { path: [], type: "application/json" };
    if (!this._link.type) {
      this._link = { ...this._link, type: "application/json" };
    }

    // Use provided container or create one
    // If link has an id, extract it to the container
    this._causeContainer = causeContainer ?? {
      cell: this as unknown as OpaqueCell<unknown>,
      id: this._link.id,
      space: this._link.space,
      cause: undefined,
    };

    this._kind = kind ?? "cell";
  }

  /**
   * Get the full link for this cell, ensuring it has id and space.
   * This will attempt to create a full link if one doesn't exist and we're in a valid context.
   */
  private get link(): NormalizedFullLink {
    // Check if we have a full entity ID and space
    if (!this.hasFullLink()) {
      // Try to ensure we have a full link
      this.ensureLink();

      // If still no full link after ensureLink, throw
      if (!this.hasFullLink()) {
        throw new Error(
          "Cell link creation failed - no cause or context\n" +
            "help: use .for(uniqueId) to set explicit identity, or create cells within handler/pattern contexts",
        );
      }
    }

    // Combine causeContainer id with link's space/path/schema
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
   * This affects all sibling cells (created via .key(), .asSchema(), .withTx()) since they
   * share the same container.
   * @param cause - The cause to associate with this cell
   * @param allowIfSet - If true, treat as suggestion and silently ignore if cause already set. If false (default), throw error if cause already set.
   * @returns This cell for method chaining
   */
  for(cause: unknown, allowIfSet?: boolean): Cell<T> {
    // If cause or id already exists, either fail or silently ignore based on allowIfSet
    if (this._causeContainer.id || this._causeContainer.cause) {
      if (allowIfSet) {
        // Treat as suggestion - silently ignore
        return this as unknown as Cell<T>;
      } else {
        // Fail by default
        throw new Error(
          "Cannot set cause: cell already has a cause or link.",
        );
      }
    }

    // Store the cause in the shared container - all siblings will see this
    this._causeContainer.cause = cause;

    return this as unknown as Cell<T>;
  }

  /**
   * Force creation of a full link for this cell from the stored cause.
   * This method populates id if it doesn't exist, using information from:
   * - The stored cause (from .for())
   * - The current handler context
   * - Derived information from the graph (for deriving nodes)
   *
   * Updates the shared causeContainer, so all siblings will see the new id.
   *
   * @throws Error if not in a handler context and no cause was provided
   */
  private ensureLink(): void {
    // If we already have a full link (id and space) in the container, just copy
    // it over to our link.
    if (this._causeContainer.id && this._causeContainer.space) {
      this._link = {
        ...this._link,
        id: this._causeContainer.id,
        space: this._causeContainer.space,
      };
      return;
    }

    // Otherwise, let's attempt to derive the id:

    // We must be in a frame context to derive the id.
    if (!this._frame) {
      throw new Error(
        "Cannot create cell link - no frame context\n" +
          "help: create cells inside pattern/handler/lift, or use .for(cause) for explicit identity",
      );
    }

    const space = this._link.space ?? this._causeContainer.space ??
      this._frame?.space;

    // We need a space to create a link
    if (!space) {
      throw new Error(
        "Cannot create cell link - space required\n" +
          "help: use computed() to handle closures automatically, or pass cells as explicit parameters",
      );
    }

    // Used passed in cause (via .for()), for events fall back to per-frame
    // counter.
    const cause = this._causeContainer.cause ??
      (this._frame.inHandler
        ? { count: this._frame.generatedIdCounter++ }
        : undefined);

    if (!cause) {
      throw new Error(
        "Cannot create cell link - not in handler context and no cause provided\n" +
          "help: use .for(cause) for explicit identity, or create cells within handlers where identity is automatic",
      );
    }

    // Create an entity ID from the cause, including the frame's
    const id = toURI(createRef({ frame: cause }, this._frame.cause));

    // Populate the id in the shared causeContainer
    // All siblings will see this update
    this._causeContainer.id = id;
    this._causeContainer.space = space;

    // Update this cell's link
    this._link = { ...this._link, id, space };
  }

  get space(): MemorySpace {
    return this._link.space ?? this._causeContainer.space ??
      this._frame?.space!;
  }

  get path(): readonly PropertyKey[] {
    return this._link.path;
  }

  get schema(): JSONSchema | undefined {
    if (this._link.schema !== undefined) return this._link.schema;

    // If no schema is defined, resolve link and get schema from there (which is
    // what .get() would do).
    if (this.hasFullLink()) {
      const resolvedLink = resolveLink(
        this.runtime,
        this.runtime.readTx(this.tx),
        this.link,
        "writeRedirect",
      );
      return resolvedLink.schema;
    }

    return undefined;
  }

  get rootSchema(): JSONSchema | undefined {
    if (this._link.rootSchema !== undefined) return this._link.rootSchema;

    // If no root schema is defined, resolve link and get root schema from there
    // (which is what .get() would do).
    if (this.hasFullLink()) {
      const resolvedLink = resolveLink(
        this.runtime,
        this.runtime.readTx(this.tx),
        this.link,
        "writeRedirect",
      );
      return resolvedLink.rootSchema;
    }

    return undefined;
  }

  /**
   * Check if this cell contains a stream value
   */
  private isStream(resolvedToValueLink?: NormalizedFullLink): boolean {
    const tx = this.runtime.readTx(this.tx);

    if (!resolvedToValueLink) {
      resolvedToValueLink = resolveLink(this.runtime, tx, this.link);
    }

    const value = tx.readValueOrThrow(resolvedToValueLink, {
      meta: ignoreReadForScheduling,
    });
    return isStreamValue(value);
  }

  get(options?: { traverseCells?: boolean }): Readonly<T> {
    if (!this.synced) this.sync(); // No await, just kicking this off
    logger.timeStart("cell", "get");
    const value = validateAndTransform(
      this.runtime,
      this.tx,
      this.link,
      [],
      options,
    );
    const elapsed = logger.timeEnd("cell", "get")!;
    if (elapsed > 50) {
      logger.warn(
        `get >${Math.floor(elapsed - (elapsed % 10))}ms`,
        `get() took ${Math.floor(elapsed)}ms`,
        this.link,
      );
    }
    return value;
  }

  /**
   * Read the cell's current value without creating a reactive dependency.
   * Unlike `get()`, calling `sample()` inside a handler won't cause the handler
   * to re-run when this cell's value changes.
   *
   * Use this when you need to read a value but don't want changes to that value
   * to trigger re-execution of the current reactive context.
   */
  sample(): Readonly<T> {
    if (!this.synced) this.sync(); // No await, just kicking this off

    // Wrap the transaction to make all reads non-reactive. Child cells created
    // during validateAndTransform will use the original transaction (via
    // getTransactionForChildCells).
    const readTx = this.runtime.readTx(this.tx);
    const nonReactiveTx = createNonReactiveTransaction(readTx);

    return validateAndTransform(this.runtime, nonReactiveTx, this.link);
  }

  /**
   * Pull the cell's value, ensuring all dependencies are computed first.
   *
   * In pull-based scheduling mode, computations don't run automatically when
   * their inputs change - they only run when pulled by an effect. This method
   * registers a temporary effect that reads the cell's value, triggering the
   * scheduler to compute all transitive dependencies first.
   *
   * In push-based mode (the default), this is equivalent to `await idle()`
   * followed by `get()`, but ensures consistent behavior across both modes.
   *
   * Use this in tests or when you need to ensure a computed value is up-to-date
   * before reading it:
   *
   * ```ts
   * // Instead of:
   * await runtime.scheduler.idle();
   * const value = cell.get();
   *
   * // Use:
   * const value = await cell.pull();
   * ```
   *
   * @returns A promise that resolves to the cell's current value after all
   *          dependencies have been computed.
   */
  pull(): Promise<Readonly<T>> {
    if (!this.synced) this.sync(); // No await, just kicking this off

    // Check if we need to traverse the result to register all dependencies.
    // This is needed when there's no schema or when the schema is TrueSchema ("any"),
    // because without schema constraints we need to read all nested values.
    const schema = this._link.schema;
    const needsTraversal = schema === undefined ||
      ContextualFlowControl.isTrueSchema(schema);

    return new Promise((resolve) => {
      let result: Readonly<T>;

      const action: Action = (tx) => {
        // Read the value inside the effect - this ensures dependencies are pulled
        result = validateAndTransform(this.runtime, tx, this.link);

        // If no schema or TrueSchema, traverse the result to register all
        // nested values as read dependencies.
        if (needsTraversal && result !== undefined && result !== null) {
          deepTraverse(result);
        }
      };
      // Name the action for debugging
      Object.defineProperty(action, "name", {
        value: `pull:${this.sourceURI}`,
        configurable: true,
      });
      // Also set .src as backup (name can be finicky)
      (action as Action & { src?: string }).src = `pull:${this.sourceURI}`;

      // Subscribe as an effect so it runs in the next cycle.
      const cancel = this.runtime.scheduler.subscribe(action, action, {
        isEffect: true,
      });

      // Wait for the scheduler to process all pending work, then resolve
      this.runtime.scheduler.idle().then(() => {
        cancel?.();
        resolve(result);
      });
    });
  }

  set(
    newValue: AnyCellWrapping<T> | T,
    onCommit?: (tx: IExtendedStorageTransaction) => void,
  ): Cell<T> {
    const resolvedToValueLink = resolveLink(
      this.runtime,
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
    } else {
      // Regular cell behavior
      if (!this.tx) {
        throw new Error(
          "Transaction required for .set() - mutations only work in handlers\n" +
            "help: use handler() to create transaction context, or computed() for read-only transformations",
        );
      }

      // No await for the sync, just kicking this off, so we have the data to
      // retry on conflict.
      if (!this.synced) this.sync();

      // Looks for arrays and makes sure each object gets its own doc.
      const transformedValue = recursivelyAddIDIfNeeded(newValue, this._frame);

      // TODO(@ubik2) investigate whether i need to check classified as i walk down my own obj
      diffAndUpdate(
        this.runtime,
        this.tx,
        resolveLink(this.runtime, this.tx, this.link, "writeRedirect"),
        transformedValue,
        this._frame?.cause,
      );

      // Register commit callback if provided
      if (onCommit) {
        this.tx.addCommitCallback(onCommit);
      }
    }

    return this as unknown as Cell<T>;
  }

  send(
    ...args: T extends void ? [] | [AnyCellWrapping<T>] | [
        AnyCellWrapping<T>,
        (tx: IExtendedStorageTransaction) => void,
      ]
      : [AnyCellWrapping<T>] | [
        AnyCellWrapping<T>,
        (tx: IExtendedStorageTransaction) => void,
      ]
  ): void {
    const [event, onCommit] = args;
    this.set(event as AnyCellWrapping<T>, onCommit);
  }

  update<V extends (Partial<T> | AnyCellWrapping<Partial<T>>)>(
    values: V extends object ? AnyCellWrapping<V> : never,
  ): Cell<T> {
    if (!this.tx) {
      throw new Error(
        "Cell.update() requires transaction and object value\n" +
          "help: use in handlers for partial updates, or .set() for non-object values",
      );
    }
    if (!isRecord(values)) {
      throw new Error(
        "Cell.update() requires transaction and object value\n" +
          "help: use in handlers for partial updates, or .set() for non-object values",
      );
    }

    // No await for the sync, just kicking this off, so we have the data to
    // retry on conflict.
    if (!this.synced) this.sync();

    // Get current value, following aliases and references
    const resolvedLink = resolveLink(this.runtime, this.tx, this.link);
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

    return this as unknown as Cell<T>;
  }

  push(
    ...value: T extends (infer U)[] ? (U | AnyCellWrapping<U>)[] : never
  ): void {
    if (!this.tx) {
      throw new Error(
        "Cell.push() requires transaction and array value\n" +
          "help: use in handlers only, ensure cell is typed as array",
      );
    }

    // No await for the sync, just kicking this off, so we have the data to
    // retry on conflict.
    if (!this.synced) this.sync();

    // Follow aliases and references, since we want to get to an assumed
    // existing array.
    const resolvedLink = resolveLink(this.runtime, this.tx, this.link);
    const currentValue = this.tx.readValueOrThrow(resolvedLink);
    const cause = this._frame?.cause;

    let array = currentValue as unknown[];
    if (array !== undefined && !Array.isArray(array)) {
      throw new Error(
        "Cell.push() requires transaction and array value\n" +
          "help: use in handlers only, ensure cell is typed as array",
      );
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
      recursivelyAddIDIfNeeded([...array, ...value], this._frame),
      cause,
    );
  }

  remove(
    ref: T extends (infer U)[] ? (U | AnyCell<U>) : never,
  ): void {
    const array = this.get();
    if (!Array.isArray(array)) {
      throw new Error("Can't remove from non-array value");
    }
    const index = typeof ref === "object"
      ? array.findIndex((item) =>
        areLinksSame(
          item,
          ref,
          this as unknown as Cell<any>,
          true, // resolveBeforeComparing
          this.tx,
          this.runtime,
        )
      )
      : array.indexOf(ref);
    if (index === -1) {
      return;
    }
    const newArray = [
      ...array.slice(0, index),
      ...array.slice(index + 1),
    ] as T;
    this.set(newArray);
  }

  removeAll(
    ref: T extends (infer U)[] ? (U | AnyCell<U>) : never,
  ): void {
    const array = this.get();
    if (!Array.isArray(array)) {
      throw new Error("Can't remove from non-array value");
    }
    const newArray = array.filter((item) =>
      typeof ref === "object"
        ? !areLinksSame(
          item,
          ref,
          this as unknown as Cell<any>,
          true, // resolveBeforeComparing
          this.tx,
          this.runtime,
        )
        : item !== ref
    ) as T;
    this.set(newArray);
  }

  equals(other: any): boolean {
    return areLinksSame(
      this,
      other,
      undefined,
      true,
      this.runtime.readTx(this.tx),
      this.runtime,
    );
  }

  equalLinks(other: any): boolean {
    return areLinksSame(this, other);
  }

  /**
   * Navigate to nested properties by one or more keys.
   *
   * @example
   * cell.key("user")                      // Cell<User>
   * cell.key("user", "profile")           // Cell<Profile>
   * cell.key("user", "profile", "name")   // Cell<string>
   */
  key(...keys: PropertyKey[]): Cell<any> {
    let currentLink = this._link;
    let childSchema: JSONSchema | undefined;

    for (const key of keys) {
      // Get child schema if we have one
      childSchema = currentLink.schema
        ? this.runtime.cfc.getSchemaAtPath(
          currentLink.schema,
          [key.toString()],
          currentLink.rootSchema,
        )
        : undefined;

      // Create a child link with extended path
      // When we have a childSchema, we need to preserve the rootSchema that contains $defs
      // for resolving $ref references. If rootSchema wasn't set, fall back to the parent schema.
      currentLink = {
        ...currentLink,
        path: [...currentLink.path, key.toString()] as string[],
        schema: childSchema,
        rootSchema: childSchema
          ? (currentLink.rootSchema ?? currentLink.schema)
          : undefined,
      };
    }

    // Determine the kind based on schema flags
    let kind: CellKind = this._kind;
    if (isObject(childSchema)) {
      if (childSchema.asStream) {
        kind = "stream";
      } else if (childSchema.asCell) {
        kind = "cell";
      }
    }

    return new CellImpl(
      this.runtime,
      this.tx,
      currentLink,
      this.synced,
      this._causeContainer,
      kind,
    ) as unknown as Cell<any>;
  }

  asSchema<S extends JSONSchema = JSONSchema>(
    schema: S,
  ): Cell<Schema<S>>;
  asSchema<T>(
    schema?: JSONSchema,
    rootSchema?: JSONSchema,
  ): Cell<T>;
  asSchema(schema?: JSONSchema, rootSchema?: JSONSchema): Cell<any> {
    // asSchema creates a sibling with same identity but different schema
    // Create a new link with modified schema
    const siblingLink: NormalizedLink = {
      ...this._link,
      schema: schema,
      rootSchema: rootSchema ?? schema,
    };

    return new CellImpl(
      this.runtime,
      this.tx,
      siblingLink,
      false, // Reset synced flag, since schema is changing
      this._causeContainer, // Share the causeContainer with siblings
      this._kind,
    ) as unknown as Cell<any>;
  }

  /**
   * Follow all links, even beyond write redirects to get final schema.
   *
   * If there is none look for resultSchema of associated pattern.
   *
   * Otherwise the link stays the same, i.e. it does not advance to resolved
   * link.
   *
   * Note: That means that the schema might change if the link behind it change.
   * The reads are logged though, so should trigger reactive flows.
   *
   * @returns Cell with schema from links
   */
  asSchemaFromLinks<T = unknown>(): Cell<T> {
    if (!this.synced) this.sync(); // Auto-sync like .get() - matches framework pattern

    let { schema, rootSchema } = resolveLink(
      this.runtime,
      this.runtime.readTx(this.tx),
      this.link,
    );

    if (!schema) {
      const sourceCell = this.getSourceCell<{ resultRef: Cell<unknown> }>({
        type: "object",
        properties: { resultRef: { asCell: true } },
      });
      const sourceCellSchema = sourceCell?.key("resultRef").get()?.schema;
      if (sourceCellSchema !== undefined) {
        schema = this.runtime.cfc.schemaAtPath(
          sourceCellSchema,
          this._link.path,
          sourceCellSchema,
        );
        rootSchema = sourceCellSchema;
      }
    }

    return new CellImpl(
      this.runtime,
      this.tx,
      {
        ...this._link,
        ...(schema !== undefined && { schema }),
        ...(rootSchema !== undefined && { rootSchema }),
      },
      false, // Reset synced flag, since schema is changing
      this._causeContainer, // Share the causeContainer with siblings
      this._kind,
    ) as unknown as Cell<T>;
  }

  withTx(newTx?: IExtendedStorageTransaction): Cell<T> {
    // withTx creates a sibling with same identity but different transaction
    // Share the causeContainer so .for() calls propagate
    return new CellImpl(
      this.runtime,
      newTx,
      this._link, // Use the same link
      this.synced,
      this._causeContainer, // Share the causeContainer with siblings
      this._kind,
    ) as unknown as Cell<T>;
  }

  sink(
    callback: (value: Readonly<T>) => Cancel | undefined | void,
    options: SinkOptions = {},
  ): Cancel {
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
      return subscribeToReferencedDocs(
        callback,
        this.runtime,
        this.link,
        options,
      );
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
    const link = resolveLink(
      this.runtime,
      this.runtime.readTx(this.tx),
      this.link,
    );
    return createCell(this.runtime, link, this.tx, this.synced);
  }

  getAsQueryResult<Path extends PropertyKey[]>(
    path?: Readonly<Path>,
    tx?: IExtendedStorageTransaction,
    writable?: boolean,
  ): CellResult<DeepKeyLookup<T, Path>> {
    if (!this.synced) this.sync(); // No await, just kicking this off
    const subPath = path || [];
    return createQueryResultProxy(
      this.runtime,
      tx ?? this.tx ?? this.runtime.edit(),
      {
        ...this.link,
        path: [...this.path, ...subPath.map((p) => p.toString())] as string[],
      },
      0,
      writable,
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
      keepStreams?: boolean;
      keepAsCell?: boolean;
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
    return tx.readValueOrThrow(
      resolveLink(this.runtime, tx, this.link, "top"),
      options,
    ) as
      | Immutable<T>
      | undefined;
  }

  setRaw(value: any): void {
    if (!this.tx) throw new Error("Transaction required for setRaw");

    // No await for the sync, just kicking this off, so we have the data to
    // retry on conflict.
    if (!this.synced) this.sync();

    value = toDeepStorableValue(value);
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

  getArgumentCell<U>(schema?: JSONSchema): Cell<U> | undefined {
    const sourceCell = this.getSourceCell();
    if (!sourceCell) return undefined;
    // Kick off sync, since when used in a pattern, this wasn't automatically
    // subscribed to yet. So we might still get a conflict on first write, but will
    // get the correct version on retry.
    sourceCell.sync();
    // TODO(seefeld): Ideally we intersect this schema with the actual argument
    // schema, so that get isn't for any.
    return sourceCell.key("argument").asSchema<U>(schema);
  }

  freeze(reason: string): void {
    this.readOnlyReason = reason;
  }

  isFrozen(): boolean {
    return !!this.readOnlyReason;
  }

  /**
   * Set the schema for this cell. Only works if the cause isn't set yet.
   * Prefer using .asSchema() instead.
   */
  setSchema(newSchema: JSONSchema): void {
    if (this._causeContainer.cause || this._causeContainer.id) {
      throw new Error(
        "Cannot setSchema: cell already has a cause or link. Use .asSchema() instead.",
      );
    }
    // Since we don't have a cause yet, we can modify the link's schema
    this._link = { ...this._link, schema: newSchema, rootSchema: newSchema };
  }

  /**
   * Connect this cell to a node reference.
   * This stores the node in a set of connected nodes, which is used during recipe construction.
   * @param node - The node to connect to
   */
  connect(node: NodeRef): void {
    // For cells created during recipe construction, we need to track which nodes
    // they're connected to. Since Cell doesn't have a nodes set like OpaqueRef's store,
    // we'll store this in a WeakMap keyed by the cell instance.
    const top = this._causeContainer.cell;
    if (!cellNodes.has(top)) {
      cellNodes.set(top, new Set());
    }
    cellNodes.get(top)!.add(node);
  }

  // TODO(seefeld): Remove once default schemas are properly propagated
  private _initialValue?: T;
  setInitialValue(value: T): void {
    this._initialValue = value;
  }

  /**
   * Export cell metadata for introspection, similar to OpaqueRef's export method.
   * If the cell has a link, it's included as 'external'.
   */
  export(): {
    cell: OpaqueCell<unknown>;
    path: readonly PropertyKey[];
    schema?: JSONSchema;
    rootSchema?: JSONSchema;
    nodes: Set<NodeRef>;
    frame: Frame;
    value?: Opaque<T> | T;
    name?: string;
    external?: unknown;
  } {
    if (!this._frame) {
      throw new Error("Cannot export cell: no frame context.");
    }
    return {
      cell: this._causeContainer.cell,
      path: this.path,
      schema: this.schema,
      rootSchema: this.rootSchema ?? this.schema,
      nodes: cellNodes.get(this._causeContainer.cell) ?? new Set(),
      frame: this._frame,
      value: this._kind === "stream"
        ? { $stream: true } as T
        : this._initialValue,
      name: this._causeContainer.cause as string | undefined,
      external: this._link.id
        ? this.getAsWriteRedirectLink({
          baseSpace: this._frame.space,
          includeSchema: true,
        })
        : undefined,
    };
  }

  /**
   * Set the self-reference for pattern SELF symbol support.
   * This allows patterns to access their own output via the SELF symbol.
   */
  setSelfRef(selfRef: OpaqueRef<any>): void {
    this._selfRef = selfRef;
  }

  /**
   * Wrap this cell in a proxy that provides OpaqueRef behavior.
   * The proxy adds Symbol.iterator, Symbol.toPrimitive, and toCell support,
   * and recursively wraps child cells accessed via property access.
   *
   * @returns A proxied version of this cell with OpaqueRef behavior
   */
  getAsOpaqueRefProxy(
    boundTarget?: (...args: unknown[]) => unknown,
  ): OpaqueRef<T> {
    const self = this as unknown as Cell<T>;
    const proxy = new Proxy(boundTarget ?? this, {
      get(target, prop) {
        if (prop === Symbol.iterator) {
          // Iterator support for array destructuring
          return function* () {
            let index = 0;
            while (index < 50) { // Limit to 50 items like original
              const itemCell = self.key(index) as Cell<unknown>;
              yield itemCell.getAsOpaqueRefProxy();
              index++;
            }
          };
        } else if (prop === Symbol.toPrimitive) {
          return () => {
            throw new Error(
              "Tried to access a reactive reference outside a reactive context. Use `computed()` to perform operations on reactive values - it handles closures automatically.",
            );
          };
        } else if (prop === toCell) {
          // Return a function that returns the unproxied cell
          return () => self;
        } else if (prop === isOpaqueRefMarker) {
          return true;
        } else if (prop === SELF) {
          // Return the self-reference if set (for pattern SELF symbol support)
          return (self as unknown as CellImpl<T>)._selfRef;
        } else if (typeof prop === "string" || typeof prop === "number") {
          // Recursive property access - wrap the child cell
          const nestedCell = self.key(prop) as Cell<T>;

          // Check if this is a method on the cell
          if (cellMethods.has(prop as keyof ICell<T>)) {
            return nestedCell.getAsOpaqueRefProxy(
              (self as unknown as Record<
                string,
                (...args: unknown[]) => unknown
              >)[prop]!
                .bind(self),
            );
          } else {
            return nestedCell.getAsOpaqueRefProxy();
          }
        }
        // Delegate everything else to orignal target
        return (target as any)[prop];
      },
    });
    return proxy as unknown as OpaqueRef<T>;
  }

  /**
   * Map over an array cell, creating a new derived array.
   * Similar to Array.prototype.map but works with OpaqueRefs.
   */
  map<S>(
    fn: (
      element: T extends Array<infer U> ? OpaqueRef<U> : OpaqueRef<T>,
      index: OpaqueRef<number>,
      array: OpaqueRef<T>,
    ) => Opaque<S>,
  ): OpaqueRef<S[]> {
    // Create the factory if it doesn't exist
    if (!mapFactory) {
      mapFactory = createNodeFactory({
        type: "ref",
        implementation: "map",
      });
    }

    // Use the cell directly as an OpaqueRef (since cells are now also OpaqueRefs)
    return mapFactory({
      list: this as unknown as OpaqueRef<T>,
      op: recipe(
        ({ element, index, array }: Opaque<any>) => fn(element, index, array),
      ),
    });
  }

  /**
   * Map over an array cell using a pattern/recipe.
   * Similar to map but accepts a pre-defined recipe instead of a function.
   */
  mapWithPattern<S>(
    this: IsThisObject,
    op: RecipeFactory<T extends Array<infer U> ? U : T, S>,
    params: Record<string, any>,
  ): OpaqueRef<S[]> {
    // Create the factory if it doesn't exist
    if (!mapFactory) {
      mapFactory = createNodeFactory({
        type: "ref",
        implementation: "map",
      });
    }

    return mapFactory({
      list: this as unknown as OpaqueRef<T>,
      op: op,
      params: params,
    });
  }

  toJSON(): SigilLink | null {
    // Return null when no link exists (cell hasn't been created yet)
    if (!this.hasFullLink()) {
      return null;
    }

    // Use sigil link format which includes space for cross-space references
    return createSigilLinkFromParsedLink(this.link);
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
}

function subscribeToReferencedDocs<T>(
  callback: (value: T) => Cancel | undefined | void,
  runtime: Runtime,
  link: NormalizedFullLink,
  options: SinkOptions = {},
): Cancel {
  let cleanup: Cancel | undefined | void;

  const action: Action = (tx) => {
    if (isCancel(cleanup)) cleanup();

    // Using a new transaction for child cells, as we're only interested in
    // dependencies for the initial get, not further cells the callback might
    // read. The callback is responsible for calling sink on those cells if it
    // wants to stay updated.
    const extraTx = runtime.edit();
    const wrappedTx = createChildCellTransaction(tx, extraTx);

    const newValue = validateAndTransform(runtime, wrappedTx, link);
    cleanup = callback(newValue);

    // no async await here, but that also means no retry. TODO(seefeld): Should
    // we add a retry? So far all sinks are read-only, so they get re-triggered
    // on changes already.
    extraTx.commit();
  };
  // Name the action for debugging
  const sinkName = `sink:${link.space}/${link.id}/${link.path.join("/")}`;
  Object.defineProperty(action, "name", {
    value: sinkName,
    configurable: true,
  });
  (action as Action & { src?: string }).src = sinkName;

  // Call action once immediately, which also defines what docs need to be
  // subscribed to. Wrap with withExecutingAction so that any child sinks
  // created during the callback see this action as their parent.
  const tx = runtime.edit();
  runtime.scheduler.withExecutingAction(action, () => action(tx));
  const log = txToReactivityLog(tx);

  // Technically unnecessary since we don't expect/allow callbacks to sink to
  // write to other cells, and we retry by design anyway below when read data
  // changed. But ideally we enforce read-only as well.
  tx.commit();

  // Mark as effect since sink() is a side-effectful consumer (FRP effect/sink)
  // Use resubscribe because we've already run it once above
  const resubscribeOptions = {
    isEffect: true,
    ...(options.changeGroup !== undefined && {
      changeGroup: options.changeGroup,
    }),
  };
  runtime.scheduler.resubscribe(action, log, resubscribeOptions);

  return () => {
    runtime.scheduler.unsubscribe(action);
    if (isCancel(cleanup)) cleanup();
  };
}

/**
 * Deeply traverse a value to access all properties.
 * This is used by pull() to ensure all nested values are read,
 * which registers them as dependencies for pull-based scheduling.
 * Works with query result proxies which trigger reads on property access.
 */
function deepTraverse(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || value === undefined) return;
  if (typeof value !== "object") return;

  // Avoid infinite loops with circular references
  if (seen.has(value)) return;
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      for (const item of value) {
        deepTraverse(item, seen);
      }
    } else {
      for (const key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          try {
            deepTraverse((value as Record<string, unknown>)[key], seen);
          } catch {
            // Ignore errors from accessing individual properties (e.g., link cycles)
          }
        }
      }
    }
  } catch {
    // Ignore errors from traversal (e.g., link cycles)
    // We've already registered the dependencies we can access
  }
}

/**
 * Validates that a value contains only static data (no cells or cell-like objects)
 * and has no circular references. Used by Cell.of() to ensure only serializable
 * static data is passed.
 *
 * Note: Shared references (same object at multiple paths) are allowed.
 * Only true cycles (object referencing an ancestor) are rejected.
 *
 * @param value - The value to validate
 * @throws Error if value contains cells or has circular references
 */
function validateStaticData(value: unknown): void {
  // Track ancestors in current path (for cycle detection)
  // Shared references are fine - only cycles back to ancestors are errors
  const ancestors = new Set<object>();

  function traverse(val: unknown, path: string[]): void {
    // Primitives are always fine
    if (val === null || val === undefined) return;
    if (typeof val !== "object" && typeof val !== "function") return;

    const obj = val as object;

    // Check for cells and cell-like objects first (before cycle check)
    if (isCell(obj)) {
      throw new Error(
        `Cell.of() only accepts static data, but found a reactive value (Cell) at path '${
          path.join(".")
        }'.\n` +
          "help: use Cell references as handler parameters or in computed() closures instead of embedding them in Cell.of() values",
      );
    }

    if (isCellResultForDereferencing(obj)) {
      throw new Error(
        `Cell.of() only accepts static data, but found a reactive value (CellResult) at path '${
          path.join(".")
        }'.\n` +
          "help: use .get() to extract the value first, or pass Cell references as handler parameters",
      );
    }

    // Check for cycles - only ancestors in current path, not all seen objects
    if (ancestors.has(obj)) {
      throw new Error(
        `Cell.of() does not accept circular references. Cycle detected at path '${
          path.join(".")
        }'.\n` +
          "help: restructure your data to avoid circular references",
      );
    }

    ancestors.add(obj);

    // Traverse arrays and objects
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        traverse(obj[i], [...path, String(i)]);
      }
    } else {
      for (const key of Object.keys(obj)) {
        traverse((obj as Record<string, unknown>)[key], [...path, key]);
      }
    }

    // Remove from ancestors when backtracking (shared refs at other paths are ok)
    ancestors.delete(obj);
  }

  traverse(value, []);
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
export function recursivelyAddIDIfNeeded<T>(
  value: T,
  frame: Frame | undefined,
  seen: Map<unknown, unknown> = new Map(),
): T {
  // Can't add IDs without frame.
  if (!frame) return value;

  // Already seen, return previously annotated result. Check this before
  // toStorableValue() to handle circular references properly.
  if (seen.has(value)) return seen.get(value) as T;

  // Cell links pass through unchanged.
  if (isCellLink(value)) {
    return value;
  }

  // Convert value to storable form. This handles:
  // - Primitives (e.g., -0 → 0, reject NaN/Infinity/Symbol/BigInt)
  // - Instances (e.g., Error → @Error wrapper)
  // - Objects/arrays with toJSON() methods
  // - Sparse arrays (densified with null in holes)
  const converted = toStorableValue(value);
  const convertedIsRecord = isRecord(converted);

  // If conversion changed the value, cache the result so shared references
  // are preserved and we avoid redundant toJSON() calls.
  if (converted !== value) {
    const result = convertedIsRecord
      ? recursivelyAddIDIfNeeded(converted as T, frame, seen)
      : converted as T;
    seen.set(value, result);
    return result;
  }

  // Primitives that didn't need conversion don't need further processing.
  if (!convertedIsRecord) {
    return converted as T;
  }

  if (Array.isArray(value)) {
    const result: unknown[] = [];

    // Set before traversing, otherwise we'll infinite recurse.
    seen.set(value, result);

    result.push(...value.map((v) => {
      const value = recursivelyAddIDIfNeeded(v, frame, seen);
      // For objects on arrays only: Add ID if not already present.
      if (
        isObject(value) && !isCellLink(value) && !(ID in value)
      ) {
        return { [ID]: frame.generatedIdCounter++, ...value };
      } else {
        return value;
      }
    }));
    return result as T;
  } else {
    // At this point we know `value` is a non-array record (we returned early
    // for primitives and `Array.isArray` was false).
    const valueRecord = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};

    // Set before traversing, otherwise we'll infinite recurse.
    seen.set(value, result);

    Object.entries(valueRecord).forEach(([key, v]) => {
      result[key] = recursivelyAddIDIfNeeded(v, frame, seen);
    });

    // Copy supported symbols from original value.
    [ID, ID_FIELD].forEach((symbol) => {
      if (symbol in valueRecord) {
        (result as IDFields)[symbol as keyof IDFields] =
          (valueRecord as IDFields)[symbol as keyof IDFields];
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
  options: {
    includeSchema?: boolean;
    keepStreams?: boolean;
    keepAsCell?: boolean;
    doNotConvertCellResults?: boolean;
  } = {},
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

  // Early-return cases
  if (!options.doNotConvertCellResults && isCellResultForDereferencing(value)) {
    return getCellOrThrow(value).getAsLink(options);
  } else if (isCell(value)) {
    return value.getAsLink(options);
  } else if (!(isRecord(value) || isFunction(value))) {
    return value;
  }

  // At this point `value` is a non-`null` object(ish) thing.

  seen.set(value, path); // ...which needs to be tracked for circularity.

  // Convert the (top level of) the value to something JSON-encodable if not
  // already JSON-encodable, or throw if it's neither already valid nor
  // convertible.
  value = toStorableValue(value);

  // Recursively process arrays and objects, if we ended up with one of those.
  if (!isRecord(value)) {
    // `toStorableValue()` converted this into a primitive value of some sort.
    return value;
  } else if (Array.isArray(value)) {
    return value.map((value, index) =>
      convertCellsToLinks(value, options, [...path, String(index)], seen)
    );
  } else {
    return Object.fromEntries(
      Object.entries(value).map(([key, value]) => [
        key,
        convertCellsToLinks(value, options, [...path, String(key)], seen),
      ]),
    );
  }
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

/**
 * Factory function to create Cell constructor with static methods for a specific cell kind
 */
export function cellConstructorFactory<Wrap extends HKT>(kind: CellKind) {
  return {
    /**
     * Create a Cell wrapping a value with optional schema.
     * This is a convenience method that creates a cell with a schema that has a default value.
     * @param value - The value to wrap in a Cell
     * @param providedSchema - Optional JSON schema for the cell
     * @returns A new Cell wrapping the value
     */
    of<T>(value?: T, providedSchema?: JSONSchema): Apply<Wrap, T> {
      const frame = getTopFrame();
      if (!frame || !frame.runtime) {
        throw new Error(
          "Can't invoke Cell.of() outside of a recipe/handler/lift context",
        );
      }

      // Validate that value contains only static data (no cells or cycles)
      if (value !== undefined) {
        validateStaticData(value);
      }

      // Convert schema to object form and merge default value if value is defined
      // BUT: Don't embed Cell objects in the schema's default property, as this
      // causes infinite recursion when the schema is serialized
      // TODO(ubik2): Use Cell links for default here once that's supported
      const schema: JSONSchema | undefined =
        value !== undefined && !isCell(value)
          ? {
            ...ContextualFlowControl.toSchemaObj(providedSchema),
            default: value as any,
          }
          : providedSchema === undefined
          ? undefined
          : ContextualFlowControl.toSchemaObj(providedSchema);

      // Create a cell without a link - it will be created on demand via .for()
      const cell = createCell<T>(
        frame.runtime,
        {
          path: [],
          ...(schema !== undefined && { schema, rootSchema: schema }),
          ...(frame.space && { space: frame.space }),
        },
        frame.tx,
        false,
        kind,
      );

      // Set the initial value only if value is defined
      if (value !== undefined) {
        cell.setInitialValue(value);
      }

      return cell;
    },

    /**
     * Compare two cells or values for equality, after resolving them.
     * @param a - First cell or value to compare
     * @param b - Second cell or value to compare
     * @returns true if the values are equal
     */
    equals(a: AnyCell<any> | object, b: AnyCell<any> | object): boolean {
      const frame = getTopFrame();
      return areLinksSame(
        a,
        b,
        undefined,
        !!frame?.tx,
        frame?.tx,
        frame?.runtime,
      );
    },

    /**
     * Compare two cells or values for equality.
     * @param a - First cell or value to compare
     * @param b - Second cell or value to compare
     * @returns true if the values are equal
     */
    equalLinks(a: AnyCell<any> | object, b: AnyCell<any> | object): boolean {
      return areLinksSame(a, b);
    },

    /**
     * Create a Cell with an optional cause.
     * @param cause - The cause to associate with this cell
     * @returns A new Cell
     */
    for<T>(cause: unknown): Apply<Wrap, T> {
      const frame = getTopFrame();
      if (!frame || !frame.runtime) {
        throw new Error(
          "Can't invoke Cell.for() outside of a recipe/handler/lift context",
        );
      }

      // Create a cell without a link
      const cell = createCell<T>(
        frame.runtime,
        {
          path: [],
          ...(frame.space && { space: frame.space }),
        },
        frame.tx,
        false,
        kind,
      );

      // Associate it with the cause
      cell.for(cause);

      return cell;
    },
  } satisfies CellTypeConstructor<Wrap>;
}
