import { isAlias } from "@commontools/builder";
import { getTopFrame, toOpaqueRef } from "@commontools/builder";
import {
  type DocImpl,
  type DocLink,
  getDoc,
  isDoc,
  isDocLink,
  makeOpaqueRef,
} from "./doc.ts";
import { queueEvent, type ReactivityLog } from "./scheduler.ts";
import {
  normalizeToDocLinks,
  resolveLinkToValue,
  setNestedValue,
} from "./utils.ts";

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
            normalizeToDocLinks(valueCell, copy, target, log, {
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
              normalizeToDocLinks(valueCell, result, undefined, log, cause);

              const resultCell = getDoc<any[]>(
                undefined as unknown as any[],
                cause,
                valueCell.space,
              );
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
        const result = setNestedValue(
          valueCell,
          [...valuePath, prop],
          value,
          log,
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
      normalizeToDocLinks(valueCell, value, undefined, log, {
        cell: valueCell.entityId,
        path: [...valuePath, prop],
      });

      if (isDoc(value)) value = { cell: value, path: [] } satisfies DocLink;

      // When setting a value in an array, make sure it's a cell reference.
      if (Array.isArray(target) && !isDocLink(value)) {
        const ref = {
          cell: getDoc(
            undefined,
            {
              list: { cell: valueCell.entityId, path: valuePath },
              previous: Number(prop) > 0
                ? (target[Number(prop) - 1].cell?.entityId ?? Number(prop) - 1)
                : null,
            },
            valueCell.space,
          ),
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

function isProxyForArrayValue(value: any): value is ProxyForArrayValue {
  return typeof value === "object" && value !== null && originalIndex in value;
}

/**
 * Get doc link or return values as is if not a cell value proxy.
 *
 * @param {any} value - The value to get the doc link or value from.
 * @returns {DocLink | any}
 */
export function getDocLinkOrValue(value: any): DocLink {
  if (isQueryResult(value)) return value[getDocLink];
  else return value;
}

/**
 * Get doc link or throw if not a cell value proxy.
 *
 * @param {any} value - The value to get the doc link from.
 * @returns {DocLink}
 * @throws {Error} If the value is not a cell value proxy.
 */
export function getDocLinkOrThrow(value: any): DocLink {
  if (isQueryResult(value)) return value[getDocLink];
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
    value[getDocLink] !== undefined;
}

const getDocLink = Symbol("isQueryResultProxy");

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
  [getDocLink]: DocLink;
};

export type QueryResult<T> = T & QueryResultInternals;
