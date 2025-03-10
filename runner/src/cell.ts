import { isStreamAlias, TYPE } from "@commontools/builder";
import { getTopFrame, type JSONSchema } from "@commontools/builder";
import {
  type DeepKeyLookup,
  type DocImpl,
  type DocLink,
  getDoc,
  isDoc,
  isDocLink,
} from "./doc.ts";
import {
  createQueryResultProxy,
  getDocLinkOrValue,
  type QueryResult,
} from "./query-result-proxy.ts";
import { prepareForSaving, resolveLinkToValue, resolvePath } from "./utils.ts";
import { queueEvent, type ReactivityLog, subscribe } from "./scheduler.ts";
import { type EntityId, getDocByEntityId, getEntityId } from "./doc-map.ts";
import { type Cancel, isCancel, useCancelGroup } from "./cancel.ts";
import { validateAndTransform } from "./schema.ts";
import { type Schema } from "@commontools/builder";
import { Space } from "./space.ts";

/**
 * Check if value is a simple cell.
 *
 * @param {any} value - The value to check.
 * @returns {boolean}
 */
export function isCell(value: any): value is Cell<any> {
  return typeof value === "object" && value !== null &&
    value[isCellMarker] === true;
}

const isCellMarker = Symbol("isCell");

export function isStream(value: any): value is Stream<any> {
  return typeof value === "object" && value !== null &&
    value[isStreamMarker] === true;
}

const isStreamMarker = Symbol("isStream");

/**
* HACKS
*/

class StreamImpl<T> implements Stream<T> {
  private readonly _doc: DocImpl<any>;
  private readonly _path: PropertyKey[];
  private readonly _listeners = new Set<(event: T) => Cancel | undefined>();
  private _cleanup?: Cancel;

  constructor(doc: DocImpl<any>, path: PropertyKey[]) {
    this._doc = doc;
    this._path = path;
  }

  send(event: T): void {
    queueEvent({ cell: this._doc, path: this._path }, event);

    this._cleanup?.();
    const [cancel, addCancel] = useCancelGroup();
    this._cleanup = cancel;

    this._listeners.forEach((callback) => addCancel(callback(event)));
  }

  sink(callback: (value: T) => Cancel | undefined): Cancel {
    this._listeners.add(callback);
    return () => this._listeners.delete(callback);
  }

  [isStreamMarker] = true as const;
}

class CellImpl<T> implements Cell<T> {
  // Private fields to store cell state
  private readonly _doc: DocImpl<any>;
  private readonly _path: PropertyKey[];
  private readonly _log?: ReactivityLog;
  private readonly _schema?: JSONSchema;
  private readonly _rootSchema?: JSONSchema;

  constructor(doc: DocImpl<any>, path: PropertyKey[] = [], log?: ReactivityLog,
    schema?: JSONSchema, rootSchema: JSONSchema | undefined = schema) {
    this._doc = doc;
    this._path = path;
    this._log = log;
    this._schema = schema;
    this._rootSchema = rootSchema;
  }

  get(): T {
    return validateAndTransform(this._doc, this._path, this._schema, this._log, this._rootSchema);
  }

  set(newValue: T): void {
    const ref = resolvePath(this._doc, this._path, this._log);
    if (prepareForSaving(
      ref.cell,
      newValue,
      ref.cell.getAtPath(ref.path),
      this._log,
      {
        parent: getTopFrame()?.cause,
        doc: ref.cell,
        path: ref.path,
      }
    )) {
      ref.cell.setAtPath(ref.path, newValue, this._log);
    }
  }

  send(newValue: T): void {
    this.set(newValue);
  }

  update(values: Partial<T>): void {
    if (typeof values !== "object" || values === null) {
      throw new Error("Can't update with non-object value");
    }
    for (const [key, value] of Object.entries(values)) {
      // Workaround for type checking, since T can be Cell<> and that's fine.
      (this.key as any)(key).set(value);
    }
  }

  push(value: any): void {
    // Follow aliases and references, since we want to get to an assumed
    // existing array.
    const ref = resolveLinkToValue(this._doc, this._path, this._log);
    const array = ref.cell.getAtPath(ref.path) ?? [];
    if (!Array.isArray(array)) {
      throw new Error("Can't push into non-array value");
    }

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
          parent: this._doc.entityId,
          path: this._path,
          length: array.length,
          // Context is the event id in event handlers, making this unique.
          // TODO(seefeld): In this case it shouldn't depend on the length, maybe
          // instead just call order in the current context.
          context: getTopFrame()?.cause ?? "unknown",
        };

        value = { cell: getDoc<any>(value, cause, this._doc.space), path: [] };
      }
    }

    ref.cell.setAtPath(ref.path, [...array, value], this._log);
  }

  equals(other: Cell<any>): boolean {
    return JSON.stringify(this) === JSON.stringify(other);
  }

  sink(callback: (value: T) => Cancel | undefined): Cancel {
    return subscribeToReferencedDocs(callback, this._doc, this._path, this._schema, this._rootSchema);
  }

  key<K extends T extends Cell<infer S> ? keyof S : keyof T>(
    valueKey: K
  ): Cell<T extends Cell<infer S> ? S[K & keyof S] : T[K] extends never ? any : T[K]> {
    const currentSchema = this._schema?.type === "object"
      ? (this._schema.properties?.[valueKey as string] ??
        (typeof this._schema.additionalProperties === "object"
          ? this._schema.additionalProperties
          : undefined))
      : this._schema?.type === "array"
        ? this._schema.items
        : undefined;
    return createCell(
      this._doc,
      [...this._path, valueKey],
      this._log,
      currentSchema,
      this._rootSchema,
    ) as Cell<T extends Cell<infer S> ? S[K & keyof S] : T[K] extends never ? any : T[K]>;
  }

  setRaw(newValue: T): void {
    const ref = resolvePath(this._doc, this._path, this._log);
    ref.cell.setAtPath(ref.path, newValue, this._log);
  }

  asSchema<T>(newSchema?: JSONSchema): Cell<T>;
  asSchema<S extends JSONSchema = JSONSchema>(newSchema: S): Cell<Schema<S>>;
  asSchema(newSchema?: JSONSchema): Cell<any> {
    return createCell(this._doc, this._path, this._log, newSchema, newSchema);
  }

  withLog(newLog: ReactivityLog): Cell<T> {
    return createCell(this._doc, this._path, newLog, this._schema, this._rootSchema);
  }

  getAsQueryResult<Path extends PropertyKey[]>(
    subPath: Path = [] as unknown as Path,
    newLog?: ReactivityLog
  ): QueryResult<DeepKeyLookup<T, Path>> {
    return createQueryResultProxy(this._doc, [...this._path, ...subPath], newLog ?? this._log);
  }

  getAsDocLink(): DocLink {
    return { cell: this._doc, path: this._path } satisfies DocLink;
  }

  getSourceCell<T>(schema?: JSONSchema): Cell<T & { [TYPE]: string | undefined } & ("argument" extends keyof T ? unknown : { argument: any })>;
  getSourceCell<S extends JSONSchema = JSONSchema>(schema: S): Cell<Schema<S> & { [TYPE]: string | undefined } & ("argument" extends keyof Schema<S> ? unknown : { argument: any })>;
  getSourceCell(schema?: JSONSchema): Cell<any> {
    return this._doc.sourceCell?.asCell([], this._log, schema) as Cell<any>;
  }

  toJSON(): { cell: { "/": string } | undefined; path: PropertyKey[] } {
    // TODO(seefeld): Should this include the schema, as cells are defiined by doclink & schema?
    return { cell: this._doc.toJSON(), path: this._path } satisfies {
      cell: { "/": string } | undefined;
      path: PropertyKey[];
    };
  }

  get value(): T {
    return this.get();
  }

  get docLink(): DocLink {
    return { cell: this._doc, path: this._path };
  }

  get entityId(): EntityId | undefined {
    return getEntityId(this.getAsDocLink());
  }

  get schema(): JSONSchema | undefined {
    return this._schema;
  }

  // Symbol properties
  [isCellMarker] = true as const;

  get copyTrap(): boolean {
    throw new Error("Copy trap: Don't copy renderer cells. Create references instead.");
  }
}

/**
 * This is the regular Cell interface, generated by DocImpl.asCell().
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
 * @param {U | DocImpl<U> | DocLink} value - The value to add, where U is the
 * array element type.
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
 * @method setRaw Sets the value of the cell without transforming it at all.
 * @param {T} value - The value to set.
 * @returns {void}
 *
 * @method asSchema Creates a new cell with a specific schema.
 * @param {JSONSchema} schema - The schema to apply.
 * @returns {Cell<T>} - A cell with the specified schema.
 *
 * @method withLog Creates a new cell with a specific reactivity log.
 * @param {ReactivityLog} log - The log to use.
 * @returns {Cell<T>}
 *
 * @method sink Adds a callback that is called immediately and on cell changes.
 * @param {function} callback - The callback to be called when the cell changes.
 * @returns {function} - A function to Cleanup the callback.
 *
 * @method getAsQueryResult Returns a query result for the cell.
 * @param {Path} path - The optional path to follow.
 * @param {ReactivityLog} log - Optional reactivity log.
 * @returns {QueryResult<DeepKeyLookup<T, Path>>}
 *
 * @method getAsDocLink Returns a document link for the cell.
 * @returns {DocLink}
 *
 * @method getSourceCell Returns the source cell with optional schema.
 * @param {JSONSchema} schema - Optional schema to apply.
 * @returns {Cell<T & {[TYPE]: string | undefined} & {argument: any}>}
 *
 * @method toJSON Returns a serializable doclink (not the contents) to the cell.
 * @returns {{cell: {"/": string} | undefined, path: PropertyKey[]}}
 *
 * @method value Returns the current value of the cell.
 * @returns {T}
 *
 * @property docLink The document link representing this cell.
 * @returns {DocLink}
 *
 * @property entityId Returns the current entity ID of the cell.
 * @returns {EntityId | undefined}
 *
 * @property schema Optional schema for the cell.
 * @returns {JSONSchema | undefined}
 */
export interface Cell<T> {
  get(): T;
  set(value: T): void;
  send(value: T): void;
  update(values: Partial<T>): void;
  push(
    value:
      | (T extends Array<infer U> ? U : any)
      | DocImpl<T extends Array<infer U> ? U : any>
      | DocLink,
  ): void;
  equals(other: Cell<any>): boolean;
  sink(callback: (value: T) => Cancel | undefined | void): Cancel;
  key<K extends T extends Cell<infer S> ? keyof S : keyof T>(
    valueKey: K,
  ): Cell<
    T extends Cell<infer S> ? S[K & keyof S] : T[K] extends never ? any : T[K]
  >;
  setRaw(value: T): void;
  asSchema<T>(
    schema?: JSONSchema,
  ): Cell<T>;
  asSchema<S extends JSONSchema = JSONSchema>(
    schema: S,
  ): Cell<Schema<S>>;
  withLog(log: ReactivityLog): Cell<T>;
  getAsQueryResult<Path extends PropertyKey[]>(
    path?: Path,
    log?: ReactivityLog,
  ): QueryResult<DeepKeyLookup<T, Path>>;
  getAsDocLink(): DocLink;
  getSourceCell<T>(
    schema?: JSONSchema,
  ): Cell<
    & T
    // Add default types for TYPE and `argument`. A more specific type in T will
    // take precedence.
    & { [TYPE]: string | undefined }
    & ("argument" extends keyof T ? unknown : { argument: any })
  >;
  getSourceCell<S extends JSONSchema = JSONSchema>(
    schema: S,
  ): Cell<
    & Schema<S>
    // Add default types for TYPE and `argument`. A more specific type in
    // `schema` will take precedence.
    & { [TYPE]: string | undefined }
    & ("argument" extends keyof Schema<S> ? unknown
      : { argument: any })
  >;
  toJSON(): { cell: { "/": string } | undefined; path: PropertyKey[] };
  value: T;
  docLink: DocLink;
  entityId: EntityId | undefined;
  [isCellMarker]: true;
  copyTrap: boolean;
  schema?: JSONSchema;
  rootSchema?: JSONSchema;
}

type TypeOrSchema<T, S extends JSONSchema | undefined = JSONSchema> = T extends
  never ? S extends JSONSchema ? Schema<S>
  : any
  : T;

export interface Stream<T> {
  send(event: T): void;
  sink(callback: (event: T) => Cancel | undefined | void): Cancel;
  schema?: JSONSchema;
  rootSchema?: JSONSchema;
  [isStreamMarker]: true;
}

export function getCell<T>(
  space: Space,
  cause: any,
  schema?: JSONSchema,
  log?: ReactivityLog,
): Cell<T>;
export function getCell<S extends JSONSchema = JSONSchema>(
  space: Space,
  cause: any,
  schema: S,
  log?: ReactivityLog,
): Cell<Schema<S>>;
export function getCell(
  space: Space,
  cause: any,
  schema?: JSONSchema,
  log?: ReactivityLog,
): Cell<any> {
  const doc = getDoc<any>(undefined as any, cause, space);
  return createCell(doc, [], log, schema);
}

export function getCellFromEntityId<T>(
  space: Space,
  entityId: EntityId,
  path?: PropertyKey[],
  schema?: JSONSchema,
  log?: ReactivityLog,
): Cell<T>;
export function getCellFromEntityId<S extends JSONSchema = JSONSchema>(
  space: Space,
  entityId: EntityId,
  path: PropertyKey[],
  schema: S,
  log?: ReactivityLog,
): Cell<Schema<S>>;
export function getCellFromEntityId(
  space: Space,
  entityId: EntityId,
  path: PropertyKey[] = [],
  schema?: JSONSchema,
  log?: ReactivityLog,
): Cell<any> {
  const doc = getDocByEntityId(space, entityId, true)!;
  return createCell(doc, path, log, schema);
}

export function getCellFromDocLink<T>(
  space: Space,
  docLink: DocLink,
  schema?: JSONSchema,
  log?: ReactivityLog,
): Cell<T>;
export function getCellFromDocLink<S extends JSONSchema = JSONSchema>(
  space: Space,
  docLink: DocLink,
  schema: S,
  log?: ReactivityLog,
): Cell<Schema<S>>;
export function getCellFromDocLink(
  space: Space, // TODO(seefeld): Read from DocLink once it's defined there
  docLink: DocLink,
  schema?: JSONSchema,
  log?: ReactivityLog,
): Cell<any> {
  const doc = isDoc(docLink.cell)
    ? docLink.cell
    : getDocByEntityId(space, getEntityId(docLink.cell)!, true)!;
  return createCell(doc, docLink.path, log, schema);
}

export function getImmutableCell<T>(
  space: Space,
  data: T,
  schema?: JSONSchema,
  log?: ReactivityLog,
): Cell<T>;
export function getImmutableCell<S extends JSONSchema = JSONSchema>(
  space: Space,
  data: any,
  schema: S,
  log?: ReactivityLog,
): Cell<Schema<S>>;
export function getImmutableCell(
  space: Space,
  data: any,
  schema?: JSONSchema,
  log?: ReactivityLog,
): Cell<any> {
  const doc = getDoc<any>(data, { immutable: data }, space);
  doc.freeze();
  return createCell(doc, [], log, schema);
}

export function createCell<T>(
  doc: DocImpl<any>,
  path: PropertyKey[] = [],
  log?: ReactivityLog,
  schema?: JSONSchema,
  rootSchema: JSONSchema | undefined = schema,
): Cell<T> {
  // Resolve the path to check whether it's a stream. We're not logging this right now.
  // The corner case where during it's lifetime this changes from non-stream to stream
  // or vice versa will not be detected.
  const ref = resolveLinkToValue(doc, path);
  if (isStreamAlias(ref.cell.getAtPath(ref.path))) {
    return createStreamCell(
      ref.cell,
      ref.path,
      log,
      schema,
      rootSchema,
    ) as unknown as Cell<T>;
  } else return createRegularCell(doc, path, log, schema, rootSchema);
}

function createStreamCell<T>(
  doc: DocImpl<any>,
  path: PropertyKey[],
  _log?: ReactivityLog,
  schema?: JSONSchema,
  rootSchema?: JSONSchema,
): Stream<T> {
  const listeners = new Set<(event: T) => Cancel | undefined>();

  let cleanup: Cancel | undefined;

  const self: Stream<T> = {
    // Implementing just the subset of Cell<T> that is needed for streams.
    send: (event: T) => {
      queueEvent({ cell: doc, path }, event);

      cleanup?.();
      const [cancel, addCancel] = useCancelGroup();
      cleanup = cancel;

      listeners.forEach((callback) => addCancel(callback(event)));
    },
    sink: (callback: (value: T) => Cancel | undefined): Cancel => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    schema,
    rootSchema,
    [isStreamMarker]: true,
  } satisfies Stream<T>;

  return self;
}

function createRegularCell<T>(
  doc: DocImpl<any>,
  path: PropertyKey[],
  log?: ReactivityLog,
  schema?: JSONSchema,
  rootSchema?: JSONSchema,
): Cell<T> {
  const self = {
    get: () => validateAndTransform(doc, path, schema, log, rootSchema),
    set: (newValue: T) => {
      const ref = resolvePath(doc, path, log);
      if (
        prepareForSaving(
          ref.cell,
          newValue,
          ref.cell.getAtPath(ref.path),
          log,
          {
            parent: getTopFrame()?.cause,
            doc: ref.cell,
            path: ref.path,
          },
        )
      ) {
        ref.cell.setAtPath(ref.path, newValue, log);
      }
    },
    send: (newValue: T) => self.set(newValue),
    update: (values: Partial<T>) => {
      if (typeof values !== "object" || values === null) {
        throw new Error("Can't update with non-object value");
      }
      for (const [key, value] of Object.entries(values)) {
        // Workaround for type checking, since T can be Cell<> and that's fine.
        (self.key as any)(key).set(value);
      }
    },
    push: (value: any) => {
      // Follow aliases and references, since we want to get to an assumed
      // existing array.
      const ref = resolveLinkToValue(doc, path, log);
      const array = ref.cell.getAtPath(ref.path) ?? [];
      if (!Array.isArray(array)) {
        throw new Error("Can't push into non-array value");
      }

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
            // TODO(seefeld): In this case it shouldn't depend on the length, maybe
            // instead just call order in the current context.
            context: getTopFrame()?.cause ?? "unknown",
          };

          value = { cell: getDoc<any>(value, cause, doc.space), path: [] };
        }
      }

      ref.cell.setAtPath(ref.path, [...array, value], log);
    },
    equals: (other: Cell<any>) =>
      JSON.stringify(self) === JSON.stringify(other),
    sink: (callback: (value: T) => Cancel | undefined) =>
      subscribeToReferencedDocs(callback, doc, path, schema, rootSchema),
    key: <K extends T extends Cell<infer S> ? keyof S : keyof T>(
      valueKey: K,
    ): T extends Cell<infer S> ? Cell<S[K & keyof S]> : Cell<T[K]> => {
      const currentSchema = schema?.type === "object"
        ? (schema.properties?.[valueKey as string] ??
          (typeof schema.additionalProperties === "object"
            ? schema.additionalProperties
            : undefined))
        : schema?.type === "array"
          ? schema.items
          : undefined;
      return createCell(
        doc,
        [...path, valueKey],
        log,
        currentSchema,
        rootSchema,
      ) as T extends Cell<infer S> ? Cell<S[K & keyof S]> : Cell<T[K]>;
    },
    setRaw: (newValue: T) => {
      const ref = resolvePath(doc, path, log);
      ref.cell.setAtPath(ref.path, newValue, log);
    },

    asSchema: (newSchema?: JSONSchema) =>
      createCell(doc, path, log, newSchema, newSchema),
    withLog: (newLog: ReactivityLog) =>
      createCell(doc, path, newLog, schema, rootSchema),
    getAsQueryResult: (subPath: PropertyKey[] = [], newLog?: ReactivityLog) =>
      createQueryResultProxy(doc, [...path, ...subPath], newLog ?? log),
    getAsDocLink: () => ({ cell: doc, path }) satisfies DocLink,
    getSourceCell: (schema?: JSONSchema) =>
      doc.sourceCell?.asCell([], log, schema) as Cell<any>,
    toJSON: () =>
      // TODO(seefeld): Should this include the schema, as cells are defiined by doclink & schema?
      ({ cell: doc.toJSON(), path }) satisfies {
        cell: { "/": string } | undefined;
        path: PropertyKey[];
      },
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
      throw new Error(
        "Copy trap: Don't copy renderer cells. Create references instead.",
      );
    },
    schema,
    rootSchema,
  } as Cell<T>;

  return self;
}

function subscribeToReferencedDocs<T>(
  callback: (value: T) => Cancel | undefined,
  doc: DocImpl<any>,
  path: PropertyKey[],
  schema: JSONSchema | undefined,
  rootSchema: JSONSchema | undefined,
): Cancel {
  const initialLog = {
    reads: [],
    writes: [],
  } satisfies ReactivityLog;
  // Get the value once to determine all the docs that need to be subscribed to.
  const value = validateAndTransform(
    doc,
    path,
    schema,
    initialLog,
    rootSchema,
  ) as T;

  // Call the callback once with initial value if requested.
  let cleanup: Cancel | undefined = callback(value);

  // Subscribe to the docs that are read (via logs), call callback on next change.
  const cancel = subscribe((log) => {
    if (isCancel(cleanup)) cleanup();
    const newValue = validateAndTransform(
      doc,
      path,
      schema,
      log,
      rootSchema,
    ) as T;
    cleanup = callback(newValue);
  }, initialLog);

  return () => {
    cancel();
    if (isCancel(cleanup)) cleanup();
  };
}
