import { isRecord } from "@commontools/utils/types";
import { opaqueRef } from "./builder/opaque-ref.ts";
import { getTopFrame } from "./builder/recipe.ts";
import { deepEqual, getValueAtPath, setValueAtPath } from "./path-utils.ts";
import {
  type Frame,
  type JSONSchema,
  type OpaqueRef,
  type Schema,
  toOpaqueRef,
} from "./builder/types.ts";
import { type Cell, createCell } from "./cell.ts";
import {
  createQueryResultProxy,
  type QueryResult,
} from "./query-result-proxy.ts";
import { type EntityId } from "./doc-map.ts";
import type { IRuntime } from "./runtime.ts";
import { type Cancel } from "./cancel.ts";
import { Labels, MemorySpace } from "./storage.ts";
import { arrayEqual } from "./path-utils.ts";
import { toURI } from "./uri-utils.ts";
import type { IExtendedStorageTransaction } from "./storage/interface.ts";

/**
 * Lowest level cell implementation.
 *
 * Exposes the raw value, which can contain queries (currently those are
 * aliases) and cell references. Data is not normalized and can be anything.
 *
 * Most of the time just used to get to the other representations or to pass
 * around to other parts of the system.
 */
export type DocImpl<T> = {
  /**
   * Get raw value.
   *
   * @returns Value.
   */
  get(): T;

  /**
   * Get value at path. Does not resolve aliases or cell references.
   *
   * @param path - Path to follow.
   * @returns Value.
   */
  getAtPath<Path extends PropertyKey[]>(path: Path): DeepKeyLookup<T, Path>;

  /**
   * Get as value proxy, following query (i.e. aliases) and cell references.
   *
   * Value proxy is a proxy that can be used to read and write to the cell.
   * Those will be logged in `log`.
   *
   * Use for module implementations and other places where you want JS idioms
   * and not want to deal with cell references, etc.
   *
   * @param path - Path to follow.
   * @param log - Reactivity log.
   * @returns Value proxy.
   */
  getAsQueryResult<Path extends PropertyKey[]>(
    path?: Path,
    tx?: IExtendedStorageTransaction,
  ): QueryResult<DeepKeyLookup<T, Path>>;

  /**
   * Get as simple cell, which is following query (i.e. aliases), but not cell
   * references. Cell references will be mapped to other simple cells, though.
   *
   * Use for e.g. common-html and other things that expect traditional cells.
   *
   * @param path - Path to follow.
   * @param log - Reactivity log.
   * @returns Simple cell.
   */
  asCell<Q = T, Path extends PropertyKey[] = []>(
    path?: Readonly<Path>,
    schema?: JSONSchema,
    rootSchema?: JSONSchema,
    tx: IExtendedStorageTransaction,
  ): Cell<DeepKeyLookup<Q, Path>>;

  /**
   * Get as simple cell with schema-inferred type.
   *
   * @param path - Path to follow.
   * @param log - Reactivity log.
   * @param schema - JSON Schema to validate against.
   * @param rootSchema - Root schema for recursive validation.
   * @returns Simple cell with inferred type.
   */
  asCell<S extends JSONSchema, Path extends PropertyKey[] = []>(
    path: Path | undefined,
    schema: S,
    rootSchema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
  ): Cell<Schema<S>>;

  /**
   * Send a value, log writes.
   *
   * @param value - Value to send.
   * @param log - Reactivity log.
   * @returns Whether the value changed.
   */
  send(value: T): boolean;

  /**
   * Set value at path, log writes.
   *
   * @param path - Path to set.
   * @param newValue - New value.
   * @param log - Reactivity log.
   * @param schema - JSON Schema to validate against.
   * @returns Whether the value changed.
   */
  setAtPath(
    path: PropertyKey[],
    newValue: any,
    schema?: JSONSchema,
  ): boolean;

  /**
   * Add callback for updates. Will call on first change.
   *
   * @param callback - Callback to call on updates.
   * @returns Cancel function.
   */
  updates(
    callback: (value: T, path: PropertyKey[], labels?: Labels) => void,
  ): Cancel;

  /**
   * Freeze cell, making it read-only.
   *
   * Useful for cells that just represent a query, like a cell composed to
   * represent inputs to a module (which is just aliases).
   */
  freeze(reason: string): void;

  /**
   * Check if cell is frozen.
   *
   * @returns Whether the cell is frozen.
   */
  isFrozen(): boolean;

  /**
   * Convert the entity ID to a JSON pointer.
   *
   * This is _not_ a JSON representation of the contents. Use `.get()` or the
   * other variants above for that.
   *
   * @returns JSON representation.
   */
  toJSON(): { "/": string } | undefined;

  /**
   * Get current value. Please use `.get()` instead. This getter also easy
   * access to contents while debugging.
   *
   * @returns Value.
   */
  value: T;

  /**
   * The space this doc belongs to.
   * Required when entityId is set.
   */
  space: MemorySpace;

  /**
   * Get current entity ID.
   *
   * @returns Entity ID.
   */
  entityId: EntityId;
  "/": string;

  /**
   * Get and set the source cell, that is the cell that populates this cell.
   * `run` sets this up by writing a query corresponding to the results into
   * this cell and pointing to the a cell containing the recipe, the argument
   * and all intermediate cells as source cell.
   *
   * @returns Source cell.
   */
  sourceCell: DocImpl<any> | undefined;

  /**
   * Whether the cell is ephemeral.
   *
   * Ephemeral cells are not persisted to storage.
   *
   * @returns Whether the cell is ephemeral.
   */
  ephemeral: boolean;

  /**
   * The runtime instance that owns this document.
   * Used for accessing scheduler and other runtime services.
   */
  runtime: IRuntime;

  /**
   * Retry callbacks for the current value on cell. Will be cleared after a
   * transaction goes through, whether it ultimately succeeds or not.
   *
   * See retry logic in storage.ts - this is a temporary approach, and notes
   * there explain what should really happen. Hence the minimal possible
   * code changes to get the current functionality.
   */
  retry?: ((previousValue: T) => T)[];

  /**
   * Internal only: Used by builder to turn cells into proxies tied to them.
   * Useful when building a recipe that directly refers to existing cells, such
   * as a recipe created and returned by a handler.
   */
  [toOpaqueRef]: () => OpaqueRef<T>;

  /**
   * Internal only: Marker for cells. Used by e.g. `isCell`, etc.
   */
  [isDocMarker]: true;

  /**
   * Internal only: Trap for copy operations.
   */
  copyTrap: boolean;
};

export type DeepKeyLookup<T, Path extends PropertyKey[]> = Path extends [] ? T
  : Path extends [infer First, ...infer Rest]
    ? First extends keyof T
      ? Rest extends PropertyKey[] ? DeepKeyLookup<T[First], Rest>
      : any
    : any
  : any;

/**
 * Creates a new document with the specified value, entity ID, and space.
 * @param value - The value to wrap in a document
 * @param entityId - The entity identifier
 * @param space - The space identifier
 * @param runtime - The runtime instance that owns this document
 * @returns A new document implementation
 */
export function createDoc<T>(
  value: T,
  entityId: EntityId,
  space: MemorySpace,
  runtime: IRuntime,
): DocImpl<T> {
  const callbacks = new Set<
    (value: T, path: PropertyKey[], labels?: Labels) => void
  >();
  let readOnly: string | undefined = undefined;
  let sourceCell: DocImpl<any> | undefined;
  let ephemeral = false;

  const self: DocImpl<T> = {
    get: () => value as T,
    getAsQueryResult: <Path extends PropertyKey[]>(
      path?: Path,
      tx?: IExtendedStorageTransaction,
    ) =>
      createQueryResultProxy(runtime, tx ?? runtime.edit(), {
        space,
        id: toURI(entityId),
        path: path?.map(String) ?? [],
        type: "application/json",
      }) as QueryResult<DeepKeyLookup<T, Path>>,
    asCell: <Q = T, Path extends PropertyKey[] = []>(
      path?: Path,
      schema?: JSONSchema,
      rootSchema?: JSONSchema,
      tx?: IExtendedStorageTransaction,
    ) =>
      createCell(runtime, {
        space,
        id: toURI(entityId),
        path: path?.map(String) ?? [],
        type: "application/json",
        schema,
        rootSchema,
      }, tx),
    send: (newValue: T) => self.setAtPath([], newValue),
    updates: (
      callback: (value: T, path: PropertyKey[], labels?: Labels) => void,
    ) => {
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
    getAtPath: (path: PropertyKey[]) => getValueAtPath(value, path),
    setAtPath: (
      path: PropertyKey[],
      newValue: any,
      schema?: JSONSchema,
    ) => {
      if (readOnly) throw new Error(`Cell is read-only: ${readOnly}`);

      let changed = false;
      if (path.length > 0) {
        if (value === undefined) {
          value = (typeof path[0] === "number" ? [] : {}) as T;
        }
        changed = setValueAtPath(value, path, newValue);
      } else if (!deepEqual(value, newValue)) {
        changed = true;
        value = newValue;
      }
      if (changed) {
        const lubSchema = (schema !== undefined)
          ? runtime.cfc.lubSchema(schema)
          : undefined;
        const labels = (lubSchema !== undefined)
          ? { classification: [lubSchema] }
          : undefined;
        // Call each callback. Snapshot via [...callbacks] as the set of
        // callbacks can change during the execution of the callbacks.
        for (const callback of [...callbacks]) {
          callback(value as T, path, labels);
        }
      }
      return changed;
    },
    freeze: (reason: string) => {
      readOnly = reason;
      /* NOTE: Can't freeze actual object, since otherwise JS throws type errors
      for the cases where the proxy returns different values than what is
      proxied, e.g. for aliases. TODO: Consider changing proxy here. */
    },
    isFrozen: () => readOnly !== undefined,
    // This is the id and not the contents, because we .toJSON is called when
    // writing a structure to this that might contain a reference to this cell,
    // and we want to serialize that as am IPLD link to this cell.
    toJSON: () =>
      typeof entityId?.toJSON === "function"
        ? entityId.toJSON()
        : ((entityId as { "/": string }) ?? { "/": "" }),
    get value(): T {
      return value as T;
    },
    get "/"(): string {
      return typeof entityId.toJSON === "function"
        ? entityId.toJSON()["/"]
        : (entityId["/"] as string);
    },
    get entityId(): EntityId {
      return entityId;
    },
    set entityId(id: EntityId) {
      throw new Error("Can't set entity ID directly, use getDocByEntityId");
    },
    get space(): MemorySpace {
      return space;
    },
    set space(newSpace: MemorySpace) {
      throw new Error("Can't set space directly, use getDocByEntityId");
    },
    get sourceCell(): DocImpl<any> | undefined {
      return sourceCell;
    },
    set sourceCell(cell: DocImpl<any> | undefined) {
      if (sourceCell && JSON.stringify(sourceCell) !== JSON.stringify(cell)) {
        throw new Error(
          `Source cell already set: ${JSON.stringify(sourceCell)} -> ${
            JSON.stringify(cell)
          }`,
        );
      }
      sourceCell = cell;

      // Notify callbacks that there was a change.
      for (const callback of [...callbacks]) callback(value as T, []);
    },
    get ephemeral(): boolean {
      return ephemeral;
    },
    set ephemeral(value: boolean) {
      ephemeral = value;
    },
    get runtime(): IRuntime {
      return runtime;
    },
    [toOpaqueRef]: () => makeOpaqueRef(self, []),
    [isDocMarker]: true,
    get copyTrap(): boolean {
      throw new Error("Copy trap: Don't copy cells, create references instead");
    },
  };

  runtime.documentMap.registerDoc(entityId, self, space);

  return self;
}

const docLinkToOpaqueRef = new WeakMap<
  Frame,
  WeakMap<DocImpl<any>, { path: PropertyKey[]; opaqueRef: OpaqueRef<any> }[]>
>();

// Creates aliases to value, used in recipes to refer to this specific cell. We
// have to memoize these, as conversion happens at multiple places when
// creaeting the recipe.
export function makeOpaqueRef(
  doc: DocImpl<any>,
  path: PropertyKey[],
): OpaqueRef<any> {
  const frame = getTopFrame();
  if (!frame) throw new Error("No frame");
  if (!docLinkToOpaqueRef.has(frame)) {
    docLinkToOpaqueRef.set(frame, new WeakMap());
  }
  let opaqueRefs = docLinkToOpaqueRef.get(frame)!.get(doc);
  if (!opaqueRefs) {
    opaqueRefs = [];
    docLinkToOpaqueRef.get(frame)!.set(doc, opaqueRefs);
  }
  let ref = opaqueRefs.find((p) => arrayEqual(path, p.path))?.opaqueRef;
  if (!ref) {
    ref = opaqueRef();
    ref.setPreExisting({ $alias: { cell: doc, path } });
    opaqueRefs.push({ path: path, opaqueRef: ref });
  }
  return ref;
}

/**
 * Check if value is a cell.
 *
 * @param {any} value - The value to check.
 * @returns {boolean}
 */
export function isDoc(value: any): value is DocImpl<any> {
  return isRecord(value) && value[isDocMarker] === true;
}

const isDocMarker = Symbol("isDoc");
