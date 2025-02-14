import { isAlias, isStreamAlias } from "@commontools/builder";
import {
  cell as opaqueRef,
  deepEqual,
  type Frame,
  getTopFrame,
  getValueAtPath,
  type JSONSchema,
  type OpaqueRef,
  setValueAtPath,
  toOpaqueRef,
} from "@commontools/builder";
import {
  arrayEqual,
  followAliases,
  followCellReferences,
  normalizeToCells,
  pathAffected,
  setNestedValue,
  followLinks,
  compactifyPaths,
} from "./utils.js";
import { queueEvent, subscribe } from "./scheduler.js";
import {
  createRef,
  type EntityId,
  getDocByEntityId,
  getEntityId,
  setDocByEntityId,
} from "./cell-map.js";
import { useCancelGroup, type Cancel } from "./cancel.js";
import { validateAndTransform } from "./schema.js";

/**
 * This is the regular Cell interface, generated by DocImpl.asCell().
 *
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
 * @returns {function} - A function to Cleanup the callback.
 *
 * @method updates Adds a callback that is called on cell changes.
 * @param {function} callback - The callback to be called when the cell changes.
 * @returns {function} - A function to Cleanup the callback.
 *
 * @method getAsProxy Returns a value proxy for the cell.
 * @param {Path} path - The path to follow.
 * @returns {QueryResult<DeepKeyLookup<T, Path>>}
 *
 * @method getAsCellReference Returns a cell reference for the cell.
 * @returns {DocLink}
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
export interface Cell<T> {
  get(): T;
  set(value: T): void;
  send(value: T): void;
  update(value: Partial<T>): void;
  push(
    value:
      | (T extends Array<infer U> ? U : any)
      | DocImpl<T extends Array<infer U> ? U : any>
      | DocLink,
  ): void;
  sink(callback: (value: T) => void): () => void;
  updates(callback: (value: T) => void): () => void;
  key<K extends keyof T>(valueKey: K): Cell<T[K]>;
  asSchema(schema: JSONSchema): Cell<T>;
  getAsQueryResult<Path extends PropertyKey[]>(
    path?: Path,
    log?: ReactivityLog,
  ): QueryResult<DeepKeyLookup<T, Path>>;
  getAsDocLink(): DocLink;
  toJSON(): { "/": string } | undefined;
  value: T;
  docLink: DocLink;
  entityId: EntityId | undefined;
  [isCellMarker]: true;
  copyTrap: boolean;
  schema?: JSONSchema;
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
    log?: ReactivityLog,
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
    path?: Path,
    log?: ReactivityLog,
    schema?: JSONSchema,
  ): Cell<DeepKeyLookup<Q, Path>>;

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

/**
 * Doc link.
 *
 * A doc link is a doc and a path within that doc.
 *
 * Values proxies (DocImpl.getAsProxy) transparently follow these references
 * and create them when assigning a value from another cell.
 *
 * Cells (DocImpl.asCell) expose these as other cells.
 */
export type DocLink = {
  cell: DocImpl<any>;
  path: PropertyKey[];
};

export type QueryResultInternals = {
  [getDocLink]: DocLink;
};

export type QueryResult<T> = T & QueryResultInternals;

/**
 * Reactivity log.
 *
 * Used to log reads and writes to cells. Used by scheduler to keep track of
 * dependencies and to topologically sort pending actions before executing them.
 */
export type ReactivityLog = {
  reads: DocLink[];
  writes: DocLink[];
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

export function getDoc<T>(value?: T, cause?: any): DocImpl<T> {
  const callbacks = new Set<(value: T, path: PropertyKey[]) => void>();
  let readOnly = false;
  let entityId: EntityId | undefined;
  let sourceCell: DocImpl<any> | undefined;
  let ephemeral = false;

  // If cause is provided, generate ID and return pre-existing cell if any.
  if (cause) {
    entityId = generateEntityId(value, cause);
    const existing = getDocByEntityId(entityId, false);
    if (existing) return existing;
  }

  const self: DocImpl<T> = {
    get: () => value as T,
    getAsQueryResult: <Path extends PropertyKey[]>(path?: Path, log?: ReactivityLog) =>
      createQueryResultProxy(self, path ?? [], log) as QueryResult<DeepKeyLookup<T, Path>>,
    asCell: <Q = T, Path extends PropertyKey[] = []>(
      path?: Path,
      log?: ReactivityLog,
      schema?: JSONSchema,
    ) => createCell<Q>(self, path || [], log, schema),
    send: (newValue: T, log?: ReactivityLog) => self.setAtPath([], newValue, log),
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
        // Call each callback. Snapshot via [...callbacks] as the set of
        // callbacks can change during the execution of the callbacks.
        for (const callback of [...callbacks]) callback(value as T, path);
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
      entityId = generateEntityId(value, cause);
      setDocByEntityId(entityId, self);
    },
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
    get entityId(): EntityId | undefined {
      return entityId;
    },
    set entityId(id: EntityId) {
      if (entityId) throw new Error("Entity ID already set");
      entityId = id;
      setDocByEntityId(id, self);
    },
    get sourceCell(): DocImpl<any> | undefined {
      return sourceCell;
    },
    set sourceCell(cell: DocImpl<any> | undefined) {
      if (sourceCell && sourceCell !== cell) {
        throw new Error(
          `Source cell already set: ${JSON.stringify(sourceCell)} -> ${JSON.stringify(cell)}`,
        );
      }
      sourceCell = cell;
    },
    get ephemeral(): boolean {
      return ephemeral;
    },
    set ephemeral(value: boolean) {
      ephemeral = value;
    },
    [toOpaqueRef]: () => makeOpaqueRef(self, []),
    [isDocMarker]: true,
    get copyTrap(): boolean {
      throw new Error("Copy trap: Don't copy cells, create references instead");
    },
  };

  if (entityId) setDocByEntityId(entityId, self);
  return self;
}

function generateEntityId(value: any, cause?: any): EntityId {
  return createRef(
    typeof value === "object" && value !== null
      ? (value as Object)
      : value !== undefined
        ? { value }
        : {},
    cause,
  );
}

function createCell<T>(
  doc: DocImpl<any>,
  path: PropertyKey[] = [],
  log?: ReactivityLog,
  schema?: JSONSchema,
): Cell<T> {
  // Follow aliases, doc links, etc. in path, so that we end up on the right
  // doc, meaning the one that contains the value we want to access without any
  // redirects in between.
  //
  // If the path points to a redirect itself, we don't want to follow it: Other
  // functions will do that. We just want to skip the interim ones.
  //
  // Let's look at a few examples:
  //
  // Doc: { link }, path: [] --> no change
  // Doc: { link }, path: ["foo"] --> follow link, path: ["foo"]
  // Doc: { foo: { link } }, path: ["foo"] --> no change
  // Doc: { foo: { link } }, path: ["foo", "bar"] --> follow link, path: ["bar"]

  let ref: DocLink = { cell: doc, path: [] };
  const seen: DocLink[] = [];

  let keys = [...path];
  while (keys.length) {
    // First follow all the aliases and links, _before_ accessing the key.
    ref = followLinks(ref, seen, log);
    doc = ref.cell;
    path = [...ref.path, ...keys];

    // Now access the key.
    const key = keys.shift()!;
    ref = { cell: doc, path: [...ref.path, key] };
  }

  // Follow aliases on the last key, but no other kinds of links.
  if (isAlias(ref.cell.getAtPath(ref.path))) {
    ref = followAliases(ref.cell.getAtPath(ref.path), ref.cell, log);
    doc = ref.cell;
    path = ref.path;
  }

  // Then follow the other links and see whether this is a stream alias.
  ref = followLinks(ref, seen, log);
  const isStream = isStreamAlias(ref.cell.getAtPath(ref.path));

  if (isStream) return createStreamCell(ref.cell, ref.path);
  else return createRegularCell(doc, path, log, schema);
}

function createStreamCell<T>(doc: DocImpl<any>, path: PropertyKey[]): Cell<T> {
  const listeners = new Set<(event: T) => void>();

  const self: Cell<T> = {
    // Implementing just the subset of Cell<T> that is needed for streams.
    send: (event: T) => {
      queueEvent({ cell: doc, path }, event);
      listeners.forEach((callback) => callback(event));
    },
    sink: (callback: (value: T) => void): Cancel => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    updates: (callback: (value: T) => void): Cancel => self.sink(callback),
  } as Cell<T>;

  return self;
}

function createRegularCell<T>(
  doc: DocImpl<any>,
  path: PropertyKey[],
  log?: ReactivityLog,
  schema?: JSONSchema,
): Cell<T> {
  const self: Cell<T> = {
    get: () => validateAndTransform(doc, path, schema, log),
    set: (newValue: T) => doc.setAtPath(path, newValue, log),
    send: (newValue: T) => self.set(newValue),
    update: (value: Partial<T>) => {
      const previousValue = doc.getAtPath(path);
      if (typeof previousValue !== "object" || previousValue === null)
        throw new Error("Can't update non-object value");
      const newValue = {
        ...previousValue,
        ...value,
      };
      doc.setAtPath(path, newValue, log);
    },
    push: (value: any) => {
      const array = doc.getAtPath(path) ?? [];
      if (!Array.isArray(array)) throw new Error("Can't push into non-array value");

      // Every element pushed to the array should be it's own doc or link to
      // one. So if it isn't already, make it one.
      if (isCell(value)) {
        value = value.getAsDocLink();
      } else if (isDoc(value)) {
        value = { cell: value, path: [] };
      } else {
        value = getDocLinkOrValue(value);
        if (!isDocLink(value)) {
          const cause = {
            parent: doc.entityId,
            path: path,
            length: array.length,
            // Context is the event id in event handlers, making this unique.
            // TODO: In this case it shouldn't depend on the length, maybe
            // instead just call order in the current context.
            context: getTopFrame()?.cause ?? "unknown",
          };

          value = { cell: getDoc<any>(value, cause), path: [] };
        }
      }

      doc.setAtPath(path, [...array, value], log);
    },
    sink: (callback: (value: T) => void) =>
      subscribeToReferencedDocs(doc, path, schema, callback, true),
    updates: (callback: (value: T) => void) =>
      subscribeToReferencedDocs(doc, path, schema, callback, false),
    key: <K extends keyof T>(key: K) => {
      const currentSchema =
        schema?.type === "object"
          ? (schema.properties?.[key as string] ??
            (typeof schema.additionalProperties === "object"
              ? schema.additionalProperties
              : undefined))
          : schema?.type === "array"
            ? schema.items
            : undefined;
      return doc.asCell([...path, key], log, currentSchema) as Cell<T[K]>;
    },
    asSchema: (newSchema: JSONSchema) => createCell(doc, path, log, newSchema),
    getAsQueryResult: (subPath: PropertyKey[] = [], newLog?: ReactivityLog) =>
      createQueryResultProxy(doc, [...path, ...subPath], newLog ?? log),
    getAsDocLink: () => ({ cell: doc, path }) satisfies DocLink,
    toJSON: () => doc.toJSON(),
    get value(): T {
      return self.get();
    },
    get docLink(): DocLink {
      return { cell: doc, path };
    },
    get entityId(): EntityId | undefined {
      return getEntityId(self.getAsDocLink());
    },
    [isCellMarker]: true,
    get copyTrap(): boolean {
      throw new Error("Copy trap: Don't copy renderer cells. Create references instead.");
    },
    schema,
  };

  return self;
}

function subscribeToReferencedDocs<T>(
  doc: DocImpl<any>,
  path: PropertyKey[],
  schema: JSONSchema | undefined,
  callback: (value: T) => void,
  callCallbackOnFirstRun: boolean,
): Cancel {
  const initialLog = { reads: [], writes: [] } satisfies ReactivityLog;

  // Get the value once to determine all the docs that need to be subscribed to.
  const value = validateAndTransform(doc, path, schema, initialLog) as T;

  // Subscribe to the docs that are read (via logs), call callback on next change.
  const cancel = subscribe(
    (log) => callback(validateAndTransform(doc, path, schema, log) as T),
    initialLog,
  );

  // Call the callback once with initial valueif requested.
  if (callCallbackOnFirstRun) callback(value);

  return cancel;
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
  valueCell: DocImpl<T>,
  valuePath: PropertyKey[],
  log?: ReactivityLog,
): T {
  log?.reads.push({ cell: valueCell, path: valuePath });

  // Follow path, following aliases and cells, so might end up on different cell
  let target = valueCell.get() as any;
  const keys = [...valuePath];
  valuePath = [];
  while (keys.length) {
    const key = keys.shift()!;
    if (isQueryResultForDereferencing(target)) {
      const ref = target[getDocLink];
      valueCell = ref.cell;
      valuePath = [...ref.path];
      log?.reads.push({ cell: valueCell, path: valuePath });
      target = ref.cell.getAtPath(ref.path);
    } else if (isAlias(target)) {
      const ref = followAliases(target, valueCell, log);
      valueCell = ref.cell;
      valuePath = [...ref.path];
      log?.reads.push({ cell: valueCell, path: valuePath });
      target = ref.cell.getAtPath(ref.path);
    } else if (isDoc(target)) {
      valueCell = target;
      valuePath = [];
      log?.reads.push({ cell: valueCell, path: valuePath });
      target = target.get();
    } else if (isDocLink(target)) {
      const ref = followCellReferences(target, log);
      valueCell = ref.cell;
      valuePath = [...ref.path];
      log?.reads.push({ cell: valueCell, path: valuePath });
      target = ref.cell.getAtPath(ref.path);
    }
    valuePath.push(key);
    if (typeof target === "object" && target !== null) {
      target = target[key as keyof typeof target];
    } else {
      target = undefined;
    }
  }

  if (valuePath.length > 30) {
    console.warn("Query result with long path [2]", JSON.stringify(valuePath));
  }

  // Now target is the end of the path. It might still be a cell, alias or cell
  // reference, so we follow these as well.
  if (isQueryResult(target)) {
    const ref = target[getDocLink];
    return createQueryResultProxy(ref.cell, ref.path, log);
  } else if (isDoc(target)) {
    return createQueryResultProxy(target, [], log);
  } else if (isAlias(target)) {
    const ref = followAliases(target, valueCell, log);
    return createQueryResultProxy(ref.cell, ref.path, log);
  } else if (isDocLink(target)) {
    const ref = followCellReferences(target, log);
    return createQueryResultProxy(ref.cell, ref.path, log);
  } else if (typeof target !== "object" || target === null) return target;

  return new Proxy(target as object, {
    get: (target, prop, receiver) => {
      if (typeof prop === "symbol") {
        if (prop === getDocLink) {
          return { cell: valueCell, path: valuePath } satisfies DocLink;
        } else if (prop === toOpaqueRef) {
          return () => makeOpaqueRef(valueCell, valuePath);
        }

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
                createQueryResultProxy(valueCell, [...valuePath, index], log),
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
              else {
                copy = target.map((_, index) =>
                  createProxyForArrayValue(index, valueCell, [...valuePath, index], log),
                );
              }

              let result = method.apply(copy, args);

              // Unwrap results and return as value proxies
              if (isProxyForArrayValue(result)) result = result.valueOf();
              else if (Array.isArray(result)) {
                result = result.map((value) =>
                  isProxyForArrayValue(value) ? value.valueOf() : value,
                );
              }

              if (isReadWrite === ArrayMethodType.ReadWrite) {
                // Undo the proxy wrapping and assign original items.
                copy = copy.map((value: any) =>
                  isProxyForArrayValue(value) ? target[value[originalIndex]] : value,
                );
              }

              // Turn any newly added elements into cells. And if there was a
              // change at all, update the cell.
              normalizeToCells(valueCell, copy, target, log, {
                parent: valueCell.entityId,
                method: prop,
                call: new Error().stack,
                context: getTopFrame()?.cause ?? "unknown",
              });
              setNestedValue(valueCell, valuePath, copy, log);

              if (Array.isArray(result)) {
                if (!valueCell.entityId) {
                  throw new Error("No entity id for cell holding array");
                }

                const cause = {
                  parent: valueCell.entityId,
                  path: valuePath,
                  resultOf: prop,
                  call: new Error().stack,
                  context: getTopFrame()?.cause ?? "unknown",
                };
                normalizeToCells(valueCell, result, undefined, log, cause);

                const resultCell = getDoc<any[]>(undefined, cause);
                resultCell.send(result);

                result = resultCell.getAsQueryResult([], log);
              }

              return result;
            };
      }

      return createQueryResultProxy(valueCell, [...valuePath, prop], log);
    },
    set: (target, prop, value) => {
      if (isQueryResult(value)) value = value[getDocLink];

      if (Array.isArray(target) && prop === "length") {
        const oldLength = target.length;
        const result = setNestedValue(valueCell, [...valuePath, prop], value, log);
        const newLength = value;
        if (result) {
          for (let i = Math.min(oldLength, newLength); i < Math.max(oldLength, newLength); i++) {
            log?.writes.push({ cell: valueCell, path: [...valuePath, i] });
            queueEvent({ cell: valueCell, path: [...valuePath, i] }, undefined);
          }
        }
        return result;
      }

      // Make sure that any nested arrays are made of cells.
      normalizeToCells(valueCell, value, undefined, log, {
        cell: valueCell.entityId,
        path: [...valuePath, prop],
      });

      if (isDoc(value)) value = { cell: value, path: [] } satisfies DocLink;

      // When setting a value in an array, make sure it's a cell reference.
      if (Array.isArray(target) && !isDocLink(value)) {
        const ref = {
          cell: getDoc(undefined, {
            list: { cell: valueCell.entityId, path: valuePath },
            previous:
              Number(prop) > 0
                ? (target[Number(prop) - 1].cell?.entityId ?? Number(prop) - 1)
                : null,
          }),
          path: [],
        };
        ref.cell.send(value);
        ref.cell.sourceCell = valueCell;

        log?.writes.push(ref);

        value = ref;
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
  valueCell: DocImpl<any>,
  valuePath: PropertyKey[],
  log?: ReactivityLog,
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

const docLinkToOpaqueRef = new WeakMap<
  Frame,
  WeakMap<DocImpl<any>, { path: PropertyKey[]; opaqueRef: OpaqueRef<any> }[]>
>();

// Creates aliases to value, used in recipes to refer to this specific cell. We
// have to memoize these, as conversion happens at multiple places when
// creaeting the recipe.
function makeOpaqueRef(doc: DocImpl<any>, path: PropertyKey[]): OpaqueRef<any> {
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

function isProxyForArrayValue(value: any): value is ProxyForArrayValue {
  return typeof value === "object" && value !== null && originalIndex in value;
}

/**
 * Get cell reference or return values as is if not a cell value proxy.
 *
 * @param {any} value - The value to get the cell reference or value from.
 * @returns {DocLink | any}
 */
export function getDocLinkOrValue(value: any): DocLink {
  if (isQueryResult(value)) return value[getDocLink];
  else return value;
}

/**
 * Get cell reference or throw if not a cell value proxy.
 *
 * @param {any} value - The value to get the cell reference from.
 * @returns {DocLink}
 * @throws {Error} If the value is not a cell value proxy.
 */
export function getDocLinkOrThrow(value: any): DocLink {
  if (isQueryResult(value)) return value[getDocLink];
  else throw new Error("Value is not a cell proxy");
}

/**
 * Check if value is a cell.
 *
 * @param {any} value - The value to check.
 * @returns {boolean}
 */
export function isDoc(value: any): value is DocImpl<any> {
  return typeof value === "object" && value !== null && value[isDocMarker] === true;
}

const isDocMarker = Symbol("isDoc");

/**
 * Check if value is a simple cell.
 *
 * @param {any} value - The value to check.
 * @returns {boolean}
 */
export function isCell(value: any): value is Cell<any> {
  return typeof value === "object" && value !== null && value[isCellMarker] === true;
}

const isCellMarker = Symbol("isCell");

/**
 * Check if value is a cell reference.
 *
 * @param {any} value - The value to check.
 * @returns {boolean}
 */
export function isDocLink(value: any): value is DocLink {
  return (
    typeof value === "object" && value !== null && isDoc(value.cell) && Array.isArray(value.path)
  );
}

/**
 * Check if value is a cell proxy.
 *
 * @param {any} value - The value to check.
 * @returns {boolean}
 */
export function isQueryResult(value: any): value is QueryResult<any> {
  return typeof value === "object" && value !== null && value[getDocLink] !== undefined;
}

const getDocLink = Symbol("isQueryResultProxy");

/**
 * Check if value is a cell proxy. Return as type that allows dereferencing, but
 * not using the proxy.
 *
 * @param {any} value - The value to check.
 * @returns {boolean}
 */
export function isQueryResultForDereferencing(value: any): value is QueryResultInternals {
  return isQueryResult(value);
}

/**
 * this is a helper created for the spell-style recipe prototype...
 */
export function doc<T = any>(value: any) {
  return getDoc<T>(value).getAsQueryResult();
}
