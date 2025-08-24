import { isRecord } from "@commontools/utils/types";
import { opaqueRef } from "./builder/opaque-ref.ts";
import { getTopFrame } from "./builder/recipe.ts";
import {
  type Frame,
  type JSONSchema,
  type OpaqueRef,
  type Schema,
} from "./builder/types.ts";
import { toOpaqueRef } from "./back-to-cell.ts";
import { type Cell, createCell } from "./cell.ts";

import { type EntityId } from "./doc-map.ts";
import type { IRuntime } from "./runtime.ts";
import { arrayEqual } from "./path-utils.ts";
import { toURI } from "./uri-utils.ts";
import type {
  IExtendedStorageTransaction,
  Labels,
  MemorySpace,
} from "./storage/interface.ts";

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
    tx?: IExtendedStorageTransaction,
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
  let sourceCell: DocImpl<any> | undefined;

  const self: DocImpl<T> = {
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
