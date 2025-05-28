import { getTopFrame, toOpaqueRef } from "@commontools/builder";
import { type DocImpl, makeOpaqueRef } from "./doc.ts";
import { type CellLink } from "./cell.ts";
import { type ReactivityLog } from "./scheduler.ts";
import { diffAndUpdate, resolveLinkToValue, setNestedValue } from "./utils.ts";

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
  // Resolve path and follow links to actual value.
  ({ cell: valueCell, path: valuePath } = resolveLinkToValue(
    valueCell,
    valuePath,
    log,
  ));

  log?.reads.push({ cell: valueCell, path: valuePath });
  const target = valueCell.getAtPath(valuePath) as any;

  if (typeof target !== "object" || target === null) return target;

  return new Proxy(target as object, {
    get: (target, prop, receiver) => {
      if (typeof prop === "symbol") {
        if (prop === getCellLink) {
          return { cell: valueCell, path: valuePath } satisfies CellLink;
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
            else {
              copy = target.map((_, index) =>
                createProxyForArrayValue(index, valueCell, [
                  ...valuePath,
                  index,
                ], log)
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
              copy = copy.map((value: any) =>
                isProxyForArrayValue(value)
                  ? target[value[originalIndex]]
                  : value
              );
            }

            // Turn any newly added elements into cells. And if there was a
            // change at all, update the cell.
            diffAndUpdate(
              { cell: valueCell, path: valuePath },
              copy,
              log,
              {
                parent: valueCell.entityId,
                method: prop,
                call: new Error().stack,
                context: getTopFrame()?.cause ?? "unknown",
              },
            );

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

              if (!valueCell.runtime) {
                throw new Error("No runtime available in document for getDoc");
              }
              const resultCell = valueCell.runtime.documentMap.getDoc<any[]>(
                undefined as unknown as any[],
                cause,
                valueCell.space,
              );
              resultCell.send(result);

              diffAndUpdate(
                { cell: resultCell, path: [] },
                result,
                log,
                cause,
              );

              result = resultCell.getAsQueryResult([], log);
            }

            return result;
          };
      }

      return createQueryResultProxy(valueCell, [...valuePath, prop], log);
    },
    set: (target, prop, value) => {
      if (isQueryResult(value)) value = value[getCellLink];

      if (Array.isArray(target) && prop === "length") {
        const oldLength = target.length;
        const changed = setNestedValue(
          valueCell,
          [...valuePath, prop],
          value,
          log,
        );
        const newLength = value;
        if (changed) {
          for (
            let i = Math.min(oldLength, newLength);
            i < Math.max(oldLength, newLength);
            i++
          ) {
            log?.writes.push({ cell: valueCell, path: [...valuePath, i] });
            if (valueCell.runtime) {
              valueCell.runtime.scheduler.queueEvent({ cell: valueCell, path: [...valuePath, i] }, undefined);
            }
          }
        }
        return true;
      }

      diffAndUpdate(
        { cell: valueCell, path: [...valuePath, prop] },
        value,
        log,
        getTopFrame()?.cause ?? "unknown",
      );

      return true;
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

function isProxyForArrayValue(value: any): value is ProxyForArrayValue {
  return typeof value === "object" && value !== null && originalIndex in value;
}

/**
 * Get cell link or return values as is if not a cell value proxy.
 *
 * @param {any} value - The value to get the cell link or value from.
 * @returns {CellLink | any}
 */
export function getCellLinkOrValue(value: any): CellLink {
  if (isQueryResult(value)) return value[getCellLink];
  else return value;
}

/**
 * Get cell link or throw if not a cell value proxy.
 *
 * @param {any} value - The value to get the cell link from.
 * @returns {CellLink}
 * @throws {Error} If the value is not a cell value proxy.
 */
export function getCellLinkOrThrow(value: any): CellLink {
  if (isQueryResult(value)) return value[getCellLink];
  else throw new Error("Value is not a cell proxy");
}

/**
 * Check if value is a cell value proxy.
 *
 * @param {any} value - The value to check.
 * @returns {boolean}
 */
export function isQueryResult(value: any): value is QueryResult<any> {
  return typeof value === "object" && value !== null &&
    value[getCellLink] !== undefined;
}

const getCellLink = Symbol("isQueryResultProxy");

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
  [getCellLink]: CellLink;
};

export type QueryResult<T> = T & QueryResultInternals;
