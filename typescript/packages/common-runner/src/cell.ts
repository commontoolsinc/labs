import { isAlias, isStreamAlias } from "@commontools/common-builder";
import {
  getValueAtPath,
  setValueAtPath,
  deepEqual,
  cell as opaqueRef,
  toOpaqueRef,
  type OpaqueRef,
  getTopFrame,
  type Frame,
} from "@commontools/common-builder";
import {
  followCellReferences,
  followAliases,
  setNestedValue,
  pathAffected,
  transformToRendererCells,
  normalizeToCells,
  arrayEqual,
} from "./utils.js";
import { queueEvent } from "./scheduler.js";
import {
  setCellByEntityId,
  getEntityId,
  createRef,
  type EntityId,
} from "./cell-map.js";
import { type Cancel } from "./cancel.js";

/**
 * This is the regular Cell interface, generated by CellImpl.asRendererCell().
 * This abstracts away the paths behind an interface that e.g. the UX code or
 * modules that prefer cell interfaces can use.
 *
 * @method get Returns the current value of the cell.
 * @returns {T}
 *
 * @method set Alias for `send`. Sets a new value for the cell.
 * @method send Sets a new value for the cell.
 * @param {T} value - The new value to set.
 * @returns {void}
 *
 * @method key Returns a new cell for the specified key path.
 * @param {K} valueKey - The key to access in the cell's value.
 * @returns {Cell<T[K]>}
 *
 * @method sink Adds a callback that is called immediately and on cell changes.
 * @param {function} callback - The callback to be called when the cell changes.
 * @returns {function} - A function to cancel the callback.
 *
 * @method getAsProxy Returns a value proxy for the cell.
 * @param {Path} path - The path to follow.
 * @returns {QueryResult<DeepKeyLookup<T, Path>>}
 *
 * @method getAsCellReference Returns a cell reference for the cell.
 * @returns {CellReference}
 *
 * @method toJSON Returns a JSON pointer to the cell (not the contents!).
 * @returns {{"/": string}}
 *
 * @method value Returns the current value of the cell.
 * @returns {T}
 *
 * @method entityId Returns the current entity ID of the cell.
 * @returns {EntityId | undefined}
 */
export interface RendererCell<T> {
  get(): T;
  set(value: T): void;
  send(value: T): void;
  sink(callback: (value: T) => void): () => void;
  key<K extends keyof T>(valueKey: K): RendererCell<T[K]>;
  getAsQueryResult<Path extends PropertyKey[]>(
    path?: Path,
    log?: ReactivityLog
  ): QueryResult<DeepKeyLookup<T, Path>>;
  getAsCellReference(): CellReference;
  toJSON(): { "/": string } | undefined;
  value: T;
  entityId: EntityId | undefined;
  [isRendererCellMarker]: true;
  copyTrap: boolean;
}

export interface ReactiveCell<T> {
  sink(callback: (value: T) => void): () => void;
}

export interface GettableCell<T> {
  get(): T;
}

export interface SendableCell<T> {
  send(value: T): void;
}

/**
 * Lowest level cell implementation.
 *
 * Exposes the raw value, which can contain queries (currently those are
 * aliases) and cell references. Data is not normalized and can be anything.
 *
 * Most of the time just used to get to the other representations or to pass
 * around to other parts of the system.
 */
export type CellImpl<T> = {
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
    log?: ReactivityLog
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
  asRendererCell<Q = T, Path extends PropertyKey[] = []>(
    path?: Path,
    log?: ReactivityLog
  ): RendererCell<DeepKeyLookup<Q, Path>>;

  /**
   * Send a value, log writes.
   *
   * @param value - Value to send.
   * @param log - Reactivity log.
   * @returns Whether the value changed.
   */
  send(value: T, log?: ReactivityLog): boolean;

  /**
   * Set value at path, log writes.
   *
   * @param path - Path to set.
   * @param newValue - New value.
   * @param log - Reactivity log.
   * @returns Whether the value changed.
   */
  setAtPath(path: PropertyKey[], newValue: any, log?: ReactivityLog): boolean;

  /**
   * Add callback for updates. Will call on first change.
   *
   * @param callback - Callback to call on updates.
   * @returns Cancel function.
   */
  updates(callback: (value: T, path: PropertyKey[]) => void): Cancel;

  /**
   * Add callback for updates. Will call immediately with current value.
   *
   * @param callback - Callback to call on updates.
   * @returns Cancel function.
   */
  sink(callback: (value: T, path: PropertyKey[]) => void): Cancel;

  /**
   * Freeze cell, making it read-only.
   *
   * Useful for cells that just represent a query, like a cell composed to
   * represent inputs to a module (which is just aliases).
   */
  freeze(): void;

  /**
   * Check if cell is frozen.
   *
   * @returns Whether the cell is frozen.
   */
  isFrozen(): boolean;

  /**
   * Generate entity ID. This is delayed, so that content can be added before
   * the id is generated.
   *
   * The id is a function of the cell's value at the point of call and the cause
   * of generation. If no cause is provided, a random event is assumed.
   *
   * @param cause - Causal event that preceeds entity generation.
   */
  generateEntityId(cause?: any): void;

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
   * Get current entity ID.
   *
   * @returns Entity ID.
   */
  entityId?: EntityId | undefined;

  /**
   * Get and set the source cell, that is the cell that populates this cell.
   * `run` sets this up by writing a query corresponding to the results into
   * this cell and pointing to the a cell containing the recipe, the parameters
   * and all intermediate cells as source cell.
   *
   * @returns Source cell.
   */
  sourceCell: CellImpl<any> | undefined;

  /**
   * Internal only: Used by builder to turn cells into proxies tied to them.
   * Useful when building a recipe that directly refers to existing cells, such
   * as a recipe created and returned by a handler.
   */
  [toOpaqueRef]: () => OpaqueRef<T>;

  /**
   * Internal only: Marker for cells. Used by e.g. `isCell`, etc.
   */
  [isCellMarker]: true;

  /**
   * Internal only: Trap for copy operations.
   */
  copyTrap: boolean;
};

/**
 * Cell reference.
 *
 * A cell reference is a cell and a path within that cell.
 *
 * Values proxies (CellImpl.getAsProxy) transparently follow these references
 * and create them when assigning a value from another cell.
 *
 * Renderer cells (CellImpl.asRendererCell) expose these as other renderer cells.
 */
export type CellReference = {
  cell: CellImpl<any>;
  path: PropertyKey[];
};

export type QueryResultInternals = {
  [getCellReference]: CellReference;
};

export type QueryResult<T> = T & QueryResultInternals;

/**
 * Reactivity log.
 *
 * Used to log reads and writes to cells. Used by scheduler to keep track of
 * dependencies and to topologically sort pending actions before executing them.
 */
export type ReactivityLog = {
  reads: CellReference[];
  writes: CellReference[];
};

export type DeepKeyLookup<T, Path extends PropertyKey[]> = Path extends []
  ? T
  : Path extends [infer First, ...infer Rest]
  ? First extends keyof T
    ? Rest extends PropertyKey[]
      ? DeepKeyLookup<T[First], Rest>
      : any
    : any
  : any;

export function cell<T>(value?: T): CellImpl<T> {
  const callbacks = new Set<(value: T, path: PropertyKey[]) => void>();
  let readOnly = false;
  let entityId: EntityId | undefined;
  let sourceCell: CellImpl<any> | undefined;

  const self: CellImpl<T> = {
    get: () => value as T,
    getAsQueryResult: <Path extends PropertyKey[]>(
      path?: Path,
      log?: ReactivityLog
    ) =>
      createQueryResultProxy(self, path ?? [], log) as QueryResult<
        DeepKeyLookup<T, Path>
      >,
    asRendererCell: <Q = T>(path: PropertyKey[] = [], log?: ReactivityLog) =>
      rendererCell<Q>(self, path, log),
    send: (newValue: T, log?: ReactivityLog) =>
      self.setAtPath([], newValue, log),
    updates: (callback: (value: T, path: PropertyKey[]) => void) => {
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
    sink: (callback: (value: T, path: PropertyKey[]) => void) => {
      callback(value as T, []);
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
    getAtPath: (path: PropertyKey[]) => getValueAtPath(value, path),
    setAtPath: (path: PropertyKey[], newValue: any, log?: ReactivityLog) => {
      if (readOnly) throw new Error("Cell is read-only");

      let changed = false;
      if (path.length > 0) {
        changed = setValueAtPath(value, path, newValue);
      } else if (!deepEqual(value, newValue)) {
        changed = true;
        value = newValue;
      }
      if (changed) {
        log?.writes.push({ cell: self, path });
        for (const callback of callbacks) callback(value as T, path);
      }
      return changed;
    },
    freeze: () => {
      readOnly = true;
      /* NOTE: Can't freeze actual object, since otherwise JS throws type errors
      for the cases where the proxy returns different values than what is
      proxied, e.g. for aliases. TODO: Consider changing proxy here. */
    },
    isFrozen: () => readOnly,
    generateEntityId: (cause?: any): void => {
      entityId = createRef(
        typeof value === "object" && value !== null
          ? (value as Object)
          : value !== undefined
          ? { value }
          : {},
        cause
      );
      setCellByEntityId(entityId, self);
    },
    // This is the id and not the contents, because we .toJSON is called when
    // writing a structure to this that might contain a reference to this cell,
    // and we want to serialize that as am IPLD link to this cell.
    toJSON: () =>
      typeof entityId?.toJSON === "function"
        ? entityId.toJSON()
        : (entityId as { "/": string }),
    get value(): T {
      return value as T;
    },
    get entityId(): EntityId | undefined {
      return entityId;
    },
    set entityId(id: EntityId) {
      if (entityId) throw new Error("Entity ID already set");
      entityId = id;
      setCellByEntityId(id, self);
    },
    get sourceCell(): CellImpl<any> | undefined {
      return sourceCell;
    },
    set sourceCell(cell: CellImpl<any> | undefined) {
      if (sourceCell && sourceCell !== cell)
        throw new Error("Source cell already set");
      sourceCell = cell;
    },
    [toOpaqueRef]: () => makeOpaqueRef(self, []),
    [isCellMarker]: true,
    get copyTrap(): boolean {
      throw new Error("Copy trap: Don't copy cells, create references instead");
    },
  };

  return self;
}

function rendererCell<T>(
  cell: CellImpl<any>,
  path: PropertyKey[],
  log?: ReactivityLog
): RendererCell<T> {
  // Follow aliases, cell references, etc. in path. Note that
  // transformToRendererCells will follow aliases, but not cell references, so
  // this is just for setup. Arguably key() should possibly fail if it crosses a
  // cell, but right now it'll silently cross cells.
  let keys = [...path];
  let target = cell.get();
  while (keys.length) {
    const key = keys.shift()!;
    target = target instanceof Object ? target[key] : undefined;
    const seen = new Set();
    let ref: CellReference | undefined;
    do {
      if (typeof target === "object" && target !== null) {
        if (seen.has(target)) {
          throw new Error("Cyclic cell reference");
        } else {
          seen.add(target);
        }
      }

      ref = undefined;
      if (isQueryResultForDereferencing(target)) ref = target[getCellReference];
      else if (isCellReference(target)) ref = followCellReferences(target, log);
      else if (isCell(target))
        ref = { cell: target, path: [] } satisfies CellReference;
      else if (isAlias(target)) ref = followAliases(target, cell, log);

      if (ref) {
        target = ref.cell.getAtPath(ref.path);
        cell = ref.cell;
        path = [...ref.path, ...keys];
      }
    } while (ref);
  }

  const self: RendererCell<T> = isStreamAlias(cell.getAtPath(path))
    ? ({
        // Implementing just Sendable<T>
        send: (event: T) => {
          log?.writes.push({ cell: cell, path });
          queueEvent({ cell: cell, path }, event);
        },
      } as RendererCell<T>)
    : {
        get: () =>
          transformToRendererCells(cell, cell.getAtPath(path), log) as T,
        set: (newValue: T) => cell.setAtPath(path, newValue, log),
        send: (newValue: T) => self.set(newValue),
        sink: (callback: (value: T) => void) => {
          return cell.sink(
            (value, changedPath) =>
              pathAffected(changedPath, path) &&
              callback(
                transformToRendererCells(cell, getValueAtPath(value, path), log)
              )
          );
        },
        key: <K extends keyof T>(key: K) =>
          cell.asRendererCell([...path, key], log) as RendererCell<T[K]>,
        getAsQueryResult: (
          subPath: PropertyKey[] = [],
          newLog?: ReactivityLog
        ) => createQueryResultProxy(cell, [...path, ...subPath], newLog ?? log),
        getAsCellReference: () => ({ cell, path } satisfies CellReference),
        toJSON: () => cell.toJSON(),
        get value(): T {
          return self.get();
        },
        get entityId(): EntityId | undefined {
          return getEntityId(self.getAsCellReference());
        },
        [isRendererCellMarker]: true,
        get copyTrap(): boolean {
          throw new Error(
            "Copy trap: Don't copy renderer cells. Create references instead."
          );
        },
      };
  return self;
}

// Array.prototype's entries, and whether they modify the array
enum ArrayMethodType {
  ReadOnly,
  ReadWrite,
  WriteOnly,
}

const arrayMethods: { [key: string]: ArrayMethodType } = {
  at: ArrayMethodType.ReadOnly,
  concat: ArrayMethodType.ReadOnly,
  entries: ArrayMethodType.ReadOnly,
  every: ArrayMethodType.ReadOnly,
  fill: ArrayMethodType.WriteOnly,
  filter: ArrayMethodType.ReadOnly,
  find: ArrayMethodType.ReadOnly,
  findIndex: ArrayMethodType.ReadOnly,
  findLast: ArrayMethodType.ReadOnly,
  findLastIndex: ArrayMethodType.ReadOnly,
  includes: ArrayMethodType.ReadOnly,
  indexOf: ArrayMethodType.ReadOnly,
  join: ArrayMethodType.ReadOnly,
  keys: ArrayMethodType.ReadOnly,
  lastIndexOf: ArrayMethodType.ReadOnly,
  map: ArrayMethodType.ReadOnly,
  pop: ArrayMethodType.ReadWrite,
  push: ArrayMethodType.WriteOnly,
  reduce: ArrayMethodType.ReadOnly,
  reduceRight: ArrayMethodType.ReadOnly,
  reverse: ArrayMethodType.ReadWrite,
  shift: ArrayMethodType.ReadWrite,
  slice: ArrayMethodType.ReadOnly,
  some: ArrayMethodType.ReadOnly,
  sort: ArrayMethodType.ReadWrite,
  splice: ArrayMethodType.ReadWrite,
  toLocaleString: ArrayMethodType.ReadOnly,
  toString: ArrayMethodType.ReadOnly,
  unshift: ArrayMethodType.WriteOnly,
  values: ArrayMethodType.ReadOnly,
  with: ArrayMethodType.ReadOnly,
};

export function createQueryResultProxy<T>(
  valueCell: CellImpl<T>,
  valuePath: PropertyKey[],
  log?: ReactivityLog
): T {
  log?.reads.push({ cell: valueCell, path: valuePath });

  // Follow path, following aliases and cells, so might end up on different cell
  let target = valueCell.get() as any;
  const keys = [...valuePath];
  valuePath = [];
  while (keys.length) {
    const key = keys.shift()!;
    if (isQueryResultForDereferencing(target)) {
      const ref = target[getCellReference];
      valueCell = ref.cell;
      valuePath = ref.path;
    } else if (isAlias(target)) {
      const ref = followAliases(target, valueCell, log);
      valueCell = ref.cell;
      valuePath = ref.path;
    } else if (isCell(target)) {
      valueCell = target;
      valuePath = [];
      log?.reads.push({ cell: valueCell, path: valuePath });
      target = target.get();
    } else if (isCellReference(target)) {
      const ref = followCellReferences(target, log);
      valueCell = ref.cell;
      valuePath = ref.path;
    }
    valuePath.push(key);
    if (typeof target === "object" && target !== null) {
      target = target[key as keyof typeof target];
    } else {
      target = undefined;
    }
  }

  // Now target is the end of the path. It might still be a cell, alias or cell
  // reference, so we follow these as well.
  if (isQueryResult(target)) {
    const ref = target[getCellReference];
    return createQueryResultProxy(ref.cell, ref.path, log);
  } else if (isCell(target)) {
    return createQueryResultProxy(target, [], log);
  } else if (isAlias(target)) {
    const ref = followAliases(target, valueCell, log);
    return createQueryResultProxy(ref.cell, ref.path, log);
  } else if (isCellReference(target)) {
    const ref = followCellReferences(target, log);
    return createQueryResultProxy(ref.cell, ref.path, log);
  } else if (typeof target !== "object" || target === null) return target;

  return new Proxy(target as object, {
    get: (target, prop, receiver) => {
      if (typeof prop === "symbol") {
        if (prop === getCellReference)
          return { cell: valueCell, path: valuePath } satisfies CellReference;
        if (prop === toOpaqueRef)
          return () => makeOpaqueRef(valueCell, valuePath);

        const value = Reflect.get(target, prop, receiver);
        if (typeof value === "function") return value.bind(receiver);
        else return value;
      }

      if (Array.isArray(target) && prop in arrayMethods) {
        const method = Array.prototype[prop as keyof typeof Array.prototype];
        const isReadWrite = arrayMethods[prop as keyof typeof arrayMethods];

        return isReadWrite === ArrayMethodType.ReadOnly
          ? (...args: any[]) => {
              // This will also mark each element read in the log. Almost all
              // methods implicitly read all elements. TODO: Deal with
              // exceptions like at().
              const copy = target.map((_, index) =>
                createQueryResultProxy(valueCell, [...valuePath, index], log)
              );

              return method.apply(copy, args);
            }
          : (...args: any[]) => {
              // Operate on a copy so we can diff. For write-only methods like
              // push, don't proxy the other members so we don't log reads.
              // Wraps values in a proxy that remembers the original index and
              // creates cell value proxies on demand.
              let copy: any;
              if (isReadWrite === ArrayMethodType.WriteOnly) copy = [...target];
              else
                copy = target.map((_, index) =>
                  createProxyForArrayValue(
                    index,
                    valueCell,
                    [...valuePath, index],
                    log
                  )
                );

              let result = method.apply(copy, args);

              // Unwrap results and return as value proxies
              if (isProxyForArrayValue(result)) result = result.valueOf();
              else if (Array.isArray(result))
                result = result.map((value) =>
                  isProxyForArrayValue(value) ? value.valueOf() : value
                );

              if (isReadWrite === ArrayMethodType.ReadWrite)
                // Undo the proxy wrapping and assign original items.
                copy = copy.map((value: any) =>
                  isProxyForArrayValue(value)
                    ? target[value[originalIndex]]
                    : value
                );

              // Turn any newly added elements into cells. And if there was a
              // change at all, update the cell.
              normalizeToCells(copy, target, log, valueCell.entityId);
              setNestedValue(valueCell, valuePath, copy, log);

              return result;
            };
      }

      return createQueryResultProxy(valueCell, [...valuePath, prop], log);
    },
    set: (target, prop, value) => {
      if (isQueryResult(value)) value = value[getCellReference];

      if (Array.isArray(target) && prop === "length") {
        const oldLength = target.length;
        const result = setNestedValue(
          valueCell,
          [...valuePath, prop],
          value,
          log
        );
        const newLength = value;
        if (result) {
          for (
            let i = Math.min(oldLength, newLength);
            i < Math.max(oldLength, newLength);
            i++
          ) {
            log?.writes.push({ cell: valueCell, path: [...valuePath, i] });
            queueEvent({ cell: valueCell, path: [...valuePath, i] }, undefined);
          }
        }
        return result;
      }

      // Make sure that any nested arrays are made of cells.
      normalizeToCells(value, undefined, log, {
        cell: valueCell.entityId,
        path: [...valuePath, prop],
      });

      if (isCell(value))
        value = { cell: value, path: [] } satisfies CellReference;

      // When setting a value in an array, make sure it's a cell reference.
      if (Array.isArray(target) && !isCellReference(value)) {
        value = { cell: cell(value), path: [] };
        log?.writes.push(value);
      }

      return setNestedValue(valueCell, [...valuePath, prop], value, log);
    },
  }) as T;
}

// Wraps a value on an array so that it can be read as literal or object,
// yet when copied will remember the original array index.
type ProxyForArrayValue = {
  valueOf: () => any;
  toString: () => string;
  [originalIndex]: number;
};
const originalIndex = Symbol("original index");

const createProxyForArrayValue = (
  source: number,
  valueCell: CellImpl<any>,
  valuePath: PropertyKey[],
  log?: ReactivityLog
): { [originalIndex]: number } => {
  const target = {
    valueOf: function () {
      return createQueryResultProxy(valueCell, valuePath, log);
    },
    toString: function () {
      return String(createQueryResultProxy(valueCell, valuePath, log));
    },
    [originalIndex]: source,
  };

  return target;
};

const cellToOpaqueRef = new WeakMap<
  Frame,
  WeakMap<CellImpl<any>, { path: PropertyKey[]; proxy: OpaqueRef<any> }[]>
>();

// Creates aliases to value, used in recipes to refer to this specific cell. We
// have to memoize these, as conversion happens at multiple places when
// creaeting the recipe.
function makeOpaqueRef(
  valueCell: CellImpl<any>,
  valuePath: PropertyKey[]
): OpaqueRef<any> {
  const frame = getTopFrame();
  if (!frame) throw new Error("No frame");
  if (!cellToOpaqueRef.has(frame)) cellToOpaqueRef.set(frame, new WeakMap());
  let proxies = cellToOpaqueRef.get(frame)!.get(valueCell);
  if (!proxies) {
    proxies = [];
    cellToOpaqueRef.get(frame)!.set(valueCell, proxies);
  }
  let proxy = proxies.find((p) => arrayEqual(valuePath, p.path))?.proxy;
  if (!proxy) {
    proxy = opaqueRef();
    for (const key of valuePath) proxy = proxy.key(key);
    proxy.setPreExisting({ $alias: { cell: valueCell, path: valuePath } });
    proxies.push({ path: valuePath, proxy });
  }
  return proxy;
}

function isProxyForArrayValue(value: any): value is ProxyForArrayValue {
  return typeof value === "object" && value !== null && originalIndex in value;
}

/**
 * Get cell reference or return values as is if not a cell value proxy.
 *
 * @param {any} value - The value to get the cell reference or value from.
 * @returns {CellReference | any}
 */
export function getCellReferenceOrValue(value: any): CellReference {
  if (isQueryResult(value)) return value[getCellReference];
  else return value;
}

/**
 * Get cell reference or throw if not a cell value proxy.
 *
 * @param {any} value - The value to get the cell reference from.
 * @returns {CellReference}
 * @throws {Error} If the value is not a cell value proxy.
 */
export function getCellReferenceOrThrow(value: any): CellReference {
  if (isQueryResult(value)) return value[getCellReference];
  else throw new Error("Value is not a cell proxy");
}

/**
 * Check if value is a cell.
 *
 * @param {any} value - The value to check.
 * @returns {boolean}
 */
export function isCell(value: any): value is CellImpl<any> {
  return (
    typeof value === "object" && value !== null && value[isCellMarker] === true
  );
}

const isCellMarker = Symbol("isCell");

/**
 * Check if value is a simple cell.
 *
 * @param {any} value - The value to check.
 * @returns {boolean}
 */
export function isRendererCell(value: any): value is RendererCell<any> {
  return (
    typeof value === "object" &&
    value !== null &&
    value[isRendererCellMarker] === true
  );
}

const isRendererCellMarker = Symbol("isRendererCell");

/**
 * Check if value is a cell reference.
 *
 * @param {any} value - The value to check.
 * @returns {boolean}
 */
export function isCellReference(value: any): value is CellReference {
  return (
    typeof value === "object" &&
    value !== null &&
    isCell(value.cell) &&
    Array.isArray(value.path)
  );
}

/**
 * Check if value is a cell proxy.
 *
 * @param {any} value - The value to check.
 * @returns {boolean}
 */
export function isQueryResult(value: any): value is QueryResult<any> {
  return (
    typeof value === "object" &&
    value !== null &&
    value[getCellReference] !== undefined
  );
}

const getCellReference = Symbol("isQueryResultProxy");

/**
 * Check if value is a cell proxy. Return as type that allows dereferencing, but
 * not using the proxy.
 *
 * @param {any} value - The value to check.
 * @returns {boolean}
 */
export function isQueryResultForDereferencing(
  value: any
): value is QueryResultInternals {
  return isQueryResult(value);
}

/**
 * Check if value is a reactive cell.
 *
 * @param {any} value - The value to check.
 * @returns {boolean}
 */
export const isReactive = <T = any>(
  value: ReactiveCell<T>
): value is ReactiveCell<T> => {
  return (
    typeof value === "object" &&
    "sink" in value &&
    typeof value.sink === "function"
  );
};

/**
 * Check if value is a gettable cell.
 *
 * @param {any} value - The value to check.
 * @returns {boolean}
 */
export const isGettable = <T = any>(
  value: GettableCell<T>
): value is GettableCell<T> => {
  return (
    typeof value === "object" &&
    "get" in value &&
    typeof value.get === "function"
  );
};

/**
 * Check if value is a sendable cell.
 *
 * @param {any} value - The value to check.
 * @returns {boolean}
 */
export const isSendable = <T = any>(
  value: SendableCell<T>
): value is SendableCell<T> => {
  return (
    typeof value === "object" &&
    "send" in value &&
    typeof value.send === "function"
  );
};
