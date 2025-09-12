import { refer } from "merkle-reference/json";
import { isRecord } from "@commontools/utils/types";
import { getTopFrame } from "./builder/recipe.ts";
import { type Frame, type OpaqueRef } from "./builder/types.ts";
import { toCell, toOpaqueRef } from "./back-to-cell.ts";
import { opaqueRef } from "./builder/opaque-ref.ts";
import { diffAndUpdate } from "./data-updating.ts";
import { resolveLink } from "./link-resolution.ts";
import { type NormalizedFullLink } from "./link-utils.ts";
import { type Cell, createCell } from "./cell.ts";
import { type IRuntime } from "./runtime.ts";
import { type IExtendedStorageTransaction } from "./storage/interface.ts";
import { fromURI, toURI } from "./uri-utils.ts";

// Maximum recursion depth to prevent infinite loops
const MAX_RECURSION_DEPTH = 100;

// Cache of target objects to their proxies, scoped by ReactivityLog
const proxyCacheByTx = new WeakMap<
  IExtendedStorageTransaction,
  WeakMap<object, any>
>();
// Default key if no tx is provided
const defaultTx = {} as IExtendedStorageTransaction;

// Array.prototype's entries, and whether they modify the array
enum ArrayMethodType {
  ReadOnly,
  ReadWrite,
  WriteOnly,
}

const arrayMethods: { [key: string]: ArrayMethodType } = {
  at: ArrayMethodType.ReadOnly,
  concat: ArrayMethodType.ReadOnly,
  copyWithin: ArrayMethodType.ReadWrite,
  entries: ArrayMethodType.ReadOnly,
  every: ArrayMethodType.ReadOnly,
  fill: ArrayMethodType.WriteOnly,
  filter: ArrayMethodType.ReadOnly,
  find: ArrayMethodType.ReadOnly,
  findIndex: ArrayMethodType.ReadOnly,
  findLast: ArrayMethodType.ReadOnly,
  findLastIndex: ArrayMethodType.ReadOnly,
  flat: ArrayMethodType.ReadOnly,
  flatMap: ArrayMethodType.ReadOnly,
  forEach: ArrayMethodType.ReadOnly,
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
  toReversed: ArrayMethodType.ReadOnly,
  toSorted: ArrayMethodType.ReadOnly,
  toSpliced: ArrayMethodType.ReadOnly,
  unshift: ArrayMethodType.WriteOnly,
  values: ArrayMethodType.ReadOnly,
  with: ArrayMethodType.ReadOnly,

  hasOwnProperty: ArrayMethodType.ReadOnly,
  isPrototypeOf: ArrayMethodType.ReadOnly,
  propertyIsEnumerable: ArrayMethodType.ReadOnly,
  valueOf: ArrayMethodType.ReadOnly,
  toString: ArrayMethodType.ReadOnly,
  toLocaleString: ArrayMethodType.ReadOnly,
};

export function createQueryResultProxy<T>(
  runtime: IRuntime,
  tx: IExtendedStorageTransaction | undefined,
  link: NormalizedFullLink,
  depth: number = 0,
): T {
  // Check recursion depth
  if (depth > MAX_RECURSION_DEPTH) {
    throw new Error(
      `Maximum recursion depth of ${MAX_RECURSION_DEPTH} exceeded`,
    );
  }

  // Resolve path and follow links to actual value.
  const txStatus = tx?.status();
  const readTx = (txStatus?.status === "ready" && tx) ? tx : runtime.edit();
  link = resolveLink(readTx, link);
  const value = readTx.readValueOrThrow(link) as any;

  if (!isRecord(value) || Object.isFrozen(value)) return value;

  // Get the appropriate cache index by log
  const cacheIndex = tx ?? defaultTx;
  let txCache = proxyCacheByTx.get(cacheIndex);
  if (!txCache) {
    txCache = new WeakMap<object, any>();
    proxyCacheByTx.set(cacheIndex, txCache);
  }

  // Check if we already have a proxy for this target in the cache
  const existingProxy = txCache?.get(value);
  if (existingProxy) return existingProxy;

  const proxy = new Proxy(value as object, {
    get: (target, prop, receiver) => {
      // When encountering a frozen property, we just return the value to
      // maintain proxy invariants.
      const descriptor = Object.getOwnPropertyDescriptor(target, prop);
      if (descriptor?.configurable === false) {
        return Reflect.get(target, prop, receiver);
      }

      if (typeof prop === "symbol") {
        if (prop === toCell) {
          return () => createCell(runtime, link, tx, true);
        } else if (prop === toOpaqueRef) {
          return () => makeOpaqueRef(link);
        }

        const readTx = (tx?.status().status === "ready") ? tx : runtime.edit();
        const current = readTx.readValueOrThrow(link) as typeof value;

        const returnValue = Reflect.get(current, prop, current);
        if (typeof returnValue === "function") return returnValue.bind(current);
        else return returnValue;
      }

      if (
        Array.isArray(value) &&
        Object.prototype.hasOwnProperty.call(arrayMethods, prop) &&
        typeof (value[prop as keyof typeof value]) === "function"
      ) {
        const method = Array.prototype[prop as keyof typeof Array.prototype];
        const isReadWrite = arrayMethods[prop as keyof typeof arrayMethods];

        return isReadWrite === ArrayMethodType.ReadOnly
          ? (...args: any[]) => {
            // This will also mark each element read in the log. Almost all
            // methods implicitly read all elements. TODO: Deal with
            // exceptions like at().
            const readTx = (tx?.status().status === "ready")
              ? tx
              : runtime.edit();
            const length = readTx.readValueOrThrow({
              ...link,
              path: [...link.path, "length"],
            }) as number;

            if (typeof length !== "number") {
              throw new Error(
                `Array length is not a number for ${prop} operation`,
              );
            }

            const copy = new Array(length);
            for (let i = 0; i < length; i++) {
              copy[i] = createQueryResultProxy(
                runtime,
                tx,
                { ...link, path: [...link.path, String(i)] },
                depth + 1,
              );
            }

            return method.apply(copy, args);
          }
          : (...args: any[]) => {
            if (!tx) {
              throw new Error(
                "Transaction required for changing query result proxy",
              );
            }

            // Operate on a copy so we can diff. For write-only methods like
            // push, don't proxy the other members so we don't log reads.
            // Wraps values in a proxy that remembers the original index and
            // creates cell value proxies on demand.
            let copy: any;
            if (isReadWrite === ArrayMethodType.WriteOnly) copy = [...value];
            else {
              copy = value.map((_, index) =>
                createProxyForArrayValue(
                  runtime,
                  tx,
                  index,
                  { ...link, path: [...link.path, String(index)] },
                )
              );
            }

            let result = method.apply(copy, args);

            // Unwrap results and return as value proxies
            if (isProxyForArrayValue(result)) result = result.valueOf();
            else if (Array.isArray(result)) {
              result = result.map((value) =>
                isProxyForArrayValue(value) ? value.valueOf() : value
              );
            }

            if (isReadWrite === ArrayMethodType.ReadWrite) {
              // Undo the proxy wrapping and assign original items.
              copy = copy.map((item: any) =>
                isProxyForArrayValue(item) ? value[item[originalIndex]] : item
              );
            }

            // Turn any newly added elements into cells. And if there was a
            // change at all, update the cell.
            diffAndUpdate(runtime, tx, link, copy, {
              parent: { id: link.id, space: link.space },
              method: prop,
              call: new Error().stack,
              context: getTopFrame()?.cause ?? "unknown",
            });

            // Update target from store
            const newValue = tx.readValueOrThrow(link) as typeof value;

            if (!Array.isArray(newValue)) {
              throw new Error(
                `Array is not an array anymore after ${prop} operation, it's now ${typeof newValue}`,
              );
            }

            value.splice(0, value.length, ...newValue);

            if (Array.isArray(result)) {
              const cause = {
                parent: { id: link.id, path: link.path },
                resultOf: prop,
                call: new Error().stack,
                context: getTopFrame()?.cause ?? "unknown",
              };

              const resultLink: NormalizedFullLink = {
                id: toURI(refer(cause)),
                space: link.space,
                path: [],
                type: "application/json",
              };

              diffAndUpdate(runtime, tx, resultLink, result, cause);

              result = createQueryResultProxy(runtime, tx, resultLink);
            }

            return result;
          };
      }

      return createQueryResultProxy(
        runtime,
        tx,
        { ...link, path: [...link.path, prop] },
        depth + 1,
      );
    },
    set: (_, prop, value) => {
      if (typeof prop === "symbol") return false;

      if (isQueryResult(value)) value = value[toCell]();

      if (!tx) {
        throw new Error(
          "Transaction required for changing query result proxy",
        );
      }

      diffAndUpdate(
        runtime,
        tx,
        { ...link, path: [...link.path, String(prop)] },
        value,
      );

      return true;
    },
  }) as T;

  // Cache the proxy in the appropriate cache before returning
  txCache.set(value, proxy);
  return proxy;
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
  runtime: IRuntime,
  tx: IExtendedStorageTransaction | undefined,
  source: number,
  link: NormalizedFullLink,
): { [originalIndex]: number } => {
  const target = {
    valueOf: function () {
      return createQueryResultProxy(runtime, tx, link);
    },
    toString: function () {
      return String(createQueryResultProxy(runtime, tx, link));
    },
    [originalIndex]: source,
  };

  return target;
};

function isProxyForArrayValue(value: any): value is ProxyForArrayValue {
  return isRecord(value) && originalIndex in value;
}

const linkToOpaqueRef = new WeakMap<
  Frame,
  Map<string, OpaqueRef<any>>
>();

// Creates aliases to value, used in recipes to refer to this specific cell. We
// have to memoize these, as conversion happens at multiple places when
// creaeting the recipe.
export function makeOpaqueRef(
  link: NormalizedFullLink,
): OpaqueRef<any> {
  const frame = getTopFrame();
  if (!frame) throw new Error("No frame");
  if (!linkToOpaqueRef.has(frame)) linkToOpaqueRef.set(frame, new Map());
  const map = linkToOpaqueRef.get(frame)!;

  const id = `${link.space}:${link.id}:${link.path.join(":")}`;
  if (map.has(id)) return map.get(id)!;

  const ref = opaqueRef();
  ref.setPreExisting({
    $alias: { cell: { "/": fromURI(link.id) }, path: link.path },
  });
  map.set(id, ref);
  return ref;
}

/**
 * Get cell or throw if not a cell value proxy.
 *
 * @param {any} value - The value to get the cell from.
 * @returns {Cell<T>}
 * @throws {Error} If the value is not a cell value proxy.
 */
export function getCellOrThrow<T = any>(value: any): Cell<T> {
  if (isQueryResult(value)) return value[toCell]();
  else throw new Error("Value is not a cell proxy");
}

/**
 * Check if value is a cell value proxy.
 *
 * @param {any} value - The value to check.
 * @returns {boolean}
 */
export function isQueryResult(value: any): value is QueryResult<any> {
  return isRecord(value) && typeof value[toCell] === "function";
}

/**
 * Check if value is a cell value proxy. Return as type that allows
 * dereferencing, but not using the proxy.
 *
 * @param {any} value - The value to check.
 * @returns {boolean}
 */
export function isQueryResultForDereferencing(
  value: any,
): value is QueryResultInternals {
  return isQueryResult(value);
}

export type QueryResultInternals = {
  [toCell]: () => Cell<unknown>;
};

export type QueryResult<T> = T & QueryResultInternals;
