import { hashOf } from "@commonfabric/data-model/value-hash";
import { FabricPrimitive } from "@commonfabric/data-model/fabric-value";
import { isRecord } from "@commonfabric/utils/types";
import { getTopFrame } from "./builder/pattern.ts";
import { isStreamValue } from "./builder/types.ts";
import { toCell } from "./back-to-cell.ts";
import { diffAndUpdate } from "./data-updating.ts";
import { resolveLink } from "./link-resolution.ts";
import { type NormalizedFullLink } from "./link-utils.ts";
import { type Cell, createCell, recursivelyAddIDIfNeeded } from "./cell.ts";
import { type Runtime } from "./runtime.ts";
import {
  type IExtendedStorageTransaction,
  type IReadOptions,
} from "./storage/interface.ts";
import { mergeableOpRead } from "./storage/reactivity-log.ts";
import { toURI } from "./uri-utils.ts";
import {
  type CfcLabelView,
  cfcLabelViewForDereferenceTraces,
  cloneCfcLabelView,
  mergeCfcLabelViews,
  rebaseCfcLabelView,
} from "./cfc/label-view-state.ts";

// Maximum recursion depth to prevent infinite loops
const MAX_RECURSION_DEPTH = 100;

// Container/shape reads (proxy creation, ownKeys, getOwnPropertyDescriptor, has,
// array length) are recorded as nonRecursive so the engine applies shallow
// (shape-only) conflict granularity to them — matching how the scheduler
// reader-dirty index already treats nonRecursive reads. Value materialization
// (leaf scalars via child-proxy creation, array methods that consume elements)
// stays recursive.
const SHAPE_READ: IReadOptions = { nonRecursive: true };

// Cache of target objects to their proxies, scoped by ReactivityLog
type ProxyCache = {
  byLink: Map<string, any>;
  byValue: WeakMap<object, any>;
};

const proxyCacheByTx = new WeakMap<
  IExtendedStorageTransaction,
  ProxyCache
>();
// Default key if no tx is provided
const defaultTx = {} as IExtendedStorageTransaction;

const getProxyCache = (
  tx: IExtendedStorageTransaction | undefined,
): ProxyCache => {
  const cacheIndex = tx ?? defaultTx;
  let txCache = proxyCacheByTx.get(cacheIndex);
  if (!txCache) {
    txCache = {
      byLink: new Map<string, any>(),
      byValue: new WeakMap<object, any>(),
    };
    proxyCacheByTx.set(cacheIndex, txCache);
  }
  return txCache;
};

const proxyCacheKey = (
  link: NormalizedFullLink,
  writable: boolean,
  cfcLabelView: CfcLabelView | undefined,
): string =>
  JSON.stringify([
    writable,
    link.space,
    link.id,
    link.path,
    cfcLabelView ?? null,
  ]);

const childLabelView = (
  cfcLabelView: CfcLabelView | undefined,
  segment: string,
): CfcLabelView | undefined => rebaseCfcLabelView(cfcLabelView, [segment]);

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

/**
 * Builds a JS proxy view over a stored cell. Read traps resolve links
 * and wrap nested values; write-side array mutators (`push`, `splice`,
 * `unshift`, etc.) route through the same write-boundary normalization
 * as `Cell.set()` / `Cell.push()`.
 *
 * **Frozenness contract:** Values handed to the write-side array mutators flow
 * through `recursivelyAddIDIfNeeded()` and so plain unfrozen Object/Array
 * inputs get shallowly frozen at each visited level; already-deep- frozen valid
 * `FabricValue` inputs are accepted identity-preservingly.
 */
export function createQueryResultProxy<T>(
  runtime: Runtime,
  tx: IExtendedStorageTransaction | undefined,
  link: NormalizedFullLink,
  depth: number = 0,
  writable: boolean = false,
  cfcLabelView?: CfcLabelView,
): T {
  // Check recursion depth
  if (depth > MAX_RECURSION_DEPTH) {
    throw new Error(
      `Maximum recursion depth of ${MAX_RECURSION_DEPTH} exceeded`,
    );
  }

  // Resolve path and follow links to actual value.
  const readTx = tx === undefined ? runtime.edit() : runtime.readTx(tx);
  const proxyTx = tx ?? readTx;
  const traceStart = readTx.getCfcState().dereferenceTraces.length;
  link = resolveLink(runtime, readTx, link);
  cfcLabelView = mergeCfcLabelViews([
    cloneCfcLabelView(cfcLabelView),
    cfcLabelViewForDereferenceTraces(
      readTx,
      readTx.getCfcState().dereferenceTraces.slice(traceStart),
    ),
  ]);
  const value = readTx.readValueOrThrow(link, SHAPE_READ) as any;

  // The SHAPE_READ above only tracks the container's shape, but the stream
  // check depends on a specific field's VALUE. Register an explicit read of
  // `$stream` when present, so a value flipping into/out of a stream marker
  // re-triggers consumers. [review: ubik2]
  if (isRecord(value) && "$stream" in value) {
    readTx.readValueOrThrow({ ...link, path: [...link.path, "$stream"] });
  }

  // If the value is a stream marker ({ $stream: true }), return a Cell with
  // stream kind so that .send() is available. This handles the case where a
  // pattern's Output type wasn't explicitly specified, causing the capture
  // schema to lose the asCell stream information.
  if (isStreamValue(value)) {
    return createCell(runtime, link, tx, false, "stream", cfcLabelView) as T;
  }

  // `FabricPrimitive`s (byte sequences, temporal values, hashes, ...) are
  // immutable leaves that behave like primitives -- there is no reactive
  // substructure to resolve and they are already frozen. Hand back the value
  // directly, exactly as for JS primitives above; wrapping one in a live proxy
  // serves no purpose and would leak that proxy into any consumer that
  // deep-clones or freezes the surrounding value (e.g. schema interning).
  if (!isRecord(value) || value instanceof FabricPrimitive) {
    // The SHAPE_READ above tracks only the container's shape, but a
    // FabricPrimitive is an atomic VALUE the consumer materializes here (handed
    // back directly, like a JS primitive), not a container whose shape it
    // inspects. Register a recursive value read so an in-place change to the
    // primitive (e.g. a FabricBytes updated to different bytes) re-triggers
    // consumers — a nonRecursive read is compared shape-only and would miss it.
    if (value instanceof FabricPrimitive) {
      readTx.readValueOrThrow(link);
    }
    return value;
  }

  // TODO(danfuzz): This may have to do something special to handle concrete
  // instances of `FabricInstance` so that they get perceived as such by the
  // proxy's clients. Unlike `FabricPrimitive`, `FabricInstance`s are not
  // necessarily frozen and _do_ expose outgoing references (just as plain
  // objects and arrays do).

  // Stored objects are deep-frozen during storage normalization
  // (fabricFromNativeValueModern). A frozen proxy target would force every
  // property access through the invariant guard (ECMAScript 10.5.8: a [[Get]]
  // trap on a non-configurable, non-writable data property must return the
  // target's own value), bypassing the get trap's link resolution entirely.
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
  const txCache = getProxyCache(tx);
  const cacheKey = proxyCacheKey(link, writable, cfcLabelView);

  // Check if we already have a proxy for this target in the cache.
  // The cache key is the original `value` (not the stub), ensuring that
  // the same frozen object always maps to the same proxy instance.
  const existingProxy = txCache.byLink.get(cacheKey) ??
    (cfcLabelView === undefined ? txCache.byValue.get(value) : undefined);
  if (existingProxy) return existingProxy;

  const proxy = new Proxy(proxyTarget as object, {
    get: (target, prop, receiver) => {
      if (Array.isArray(value) && prop === "length") {
        const readTx = runtime.readTx(tx);
        const current = readTx.readValueOrThrow(link) as typeof value;
        return Array.isArray(current) ? current.length : 0;
      }

      // When encountering a frozen property, we just return the value to
      // maintain proxy invariants.
      const descriptor = Object.getOwnPropertyDescriptor(target, prop);
      if (descriptor?.configurable === false) {
        return Reflect.get(target, prop, receiver);
      }

      if (typeof prop === "symbol") {
        if (prop === toCell) {
          return () =>
            createCell(runtime, link, tx, false, undefined, cfcLabelView);
        } else if (prop === Symbol.iterator && Array.isArray(value)) {
          return function () {
            let index = 0;
            return {
              next() {
                const readTx = runtime.readTx(tx);
                const length = readTx.readValueOrThrow({
                  ...link,
                  path: [...link.path, "length"],
                }) as number;
                if (index < length) {
                  const result = {
                    value: createQueryResultProxy(
                      runtime,
                      proxyTx,
                      {
                        ...link,
                        path: [...link.path, String(index)],
                      },
                      depth + 1,
                      writable,
                      childLabelView(cfcLabelView, String(index)),
                    ),
                    done: false,
                  };
                  index++;
                  return result;
                }
                return { done: true };
              },
            };
          };
        }

        const readTx = runtime.readTx(tx);
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
            const readTx = runtime.readTx(tx);
            const length = readTx.readValueOrThrow({
              ...link,
              path: [...link.path, "length"],
            }) as number;

            if (typeof length !== "number") {
              throw new Error(
                `Array length is not a number for ${prop} operation`,
              );
            }

            const current = readTx.readValueOrThrow(link) as typeof value;
            const copy = new Array(length);
            for (let i = 0; i < length; i++) {
              if (!(i in current)) {
                continue;
              }
              copy[i] = createQueryResultProxy(
                runtime,
                proxyTx,
                { ...link, path: [...link.path, String(i)] },
                depth + 1,
                writable,
                childLabelView(cfcLabelView, String(i)),
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
              const readTx = runtime.readTx(tx);
              // For `push`, this base-array read is the op's own incidental read:
              // mark it `mergeableOpRead` so the commit drops it from conflict
              // detection and the tail append merges, matching `Cell.push`. The
              // handler's own explicit `.get()` of the list stays in the conflict
              // set. Other write-only methods (fill, unshift) are not mergeable
              // tail appends and keep their read.
              const currentValue = readTx.readValueOrThrow(
                link,
                prop === "push" ? { meta: mergeableOpRead } : undefined,
              ) as any[];
              copy = [...currentValue];
            } else {
              copy = value.map((_, index) =>
                createProxyForArrayValue(
                  runtime,
                  proxyTx,
                  index,
                  { ...link, path: [...link.path, String(index)] },
                  writable,
                  childLabelView(cfcLabelView, String(index)),
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

            // A tail append records its intent so the commit emits a
            // tail-relative, mergeable operation rather than a position diffed
            // against a possibly-stale base. Other mutators (splice, unshift,
            // ...) are not tail appends and keep the read-modify-write path.
            if (prop === "push") {
              tx.recordMergeableOp?.(link, {
                op: "append",
                count: args.length,
              });
            }

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
                id: toURI(hashOf(cause)),
                space: link.space,
                scope: link.scope,
                path: [],
              };

              diffAndUpdate(runtime, tx, resultLink, result, cause);

              result = createQueryResultProxy(
                runtime,
                proxyTx,
                resultLink,
                0,
                writable,
              );
            }

            return result;
          };
      }

      return createQueryResultProxy(
        runtime,
        proxyTx,
        { ...link, path: [...link.path, prop] },
        depth + 1,
        writable,
        childLabelView(cfcLabelView, String(prop)),
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
      const readTx = runtime.readTx(tx);
      const current = readTx.readValueOrThrow(link, SHAPE_READ);
      if (isRecord(current) || Array.isArray(current)) {
        return Reflect.ownKeys(current);
      }
      return Reflect.ownKeys(value);
    },
    getOwnPropertyDescriptor: (target, prop) => {
      if (Array.isArray(target) && prop === "length") {
        const readTx = runtime.readTx(tx);
        // Read the array fully (not SHAPE_READ) so the length descriptor tracks
        // element add/remove, matching the `length` get trap above. [review: ubik2]
        const current = readTx.readValueOrThrow(link);
        return {
          configurable: false,
          enumerable: false,
          writable: true,
          value: Array.isArray(current) ? current.length : 0,
        };
      }

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
      const readTx = runtime.readTx(tx);
      const current = readTx.readValueOrThrow(link, SHAPE_READ) as typeof value;
      if ((isRecord(current) || Array.isArray(current)) && prop in current) {
        return {
          configurable: true,
          enumerable: true,
          writable: writable,
          value: createQueryResultProxy(
            runtime,
            proxyTx,
            { ...link, path: [...link.path, prop as string] },
            depth + 1,
            writable,
            childLabelView(cfcLabelView, String(prop)),
          ),
        };
      }
      return undefined;
    },
    has: (_target, prop) => {
      if (typeof prop === "symbol") {
        return prop in value;
      }
      const readTx = runtime.readTx(tx);
      const current = readTx.readValueOrThrow(link, SHAPE_READ);
      if (isRecord(current) || Array.isArray(current)) {
        return prop in current;
      }
      return prop in value;
    },
    // A query-result proxy is a live, transaction-backed view: reads resolve
    // through the get trap on every access. Structural mutations (freeze, seal,
    // defineProperty, delete) cannot be honored without either corrupting the
    // backing store (when the proxy fronts the live value) or defeating live
    // resolution (a non-configurable target property forces [[Get]] to return
    // the target's own value, bypassing the trap). So we refuse them outright;
    // callers that need an immutable/structurally-edited form must snapshot the
    // proxy to a plain value first.
    preventExtensions: () => {
      throw new Error(
        "Cannot freeze or seal a live cell-result proxy; snapshot it to a " +
          "plain value first.",
      );
    },
    defineProperty: () => {
      throw new Error(
        "Cannot define properties on a live cell-result proxy; assign through " +
          "a transaction, or snapshot to a plain value first.",
      );
    },
    deleteProperty: () => {
      throw new Error(
        "Cannot delete properties on a live cell-result proxy; mutate through " +
          "a transaction, or snapshot to a plain value first.",
      );
    },
  }) as T;

  // Cache the proxy in the appropriate cache before returning
  txCache.byLink.set(cacheKey, proxy);
  if (cfcLabelView === undefined) {
    txCache.byValue.set(value, proxy);
  }
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
  cfcLabelView?: CfcLabelView,
): { [originalIndex]: number } => {
  const target = {
    valueOf: function () {
      return createQueryResultProxy(
        runtime,
        tx,
        link,
        0,
        writable,
        cfcLabelView,
      );
    },
    toString: function () {
      return String(
        createQueryResultProxy(runtime, tx, link, 0, writable, cfcLabelView),
      );
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
 * Materializes a live query-result view as detached plain arrays/objects.
 * Query proxies deliberately reject freeze/clone traps; validation and hashing
 * boundaries use this snapshot instead of retaining a transaction-backed view.
 */
export function snapshotQueryResult<T>(value: T): T {
  const seen = new WeakMap<object, unknown>();
  const snapshot = (current: unknown): unknown => {
    if (
      current === null || typeof current !== "object" ||
      current instanceof FabricPrimitive
    ) return current;
    const existing = seen.get(current);
    if (existing !== undefined) return existing;
    if (Array.isArray(current)) {
      const array: unknown[] = [];
      seen.set(current, array);
      for (let index = 0; index < current.length; index++) {
        array[index] = snapshot(current[index]);
      }
      return array;
    }
    const object: Record<string, unknown> = {};
    seen.set(current, object);
    for (const key of Object.keys(current)) {
      object[key] = snapshot((current as Record<string, unknown>)[key]);
    }
    return object;
  };
  return snapshot(value) as T;
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
