import { isStreamAlias } from "@commontools/builder";
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
import { followLinks, prepareForSaving, resolvePath } from "./utils.ts";
import { queueEvent, type ReactivityLog, subscribe } from "./scheduler.ts";
import { type EntityId, getDocByEntityId, getEntityId } from "./cell-map.ts";
import { type Cancel, isCancel, useCancelGroup } from "./cancel.ts";
import { validateAndTransform } from "./schema.ts";
import { Space } from "./space.ts";

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
  equals(other: Cell<any>): boolean;
  sink(callback: (value: T) => Cancel | undefined | void): Cancel;
  key<K extends keyof T>(valueKey: K): Cell<T[K]>;
  asSchema(schema?: JSONSchema): Cell<T>;
  withLog(log: ReactivityLog): Cell<T>;
  getAsQueryResult<Path extends PropertyKey[]>(
    path?: Path,
    log?: ReactivityLog,
  ): QueryResult<DeepKeyLookup<T, Path>>;
  getAsDocLink(): DocLink;
  getSourceCell<T = any>(schema?: JSONSchema): Cell<T> | undefined;
  toJSON(): { cell: { "/": string } | undefined; path: PropertyKey[] };
  value: T;
  docLink: DocLink;
  entityId: EntityId | undefined;
  [isCellMarker]: true;
  copyTrap: boolean;
  schema?: JSONSchema;
}

export interface Stream<T> {
  send(event: T): void;
  sink(callback: (event: T) => Cancel | undefined | void): Cancel;
  [isStreamMarker]: true;
}

export function getCellFromEntityId<T>(
  space: Space,
  entityId: EntityId,
  path: PropertyKey[] = [],
  schema?: JSONSchema,
  log?: ReactivityLog,
): Cell<T> {
  const doc = getDocByEntityId(space, entityId, true)!;
  return createCell(doc, path, log, schema);
}

export function getCellFromDocLink<T>(
  space: Space, // TODO(seefeld): Read from DocLink once it's defined there
  docLink: DocLink,
  schema?: JSONSchema,
  log?: ReactivityLog,
): Cell<T> {
  const doc = isDoc(docLink.cell)
    ? docLink.cell
    : getDocByEntityId(space, getEntityId(docLink.cell)!, true)!;
  return createCell(doc, docLink.path, log, schema);
}

export function getImmutableCell<T>(
  data: T,
  schema?: JSONSchema,
  log?: ReactivityLog,
): Cell<T> {
  const doc = getDoc<T>(data);
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
  const ref = followLinks(resolvePath(doc, path));
  if (isStreamAlias(ref.cell.getAtPath(ref.path))) {
    return createStreamCell(ref.cell, ref.path) as unknown as Cell<T>;
  } else return createRegularCell(doc, path, log, schema, rootSchema);
}

function createStreamCell<T>(
  doc: DocImpl<any>,
  path: PropertyKey[],
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
  const self: Cell<T> = {
    get: () => validateAndTransform(doc, path, schema, log, rootSchema),
    set: (newValue: T) => {
      // TODO(seefeld): This doesn't respect aliases on write. Should it?
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
    update: (value: Partial<T>) => {
      // TODO(seefeld): This doesn't respect aliases on write. Should it?
      const ref = resolvePath(doc, path, log);
      const previousValue = ref.cell.getAtPath(ref.path);
      if (typeof previousValue !== "object" || previousValue === null) {
        throw new Error("Can't update non-object value");
      }
      const newValue = {
        ...previousValue,
        ...value,
      };
      ref.cell.setAtPath(ref.path, newValue, log);
    },
    push: (value: any) => {
      const ref = resolvePath(doc, path, log);
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
    key: <K extends keyof T>(key: K) => {
      const currentSchema = schema?.type === "object"
        ? (schema.properties?.[key as string] ??
          (typeof schema.additionalProperties === "object"
            ? schema.additionalProperties
            : undefined))
        : schema?.type === "array"
        ? schema.items
        : undefined;
      return createCell(
        doc,
        [...path, key],
        log,
        currentSchema,
        rootSchema,
      ) as Cell<T[K]>;
    },
    asSchema: (newSchema?: JSONSchema) =>
      createCell(doc, path, log, newSchema, newSchema),
    withLog: (newLog: ReactivityLog) =>
      createCell(doc, path, newLog, schema, rootSchema),
    getAsQueryResult: (subPath: PropertyKey[] = [], newLog?: ReactivityLog) =>
      createQueryResultProxy(doc, [...path, ...subPath], newLog ?? log),
    getAsDocLink: () => ({ cell: doc, path }) satisfies DocLink,
    getSourceCell: <T = any>(schema?: JSONSchema) =>
      doc.sourceCell?.asCell([], log, schema) as Cell<T> | undefined,
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
  };

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
