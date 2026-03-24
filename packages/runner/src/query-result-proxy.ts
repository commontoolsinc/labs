import { refer } from "@commontools/memory/reference";
import { isRecord } from "@commontools/utils/types";
import { getTopFrame } from "./builder/pattern.ts";
import { isStreamValue } from "./builder/types.ts";
import { toCell } from "./back-to-cell.ts";
import {
  recordCfcReadObservation,
  withInternalVerifierRead,
} from "./cfc/read-observation-logging.ts";
import { diffAndUpdate } from "./data-updating.ts";
import { readMaybeLink, resolveLink } from "./link-resolution.ts";
import { type NormalizedFullLink } from "./link-utils.ts";
import { type Cell, createCell, recursivelyAddIDIfNeeded } from "./cell.ts";
import { type Runtime } from "./runtime.ts";
import { type IExtendedStorageTransaction } from "./storage/interface.ts";
import { toURI } from "./uri-utils.ts";

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

type InitialObservationMode = "auto" | "skip";
type ShapeOnlyPropertyCheck = "hasOwnProperty" | "propertyIsEnumerable";
type ObservedArrayIteratorKind = "keys" | "values" | "entries";

function observeLink(
  tx: IExtendedStorageTransaction | undefined,
  link: NormalizedFullLink,
  op: "shape" | "value" | "enumerate" | "count" | "followRef",
): void {
  if (tx?.status().status !== "ready") {
    return;
  }
  recordCfcReadObservation(tx, link, { op });
}

function readValueInternally(
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
): any {
  return tx.readValueOrThrow(link, withInternalVerifierRead());
}

function readObservedChildValue(
  runtime: Runtime,
  tx: IExtendedStorageTransaction | undefined,
  link: NormalizedFullLink,
  depth: number,
  writable: boolean,
): any {
  const readTx = (tx?.status().status === "ready") ? tx : runtime.edit();
  const childValue = readValueInternally(readTx, link);
  observeLink(tx, link, "shape");
  if (!isRecord(childValue)) {
    observeLink(tx, link, "value");
    return childValue;
  }
  return createQueryResultProxy(
    runtime,
    tx,
    link,
    depth + 1,
    writable,
    "skip",
  );
}

function normalizeArrayAtIndex(
  length: number,
  indexArg: unknown,
): number | undefined {
  const numericIndex = Number(indexArg ?? 0);
  if (!Number.isFinite(numericIndex)) {
    return undefined;
  }

  const relativeIndex = Number.isNaN(numericIndex)
    ? 0
    : Math.trunc(numericIndex);
  const normalizedIndex = relativeIndex >= 0
    ? relativeIndex
    : length + relativeIndex;

  if (normalizedIndex < 0 || normalizedIndex >= length) {
    return undefined;
  }

  return normalizedIndex;
}

function normalizeArraySliceIndex(
  length: number,
  indexArg: unknown,
  defaultIndex: number,
): number {
  if (indexArg === undefined) {
    return defaultIndex;
  }

  const numericIndex = Number(indexArg);
  if (Number.isNaN(numericIndex) || numericIndex === -Infinity) {
    return 0;
  }
  if (numericIndex === Infinity) {
    return length;
  }

  const relativeIndex = Math.trunc(numericIndex);
  return relativeIndex >= 0
    ? Math.min(relativeIndex, length)
    : Math.max(length + relativeIndex, 0);
}

function normalizeArraySliceBounds(
  length: number,
  startArg: unknown,
  endArg: unknown,
): readonly [number, number] {
  return [
    normalizeArraySliceIndex(length, startArg, 0),
    normalizeArraySliceIndex(length, endArg, length),
  ];
}

function isShapeOnlyPropertyCheck(
  prop: PropertyKey,
): prop is ShapeOnlyPropertyCheck {
  return prop === "hasOwnProperty" || prop === "propertyIsEnumerable";
}

function createObservedArrayIterator(
  runtime: Runtime,
  tx: IExtendedStorageTransaction | undefined,
  link: NormalizedFullLink,
  depth: number,
  writable: boolean,
  kind: ObservedArrayIteratorKind,
): IterableIterator<unknown> {
  let initialized = false;
  let index = 0;
  let length = 0;

  return {
    [Symbol.iterator]() {
      return this;
    },
    next() {
      const readTx = (tx?.status().status === "ready") ? tx : runtime.edit();
      if (!initialized) {
        observeLink(tx, link, "shape");
        observeLink(tx, link, "enumerate");
        observeLink(tx, link, "count");
        length = (readValueInternally(readTx, link) as any[]).length;
        initialized = true;
      }

      if (index >= length) {
        return { value: undefined, done: true };
      }

      const childLink = {
        ...link,
        path: [...link.path, String(index)],
      };
      const currentIndex = index;
      index++;

      if (kind === "keys") {
        observeLink(tx, childLink, "shape");
        return {
          value: currentIndex,
          done: false,
        };
      }

      const observedValue = readObservedChildValue(
        runtime,
        tx,
        childLink,
        depth,
        writable,
      );

      return {
        value: kind === "entries"
          ? [currentIndex, observedValue]
          : observedValue,
        done: false,
      };
    },
  };
}

export function createQueryResultProxy<T>(
  runtime: Runtime,
  tx: IExtendedStorageTransaction | undefined,
  link: NormalizedFullLink,
  depth: number = 0,
  writable: boolean = false,
  initialObservation: InitialObservationMode = "auto",
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
  if (readMaybeLink(readTx, link) !== undefined) {
    observeLink(tx, link, "followRef");
  }
  link = resolveLink(runtime, readTx, link);
  const value = readValueInternally(readTx, link) as any;

  // If the value is a stream marker ({ $stream: true }), return a Cell with
  // stream kind so that .send() is available. This handles the case where a
  // pattern's Output type wasn't explicitly specified, causing the capture
  // schema to lose the asStream information.
  if (isStreamValue(value)) {
    if (initialObservation !== "skip") {
      observeLink(tx, link, "shape");
    }
    return createCell(runtime, link, tx, false, "stream") as T;
  }

  if (!isRecord(value)) {
    if (initialObservation !== "skip") {
      observeLink(tx, link, "value");
    }
    return value;
  }

  if (initialObservation !== "skip") {
    observeLink(tx, link, "shape");
  }

  // When richStorableValues is OFF, frozen objects are terminal values that
  // don't need proxy wrapping (the legacy assumption: "frozen = terminal").
  // When richStorableValues is ON, frozen objects may contain link structures
  // that need resolution, so we fall through to proxy-wrap them below.
  if (Object.isFrozen(value) && !runtime.experimental.richStorableValues) {
    return value as T;
  }

  // When richStorableValues is enabled, stored objects are deep-frozen during
  // storage normalization (storableFromNativeValueRich). A frozen proxy target
  // would force every property access through the invariant guard (ECMAScript
  // 10.5.8: a [[Get]] trap on a non-configurable, non-writable data property
  // must return the target's own value), bypassing the get trap's link
  // resolution entirely.
  //
  // Fix: use an unfrozen empty stub as the proxy target. The stub's contents
  // are irrelevant -- the get trap always reads live data from the transaction,
  // never from the target. The stub only needs to:
  //   1. Be unfrozen, so all properties are configurable (no invariant
  //      conflicts).
  //   2. Match the value's type: [] for arrays (so Array.isArray checks on the
  //      proxy target work) and {} for objects.
  //   3. For arrays, match the length (getOwnPropertyDescriptor returns the
  //      target's non-configurable length property, so it must be correct).
  //
  // Sparse arrays (new Array(n)) are used for array stubs -- JS engines
  // represent these as holey arrays with no element allocation until writes,
  // and we never write to the stub.
  const proxyTarget = Object.isFrozen(value)
    ? (Array.isArray(value) ? new Array(value.length) : {})
    : value;

  // Get the appropriate cache index by log
  const cacheIndex = tx ?? defaultTx;
  let txCache = proxyCacheByTx.get(cacheIndex);
  if (!txCache) {
    txCache = new WeakMap<object, any>();
    proxyCacheByTx.set(cacheIndex, txCache);
  }

  // Check if we already have a proxy for this target in the cache.
  // The cache key is the original `value` (not the stub), ensuring that
  // the same frozen object always maps to the same proxy instance.
  const existingProxy = txCache?.get(value);
  if (existingProxy) return existingProxy;

  const proxy = new Proxy(proxyTarget as object, {
    get: (target, prop, receiver) => {
      if (Array.isArray(value) && prop === "length") {
        observeLink(tx, link, "count");
        const readTx = (tx?.status().status === "ready") ? tx : runtime.edit();
        return (readValueInternally(readTx, link) as any[]).length;
      }

      // When encountering a frozen property, we just return the value to
      // maintain proxy invariants.
      const descriptor = Object.getOwnPropertyDescriptor(target, prop);
      if (descriptor?.configurable === false) {
        return Reflect.get(target, prop, receiver);
      }

      if (typeof prop === "symbol") {
        if (prop === toCell) {
          return () => createCell(runtime, link, tx);
        } else if (prop === Symbol.iterator && Array.isArray(value)) {
          return function () {
            return createObservedArrayIterator(
              runtime,
              tx,
              link,
              depth,
              writable,
              "values",
            );
          };
        }

        const readTx = (tx?.status().status === "ready") ? tx : runtime.edit();
        const current = readValueInternally(readTx, link) as typeof value;

        const returnValue = Reflect.get(current, prop, current);
        if (typeof returnValue === "function") return returnValue.bind(current);
        else return returnValue;
      }

      if (isShapeOnlyPropertyCheck(prop)) {
        const method = Object.prototype[prop];
        return (key: string | symbol) => {
          const readTx = (tx?.status().status === "ready")
            ? tx
            : runtime.edit();
          const current = readValueInternally(readTx, link);
          if (typeof key === "string") {
            observeLink(tx, { ...link, path: [...link.path, key] }, "shape");
          }
          return method.call(current, key);
        };
      }

      if (
        Array.isArray(value) &&
        (prop === "keys" || prop === "values" || prop === "entries")
      ) {
        return function () {
          return createObservedArrayIterator(
            runtime,
            tx,
            link,
            depth,
            writable,
            prop,
          );
        };
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
            if (prop === "at") {
              const readTx = (tx?.status().status === "ready")
                ? tx
                : runtime.edit();
              observeLink(tx, link, "shape");
              observeLink(tx, link, "count");
              const length =
                (readValueInternally(readTx, link) as any[]).length;
              const index = normalizeArrayAtIndex(length, args[0]);
              if (index === undefined) {
                return undefined;
              }
              return readObservedChildValue(
                runtime,
                tx,
                { ...link, path: [...link.path, String(index)] },
                depth,
                writable,
              );
            }

            if (prop === "slice") {
              const readTx = (tx?.status().status === "ready")
                ? tx
                : runtime.edit();
              observeLink(tx, link, "shape");
              observeLink(tx, link, "enumerate");
              observeLink(tx, link, "count");
              const current = readValueInternally(readTx, link) as any[];
              const length = current.length;
              const [start, end] = normalizeArraySliceBounds(
                length,
                args[0],
                args[1],
              );
              const resultLength = Math.max(end - start, 0);
              const result = new Array(resultLength);

              for (let index = start; index < end; index++) {
                const childLink = {
                  ...link,
                  path: [...link.path, String(index)],
                };
                if (Object.hasOwn(current, index)) {
                  result[index - start] = readObservedChildValue(
                    runtime,
                    tx,
                    childLink,
                    depth,
                    writable,
                  );
                  continue;
                }
                observeLink(tx, childLink, "shape");
              }

              return result;
            }

            // This will also mark each element read in the log. Almost all
            // methods implicitly read all elements.
            const readTx = (tx?.status().status === "ready")
              ? tx
              : runtime.edit();
            observeLink(tx, link, "shape");
            observeLink(tx, link, "enumerate");
            observeLink(tx, link, "count");
            const length = (readValueInternally(readTx, link) as any[]).length;

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
                writable,
              );
            }

            return method.apply(copy, args);
          }
          : (...args: any[]) => {
            if (!writable) {
              throw new Error(
                "This value is read-only, declare type as Writable<..> instead to get a writable version",
              );
            }

            if (!tx) {
              throw new Error(
                "Transaction required for mutation\n" +
                  "help: move mutations to handlers, or use computed() for read-only operations",
              );
            }

            // Operate on a copy so we can diff. For write-only methods like
            // push, don't proxy the other members so we don't log reads.
            // Wraps values in a proxy that remembers the original index and
            // creates cell value proxies on demand.
            let copy: any;
            if (isReadWrite === ArrayMethodType.WriteOnly) {
              // CT-1173: Read fresh value from transaction, not stale proxy target.
              // The proxy target (value) is captured at proxy creation time and
              // becomes stale after writes. We must read current state from tx.
              const readTx = (tx?.status().status === "ready")
                ? tx
                : runtime.edit();
              const currentValue = readValueInternally(readTx, link) as any[];
              copy = [...currentValue];
            } else {
              copy = value.map((_, index) =>
                createProxyForArrayValue(
                  runtime,
                  tx,
                  index,
                  { ...link, path: [...link.path, String(index)] },
                  writable,
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

            // Turn any newly added elements into cells by adding [ID] symbols.
            // This ensures objects get stored as separate entity documents
            // rather than inline data, which is critical for persistence.
            const frame = getTopFrame();

            const processedCopy = recursivelyAddIDIfNeeded(copy, frame);

            // And if there was a change at all, update the cell.
            diffAndUpdate(runtime, tx, link, processedCopy, {
              parent: { id: link.id, space: link.space },
              method: prop,
              call: new Error().stack,
              context: frame?.cause ?? "unknown",
            });

            // CT-1173 FIX: Don't mutate proxy target (value) after writes.
            // The old code did `value.splice(0, value.length, ...newValue)` which
            // mutated the heap's stored array because `value` shares a reference
            // with heap state. This caused StorageTransactionInconsistent errors
            // because read invariants would see the written values before commit.
            //
            // The proxy still works correctly without this sync because:
            // 1. Reads go through the transaction which returns fresh values
            // 2. The diffAndUpdate above has already written the changes
            // 3. Subsequent reads via the proxy will see the updated values

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

              result = createQueryResultProxy(
                runtime,
                tx,
                resultLink,
                0,
                writable,
              );
            }

            return result;
          };
      }

      const childLink = {
        ...link,
        path: [...link.path, prop],
      };
      return readObservedChildValue(
        runtime,
        tx,
        childLink,
        depth,
        writable,
      );
    },
    set: (_, prop, value) => {
      if (typeof prop === "symbol") return false;

      if (!writable) {
        throw new Error(
          "This value is read-only, declare type as Writable<..> instead to get a writable version",
        );
      }

      if (isCellResult(value)) value = value[toCell]();

      if (!tx) {
        throw new Error(
          "Transaction required for mutation\n" +
            "help: move mutations to handlers, or use computed() for read-only operations",
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
    ownKeys: () => {
      const readTx = (tx?.status().status === "ready") ? tx : runtime.edit();
      observeLink(tx, link, "shape");
      observeLink(tx, link, "enumerate");
      const current = readValueInternally(readTx, link);
      if (isRecord(current)) {
        const keys = Reflect.ownKeys(current);
        for (const key of keys) {
          if (typeof key !== "string" || key === "length") {
            continue;
          }
          observeLink(tx, { ...link, path: [...link.path, key] }, "shape");
        }
        return keys;
      }
      return Reflect.ownKeys(value);
    },
    getOwnPropertyDescriptor: (target, prop) => {
      // For properties that exist on the original target (e.g. array `length`),
      // delegate to the target to satisfy proxy invariants for non-configurable
      // properties.
      const targetDesc = Object.getOwnPropertyDescriptor(target, prop);
      if (targetDesc && !targetDesc.configurable) {
        return targetDesc;
      }
      if (typeof prop === "symbol") {
        return Object.getOwnPropertyDescriptor(value, prop);
      }
      const readTx = (tx?.status().status === "ready") ? tx : runtime.edit();
      const current = readValueInternally(readTx, link) as typeof value;
      if (isRecord(current) && prop in current) {
        observeLink(
          tx,
          { ...link, path: [...link.path, prop as string] },
          "shape",
        );
        return {
          configurable: true,
          enumerable: true,
          writable: writable,
          value: createQueryResultProxy(
            runtime,
            tx,
            { ...link, path: [...link.path, prop as string] },
            depth + 1,
            writable,
            "skip",
          ),
        };
      }
      return undefined;
    },
    has: (_target, prop) => {
      if (typeof prop === "symbol") {
        return prop in value;
      }
      observeLink(tx, { ...link, path: [...link.path, String(prop)] }, "shape");
      const readTx = (tx?.status().status === "ready") ? tx : runtime.edit();
      const current = readValueInternally(readTx, link);
      if (isRecord(current)) {
        return prop in current;
      }
      return prop in value;
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
  runtime: Runtime,
  tx: IExtendedStorageTransaction | undefined,
  source: number,
  link: NormalizedFullLink,
  writable: boolean = false,
): { [originalIndex]: number } => {
  const target = {
    valueOf: function () {
      return createQueryResultProxy(runtime, tx, link, 0, writable);
    },
    toString: function () {
      return String(createQueryResultProxy(runtime, tx, link, 0, writable));
    },
    [originalIndex]: source,
  };

  return target;
};

function isProxyForArrayValue(value: any): value is ProxyForArrayValue {
  return isRecord(value) && originalIndex in value;
}

/**
 * Get cell or throw if not a cell value proxy.
 *
 * @param {any} value - The value to get the cell from.
 * @returns {Cell<T>}
 * @throws {Error} If the value is not a cell value proxy.
 */
export function getCellOrThrow<T = any>(value: any): Cell<T> {
  if (isCellResult(value)) return value[toCell]();
  else throw new Error("Value is not a cell proxy");
}

/**
 * Check if value is a cell value proxy.
 *
 * @param {any} value - The value to check.
 * @returns {boolean}
 */
export function isCellResult(value: any): value is CellResult<any> {
  return isRecord(value) && typeof value[toCell] === "function";
}

/**
 * Check if value is a cell value proxy. Return as type that allows
 * dereferencing, but not using the proxy.
 *
 * @param {any} value - The value to check.
 * @returns {boolean}
 */
export function isCellResultForDereferencing(
  value: any,
): value is CellResultInternals {
  return isCellResult(value);
}

export type CellResultInternals = {
  [toCell]: () => Cell<unknown>;
};

export type CellResult<T> = T & CellResultInternals;
