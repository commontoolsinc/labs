import { isStreamAlias, TYPE } from "@commontools/builder";
import { getTopFrame, ID, type JSONSchema } from "@commontools/builder";
import { type DeepKeyLookup, type DocImpl, getDoc, isDoc } from "./doc.ts";
import {
  createQueryResultProxy,
  type QueryResult,
} from "./query-result-proxy.ts";
import {
  diffAndUpdate,
  resolveLinkToAlias,
  resolveLinkToValue,
} from "./utils.ts";
import { queueEvent, type ReactivityLog, subscribe } from "./scheduler.ts";
import { type EntityId, getDocByEntityId, getEntityId } from "./doc-map.ts";
import { type Cancel, isCancel, useCancelGroup } from "./cancel.ts";
import { validateAndTransform } from "./schema.ts";
import { type Schema } from "@commontools/builder";

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
 * @param {U | DocImpl<U> | CellLink} value - The value to add, where U is the
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
 * @method getAsCellLink Returns a cell link for the cell.
 * @returns {CellLink}
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
 * @returns {EntityId | undefined}
 *
 * @property schema Optional schema for the cell.
 * @returns {JSONSchema | undefined}
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
 * @returns {CellLink}
 */
export interface Cell<T> {
  get(): T;
  set(value: T): void;
  send(value: T): void;
  update(values: Partial<T>): void;
  push(
    ...value: Array<
      | (T extends Array<infer U> ? U : any)
      | DocImpl<T extends Array<infer U> ? U : any>
      | CellLink
      | Cell<T extends Array<infer U> ? U : any>
    >
  ): void;
  equals(other: Cell<any>): boolean;
  key<K extends T extends Cell<infer S> ? keyof S : keyof T>(
    valueKey: K,
  ): Cell<
    T extends Cell<infer S> ? S[K & keyof S] : T[K] extends never ? any : T[K]
  >;

  asSchema<T>(
    schema?: JSONSchema,
  ): Cell<T>;
  asSchema<S extends JSONSchema = JSONSchema>(
    schema: S,
  ): Cell<Schema<S>>;
  withLog(log: ReactivityLog): Cell<T>;
  sink(callback: (value: T) => Cancel | undefined | void): Cancel;
  getAsQueryResult<Path extends PropertyKey[]>(
    path?: Path,
    log?: ReactivityLog,
  ): QueryResult<DeepKeyLookup<T, Path>>;
  getAsCellLink(): CellLink;
  getDoc(): DocImpl<any>;
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
  schema?: JSONSchema;
  rootSchema?: JSONSchema;
  value: T;
  cellLink: CellLink;
  entityId: EntityId | undefined;
  [isCellMarker]: true;
  copyTrap: boolean;
}

export interface Stream<T> {
  send(event: T): void;
  sink(callback: (event: T) => Cancel | undefined | void): Cancel;
  getDoc(): DocImpl<any>;
  schema?: JSONSchema;
  rootSchema?: JSONSchema;
  [isStreamMarker]: true;
}

/**
 * Cell link.
 *
 * A cell link is a doc and a path within that doc.
 */
export type CellLink = {
  space?: string;
  cell: DocImpl<any>;
  path: PropertyKey[];
  schema?: JSONSchema;
  rootSchema?: JSONSchema;
};

export function getCell<T>(
  space: string,
  cause: any,
  schema?: JSONSchema,
  log?: ReactivityLog,
): Cell<T>;
export function getCell<S extends JSONSchema = JSONSchema>(
  space: string,
  cause: any,
  schema: S,
  log?: ReactivityLog,
): Cell<Schema<S>>;
export function getCell(
  space: string,
  cause: any,
  schema?: JSONSchema,
  log?: ReactivityLog,
): Cell<any> {
  const doc = getDoc<any>(undefined as any, cause, space);
  return createCell(doc, [], log, schema);
}

export function getCellFromEntityId<T>(
  space: string,
  entityId: EntityId,
  path?: PropertyKey[],
  schema?: JSONSchema,
  log?: ReactivityLog,
): Cell<T>;
export function getCellFromEntityId<S extends JSONSchema = JSONSchema>(
  space: string,
  entityId: EntityId,
  path: PropertyKey[],
  schema: S,
  log?: ReactivityLog,
): Cell<Schema<S>>;
export function getCellFromEntityId(
  space: string,
  entityId: EntityId,
  path: PropertyKey[] = [],
  schema?: JSONSchema,
  log?: ReactivityLog,
): Cell<any> {
  const doc = getDocByEntityId(space, entityId, true)!;
  return createCell(doc, path, log, schema);
}

export function getCellFromLink<T>(
  cellLink: CellLink,
  schema?: JSONSchema,
  log?: ReactivityLog,
): Cell<T>;
export function getCellFromLink<S extends JSONSchema = JSONSchema>(
  cellLink: CellLink,
  schema: S,
  log?: ReactivityLog,
): Cell<Schema<S>>;
export function getCellFromLink(
  cellLink: CellLink,
  schema?: JSONSchema,
  log?: ReactivityLog,
): Cell<any> {
  let doc;

  if (isDoc(cellLink.cell)) {
    doc = cellLink.cell;
  } else if (cellLink.space) {
    doc = getDocByEntityId(cellLink.space, getEntityId(cellLink.cell)!, true)!;
    if (!doc) throw new Error(`Can't find ${cellLink.space}/${cellLink.cell}!`);
  } else {
    throw new Error("Cell link has no space");
  }
  return createCell(doc, cellLink.path, log, schema);
}

export function getImmutableCell<T>(
  space: string,
  data: T,
  schema?: JSONSchema,
  log?: ReactivityLog,
): Cell<T>;
export function getImmutableCell<S extends JSONSchema = JSONSchema>(
  space: string,
  data: any,
  schema: S,
  log?: ReactivityLog,
): Cell<Schema<S>>;
export function getImmutableCell(
  space: string,
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

  // Use schema from alias if provided and no explicit schema was set
  if (!schema && ref.schema) {
    schema = ref.schema;
    rootSchema = ref.rootSchema || ref.schema;
  }

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
    getDoc: () => doc,
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
  if (schema) doc.registerSchemaUse(path, schema, rootSchema);

  const self = {
    get: () => validateAndTransform(doc, path, schema, log, rootSchema),
    set: (newValue: T) =>
      diffAndUpdate(
        resolveLinkToAlias(doc, path, log),
        newValue,
        log,
        getTopFrame()?.cause,
      ),
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
    push: (
      ...values: Array<
        | (T extends Array<infer U> ? U : any)
        | DocImpl<T extends Array<infer U> ? U : any>
        | CellLink
        | Cell<T extends Array<infer U> ? U : any>
      >
    ) => {
      // Follow aliases and references, since we want to get to an assumed
      // existing array.
      const ref = resolveLinkToValue(doc, path, log);
      const cause = getTopFrame()?.cause;

      let array = ref.cell.getAtPath(ref.path);
      if (array !== undefined && !Array.isArray(array)) {
        throw new Error("Can't push into non-array value");
      }

      // If this is an object and it doesn't have an ID, add one.
      const valuesToWrite = values.map((value: any) => {
        if (
          !isCell(value) && !isCellLink(value) && !isDoc(value) &&
          !Array.isArray(value) && typeof value === "object" &&
          value !== null &&
          value[ID] === undefined && getTopFrame()
        ) {
          return {
            [ID]: getTopFrame()!.generatedIdCounter++,
            ...value,
          };
        } else {
          return value;
        }
      });

      // If there is no array yet, create it first. We have to do this as a
      // separate operation, so that in the next steps [ID] is properly anchored
      // in the array.
      if (array === undefined) {
        diffAndUpdate(ref, [], log, cause);
        array = Array.isArray(schema?.default) ? schema.default : [];
      }

      // Append the new values to the array.
      diffAndUpdate(ref, [...array, ...valuesToWrite], log, cause);

      const appended = ref.cell.getAtPath(ref.path).slice(
        -valuesToWrite.length,
      );

      // Hacky retry logic for push only. See storage.ts for details on this
      // retry approach and what we should really be doing instead.
      if (!ref.cell.retry) ref.cell.retry = [];
      ref.cell.retry.push((newBaseValue: any[]) => {
        // Unlikely, but maybe the conflict reset to undefined?
        if (newBaseValue === undefined) {
          newBaseValue = Array.isArray(schema?.default) ? schema.default : [];
        }

        // Serialize cell links that were appended during the push. This works
        // because of the .toJSON() method on Cell.
        const newValues = JSON.parse(JSON.stringify(appended));

        // Reappend the new values.
        return [...newBaseValue, ...newValues];
      });
    },
    equals: (other: Cell<any>) =>
      JSON.stringify(self) === JSON.stringify(other),
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

    asSchema: (newSchema?: JSONSchema) =>
      createCell(doc, path, log, newSchema, newSchema),
    withLog: (newLog: ReactivityLog) =>
      createCell(doc, path, newLog, schema, rootSchema),
    sink: (callback: (value: T) => Cancel | undefined) =>
      subscribeToReferencedDocs(callback, doc, path, schema, rootSchema),
    getAsQueryResult: (subPath: PropertyKey[] = [], newLog?: ReactivityLog) =>
      createQueryResultProxy(doc, [...path, ...subPath], newLog ?? log),
    getAsCellLink: () =>
      // Add space here, so that JSON.stringify() of this retains the space.
      ({ space: doc.space, cell: doc, path }) satisfies CellLink,
    getDoc: () => doc,
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
    get cellLink(): CellLink {
      return { space: doc.space, cell: doc, path };
    },
    get entityId(): EntityId | undefined {
      return getEntityId(self.getAsCellLink());
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
 * Check if value is a cell link.
 *
 * @param {any} value - The value to check.
 * @returns {boolean}
 */
export function isCellLink(value: any): value is CellLink {
  return (
    typeof value === "object" && value !== null && isDoc(value.cell) &&
    Array.isArray(value.path)
  );
}
