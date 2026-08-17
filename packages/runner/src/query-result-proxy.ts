import { hashOf } from "@commonfabric/data-model/value-hash";
import { FabricPrimitive } from "@commonfabric/data-model/fabric-value";
import { isObjectOrArray } from "@commonfabric/utils/types";
import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";
import { getTopFrame } from "./builder/pattern.ts";
import { isStreamValue } from "./builder/types.ts";
import { type BackToCellInternals, toCell } from "./back-to-cell.ts";
import { diffAndUpdate } from "./data-updating.ts";
import { resolveLinkTracingDereferences } from "./link-resolution.ts";
import { type NormalizedFullLink } from "./link-utils.ts";
import { type Cell, createCell, frameAnchorIds } from "./cell.ts";
import { type Runtime } from "./runtime.ts";
import {
  type IExtendedStorageTransaction,
  type IReadOptions,
} from "./storage/interface.ts";
import {
  ignoreReadForScheduling,
  mergeableOpRead,
} from "./storage/reactivity-log.ts";
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
// The index a read with no transaction of its own is cached under, one per
// runtime. Two runtimes in a single process — every test that makes its own,
// and any host running more than one — can name the same space and entity, so a
// single process-wide index would hand one runtime's reader a proxy closed over
// the other's runtime, reading through the wrong storage. Held weakly, so an
// index and its cache go when the runtime does.
const defaultTxByRuntime = new WeakMap<
  Runtime,
  IExtendedStorageTransaction
>();

const defaultTxFor = (runtime: Runtime): IExtendedStorageTransaction => {
  let index = defaultTxByRuntime.get(runtime);
  if (index === undefined) {
    index = {} as IExtendedStorageTransaction;
    defaultTxByRuntime.set(runtime, index);
  }
  return index;
};

const getProxyCache = (
  tx: IExtendedStorageTransaction | undefined,
  runtime: Runtime,
): ProxyCache => {
  const cacheIndex = tx ?? defaultTxFor(runtime);
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

/** Whether a transaction can still answer a read. */
const isReadable = (tx: IExtendedStorageTransaction): boolean =>
  tx.status().status === "ready";

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
 * **Frozenness contract:** Values handed to the write-side array mutators are
 * normalized (and frozen) level by level inside the write's diff; the caller's
 * input objects are never mutated, and already-deep-frozen valid `FabricValue`
 * inputs are accepted identity-preservingly.
 */
export function createQueryResultProxy<T>(
  runtime: Runtime,
  tx: IExtendedStorageTransaction | undefined,
  link: NormalizedFullLink,
  depth: number = 0,
  writable: boolean = false,
  cfcLabelView?: CfcLabelView,
): T {
  // The transaction decides which of the two this is. Marked for lazy
  // materialization, the proxy is a view: it keeps this transaction, so the
  // value it describes stays the value that was there when it was taken, and
  // reading after the transaction finishes throws.
  //
  // Unmarked — every caller today — it is a standing handle on a cell that
  // resolves the transaction afresh on every access, so a holder keeps reading
  // current state after the transaction it was made against has finished. Long-
  // lived consumers depend on that: a tool call dispatched by the LLM builtin,
  // a SQLite result flushed after commit, and a piece started on demand all
  // read handles their originating run no longer owns.
  //
  // An unmarked caller who supplies no transaction gets a genuinely fresh one
  // per access rather than whatever `readTx()` would hand back, so the handle
  // cannot be pinned to an ambient transaction that has since gone stale.
  const pinned = tx?.isLazyMaterialize() === true;
  return createViewProxy(
    runtime,
    pinned ? tx : tx === undefined ? runtime.edit() : runtime.readTx(tx),
    tx,
    link,
    depth,
    writable,
    cfcLabelView,
    pinned,
  );
}

/**
 * The shared proxy body.
 *
 * Reads go through `readTx()`: the transaction fixed at creation when
 * `pinned`, and one resolved per access otherwise. Writes and cell minting go
 * through `tx` — the transaction the caller actually supplied, which is
 * `undefined` when they supplied none and is what the write traps test to
 * refuse a mutation. The proxy cache is keyed on `viewTx`, the transaction the
 * proxies in it actually read through, so a cached proxy is never handed to a
 * caller reading through a different one.
 */
function createViewProxy<T>(
  runtime: Runtime,
  viewTx: IExtendedStorageTransaction,
  tx: IExtendedStorageTransaction | undefined,
  link: NormalizedFullLink,
  depth: number,
  writable: boolean,
  cfcLabelView: CfcLabelView | undefined,
  pinned: boolean,
): T {
  // The transaction a trap reads through, and the one a child view is built
  // over. A pinned view keeps the transaction it was created with for both; an
  // unpinned one resolves afresh, so it tracks current state once its original
  // has finished. A child of an unpinned tx-less view inherits that view's own
  // transaction rather than minting one per child.
  const readTx = (): IExtendedStorageTransaction =>
    pinned ? viewTx : runtime.readTx(tx);
  const childViewTx = (): IExtendedStorageTransaction =>
    pinned ? viewTx : runtime.readTx(tx ?? viewTx);
  // Check recursion depth
  if (depth > MAX_RECURSION_DEPTH) {
    throw new Error(
      `Maximum recursion depth of ${MAX_RECURSION_DEPTH} exceeded`,
    );
  }

  // Resolve path and follow links to actual value. The resolution hands back
  // the dereference traces it recorded, so the label view below costs no read
  // of the transaction's CFC state.
  const resolved = resolveLinkTracingDereferences(runtime, viewTx, link);
  link = resolved.link;
  cfcLabelView = mergeCfcLabelViews([
    cloneCfcLabelView(cfcLabelView),
    cfcLabelViewForDereferenceTraces(viewTx, resolved.traces),
  ]);
  const value = viewTx.readValueOrThrow(link, SHAPE_READ) as any;

  // The SHAPE_READ above only tracks the container's shape, but the stream
  // check depends on a specific field's VALUE. Register an explicit read of
  // `$stream` when present, so a value flipping into/out of a stream marker
  // re-triggers consumers. [review: ubik2]
  if (isObjectOrArray(value) && "$stream" in value) {
    viewTx.readValueOrThrow({ ...link, path: [...link.path, "$stream"] });
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
  if (!isObjectOrArray(value) || value instanceof FabricPrimitive) {
    // The SHAPE_READ above tracks only the container's shape, but a
    // FabricPrimitive is an atomic VALUE the consumer materializes here (handed
    // back directly, like a JS primitive), not a container whose shape it
    // inspects. Register a recursive value read so an in-place change to the
    // primitive (e.g. a FabricBytes updated to different bytes) re-triggers
    // consumers — a nonRecursive read is compared shape-only and would miss it.
    if (value instanceof FabricPrimitive) {
      viewTx.readValueOrThrow(link);
    }
    return value;
  }

  // A `FabricInstance` is _not_ exempted here the way a `FabricPrimitive` is
  // above, so one gets wrapped in a proxy -- and that has a consequence outside
  // this file which is easy to miss from here.
  //
  // The proxy target is an empty stub and there is no `getPrototypeOf` trap, so
  // a proxied instance's prototype is `Object.prototype` and
  // `instanceof FabricInstance` is _false_ for it. Every
  // `instanceof FabricInstance` guard in the runner is therefore blind to an
  // instance that arrives through a cell read -- the refusal does not fire and
  // the walk proceeds to rebuild the value as a bare `{}`. That is around ten
  // sites and counting, so they are not listed here to go stale;
  // `grep -rn 'instanceof FabricInstance' packages/runner/src` finds them.
  //
  // `test/llm-dialog-special-objects.test.ts` pins that end to end, so closing
  // this turns that test red rather than letting it pass silently.
  //
  // TODO(danfuzz): make a proxied `FabricInstance` perceived as one by the
  // proxy's clients. Note this is not simply extending the raw-return exemption
  // above: unlike a primitive, an instance is not necessarily frozen and _does_
  // expose outgoing references (just as plain objects and arrays do), so the
  // proxy is here on purpose and something has to preserve type identity
  // without losing member resolution.

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

  // Index by the CALLER's transaction, not by the one reads resolve through.
  // A standing handle is created without a transaction and resolves a fresh one
  // per access, so indexing by the resolved transaction gives every read its own
  // cache and hands back a different object each time — and a consumer that
  // holds one and later meets it again (FUSE matching a callable against its own
  // entry, a value whose element points back at the array containing it) sees
  // two things where there is one. Tx-less reads share the default index, which
  // is what makes them the same object.
  //
  // A pinned view has the marked transaction as its caller tx, so it still gets
  // one cache per transaction — which is right, because it describes the instant
  // that transaction saw.
  const txCache = getProxyCache(tx, runtime);
  const cacheKey = proxyCacheKey(link, writable, cfcLabelView);

  // Check if we already have a proxy for this target in the cache.
  // The cache key is the original `value` (not the stub), ensuring that
  // the same frozen object always maps to the same proxy instance.
  const existingProxy = txCache.byLink.get(cacheKey) ??
    (cfcLabelView === undefined ? txCache.byValue.get(value) : undefined);
  if (existingProxy) return existingProxy;

  const proxy = new Proxy(proxyTarget as object, {
    get: (target, prop, receiver) => {
      // Promise adoption probes `then` on every value it receives, so a view
      // that refuses the probe cannot cross a promise boundary at all — and a
      // lift's result crosses one by construction. A finished view returns
      // `undefined` for it, which is what a live one returns for a value
      // with no `then`; every other property still refuses.
      if (prop === "then" && pinned && !isReadable(viewTx)) return undefined;
      if (Array.isArray(value) && prop === "length") {
        const current = readTx().readValueOrThrow(link) as typeof value;
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
                const length = readTx().readValueOrThrow({
                  ...link,
                  path: [...link.path, "length"],
                }) as number;
                if (index < length) {
                  const result = {
                    value: createViewProxy(
                      runtime,
                      childViewTx(),
                      tx,
                      {
                        ...link,
                        path: [...link.path, String(index)],
                      },
                      depth + 1,
                      writable,
                      childLabelView(cfcLabelView, String(index)),
                      pinned,
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
        const current = readTx().readValueOrThrow(link) as typeof value;

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
            const length = readTx().readValueOrThrow({
              ...link,
              path: [...link.path, "length"],
            }) as number;

            if (typeof length !== "number") {
              throw new Error(
                `Array length is not a number for ${prop} operation`,
              );
            }

            const current = readTx().readValueOrThrow(link) as typeof value;
            const copy = new Array(length);
            for (let i = 0; i < length; i++) {
              if (!(i in current)) {
                continue;
              }
              copy[i] = createViewProxy(
                runtime,
                childViewTx(),
                tx,
                { ...link, path: [...link.path, String(i)] },
                depth + 1,
                writable,
                childLabelView(cfcLabelView, String(i)),
                pinned,
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
            // The base array a mutator operates on. Read fresh from the
            // transaction, not the proxy-creation-time `value`, which is stale
            // after an earlier write in this transaction (CT-1173). Without this a
            // `push("b")` then `sort()` sorts the stale pre-push array and drops
            // "b" from the local result. WriteOnly and ReadWrite both read fresh;
            // ReadWrite also unwraps against this array below.
            // For `push`, this base-array read is the op's own incidental read:
            // mark it `mergeableOpRead` so the commit drops it from conflict
            // detection and the tail append merges, matching `Cell.push`. The
            // handler's own explicit `.get()` of the list stays in the conflict
            // set. Other mutators (fill, unshift, sort, splice, ...) are not
            // mergeable tail appends and keep their read.
            const currentValue = readTx().readValueOrThrow(
              link,
              prop === "push" ? { meta: mergeableOpRead } : undefined,
            ) as any[];
            const base = Array.isArray(currentValue) ? currentValue : [];
            if (isReadWrite === ArrayMethodType.WriteOnly) {
              copy = [...base];
            } else {
              copy = base.map((_, index) =>
                createProxyForArrayValue(
                  runtime,
                  childViewTx(),
                  tx,
                  index,
                  { ...link, path: [...link.path, String(index)] },
                  writable,
                  childLabelView(cfcLabelView, String(index)),
                  pinned,
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
                isProxyForArrayValue(item) ? base[item[originalIndex]] : item
              );
            }

            // The anchor id source turns any newly added objects into entity
            // documents of their own rather than inline data, which is
            // critical for persistence.
            const frame = getTopFrame();

            // And if there was a change at all, update the cell.
            diffAndUpdate(
              runtime,
              tx,
              link,
              copy,
              {
                parent: { id: link.id, space: link.space },
                method: prop,
                call: new Error().stack,
                context: frame?.cause ?? "unknown",
              },
              undefined,
              frameAnchorIds(frame),
            );

            // A tail append records its intent so the commit emits a
            // tail-relative, mergeable operation rather than a position diffed
            // against a possibly-stale base. Any other in-place mutator (splice,
            // unshift, sort, reverse, fill, ...) reshapes the array: for any
            // mergeable op recorded earlier in the transaction on this array —
            // or on an array nested inside it, which this reshape rewrites just
            // as surely — the recorded tail no longer identifies the appended
            // elements, so abandon those intents and let the whole-array diff
            // carry the reshaped result.
            if (prop === "push") {
              tx.recordMergeableOp?.(link, {
                op: "append",
                count: args.length,
              });
            } else {
              tx.poisonMergeableOp?.(link);
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

              result = createViewProxy(
                runtime,
                childViewTx(),
                tx,
                resultLink,
                0,
                writable,
                undefined,
                pinned,
              );
            }

            return result;
          };
      }

      // Prototype properties are JavaScript behavior, not persisted child
      // values. Reflect them from the current container instead of issuing a
      // storage read for an inherited path such as `constructor` or
      // `toString`. Storage traversal deliberately considers own properties
      // only; keeping the same boundary here also avoids recording spurious
      // reactive dependencies for prototype members.
      //
      // The receiver is the container, not this proxy: a prototype accessor
      // has to run against the object that actually holds the state. Every
      // `FabricInstance` keeps its state in private fields behind accessors,
      // and a private field is unreachable from a proxy that does not declare
      // it. (The receiver is immaterial for a data property, which is what
      // every prototype member of a plain object or array is, so this costs
      // those nothing.) A `FabricInstance` leafs through storage traversal
      // whole, so the read of the container already covers what an accessor
      // returns.
      if (!Object.hasOwn(value, prop) && prop in value) {
        return Reflect.get(value, prop);
      }

      return createViewProxy(
        runtime,
        childViewTx(),
        tx,
        { ...link, path: [...link.path, prop] },
        depth + 1,
        writable,
        childLabelView(cfcLabelView, String(prop)),
        pinned,
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

      const writeLink = { ...link, path: [...link.path, String(prop)] };
      diffAndUpdate(
        runtime,
        tx,
        writeLink,
        value,
      );

      // Assigning over a property is a whole-value write, the same reshape
      // `Cell.set` performs — and it reaches this trap instead of that method.
      // Any mergeable op recorded at or beneath the assigned property refers to
      // a value this write just replaced, so abandon it and let the whole-value
      // diff carry the result.
      tx.poisonMergeableOp?.(writeLink);

      return true;
    },
    ownKeys: () => {
      const current = readTx().readValueOrThrow(link, SHAPE_READ);
      const keys = isObjectOrArray(current) || Array.isArray(current)
        ? Reflect.ownKeys(current)
        : Reflect.ownKeys(value);
      if (Array.isArray(proxyTarget)) {
        if (!keys.includes("length")) {
          // Insert `length` where a real array carries it -- after the index
          // keys, ahead of any other name -- rather than appending it. Own-key
          // order is load-bearing: a consumer can tell an index-only array from
          // one carrying named properties by asking whether `length` comes
          // last, and appending would make a named property look like an
          // index-only one. `isInertArray()` reads exactly that, and fabric
          // membership (`isFabricValue()`) is decided by it for every array,
          // so the order here is what makes a proxied array carrying a named
          // property fail membership instead of passing as index-only.
          const firstNonIndex = keys.findIndex((key) =>
            !((typeof key === "string") && isArrayIndexPropertyName(key))
          );
          keys.splice(
            (firstNonIndex === -1) ? keys.length : firstNonIndex,
            0,
            "length",
          );
        }
        // Enumerating an array's keys (`Object.keys`/`values`/`entries`, a spread,
        // `for...in`) observes which index keys are present. For a dense array
        // that is its `length`, but an array here can be sparse (holes below
        // `length`), and filling or punching a hole changes the present-key set
        // without changing `length` — a write at `/arr/<i>` with no `/arr/length`
        // write. The SHAPE_READ above is dropped at commit as the op's incidental
        // container read, and neither a `length` read nor a nonRecursive shape
        // read at the array path conflicts with a same-length element-slot write.
        // Record a recursive (by-value) read of the array — the one read the
        // mergeable narrowing keeps that a hole edit invalidates — so an
        // enumeration-derived mergeable write conflicts and retries instead of
        // merging on a stale key set. It is marked `ignoreReadForScheduling` so it
        // adds only the conflict dependency; reactivity stays on the SHAPE_READ.
        readTx().readValueOrThrow(link, { meta: ignoreReadForScheduling });
      }
      return keys;
    },
    getOwnPropertyDescriptor: (target, prop) => {
      if (Array.isArray(target) && prop === "length") {
        // Read the array fully (not SHAPE_READ) so the length descriptor tracks
        // element add/remove, matching the `length` get trap above. [review: ubik2]
        const current = readTx().readValueOrThrow(link);
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
      const current = readTx().readValueOrThrow(
        link,
        SHAPE_READ,
      ) as typeof value;
      // `Object.hasOwn`, not `in`: this trap reports on OWN properties, and
      // `in` walks the prototype chain. Because the underlying value is an
      // ordinary `Object.prototype`-rooted record, `in` reported every member of
      // `Object.prototype` -- `toString`, `valueOf`, `constructor`, `__proto__`
      // -- as an own property of the proxy, while `ownKeys` (which uses
      // `Reflect.ownKeys`) listed none of them. Two traps describing the same
      // value disagreed by construction, so every consumer that reasons about a
      // read-back value's shape was being told it carries names it does not.
      //
      // That is not academic: `unsafeObjectKeyIn()` refuses a `FabricValue`
      // carrying own `__proto__`/`constructor` and tests with `Object.hasOwn()`,
      // so writing a read-back record back to a cell was rejected for a key the
      // record never had, and every read-modify-write against a cell failed
      // (loom CT-1949). The `has` trap below keeps `in` -- there it is correct,
      // being the `in` operator's own trap.
      if (
        (isObjectOrArray(current) || Array.isArray(current)) &&
        Object.hasOwn(current, prop)
      ) {
        return {
          configurable: true,
          enumerable: true,
          writable: writable,
          value: createViewProxy(
            runtime,
            childViewTx(),
            tx,
            { ...link, path: [...link.path, prop as string] },
            depth + 1,
            writable,
            childLabelView(cfcLabelView, String(prop)),
            pinned,
          ),
        };
      }
      return undefined;
    },
    has: (_target, prop) => {
      if (typeof prop === "symbol") {
        return prop in value;
      }
      const current = readTx().readValueOrThrow(link, SHAPE_READ);
      if (isObjectOrArray(current) || Array.isArray(current)) {
        // Probing whether a numeric index is present (`n in arr`) observes the
        // array's key set: for a dense array the answer is `n < length`, but a
        // sparse array has holes, so the answer depends on whether index `n` is
        // specifically present — which a same-length hole fill or punch changes
        // with no `length` write. Record a recursive read of the array (marked
        // conflict-only, like ownKeys above) so an `n in arr`-derived mergeable
        // write conflicts and retries instead of merging on a stale key set.
        if (Array.isArray(current) && /^\d+$/.test(prop)) {
          readTx().readValueOrThrow(link, { meta: ignoreReadForScheduling });
        }
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
  viewTx: IExtendedStorageTransaction,
  tx: IExtendedStorageTransaction | undefined,
  source: number,
  link: NormalizedFullLink,
  writable: boolean = false,
  cfcLabelView?: CfcLabelView,
  pinned: boolean = false,
): { [originalIndex]: number } => {
  const target = {
    valueOf: function () {
      return createViewProxy(
        runtime,
        viewTx,
        tx,
        link,
        0,
        writable,
        cfcLabelView,
        pinned,
      );
    },
    toString: function () {
      return String(
        createViewProxy(
          runtime,
          viewTx,
          tx,
          link,
          0,
          writable,
          cfcLabelView,
          pinned,
        ),
      );
    },
    [originalIndex]: source,
  };

  return target;
};

function isProxyForArrayValue(value: any): value is ProxyForArrayValue {
  return isObjectOrArray(value) && originalIndex in value;
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
  return isObjectOrArray(value) &&
    typeof (value as Partial<BackToCellInternals>)[toCell] === "function";
}

/**
 * Materializes a live query-result view as detached plain arrays/objects.
 * Query proxies deliberately reject freeze/clone traps; validation and hashing
 * boundaries use this snapshot instead of retaining a transaction-backed view.
 */
export function snapshotQueryResult<T>(value: T): T {
  const seen = new WeakMap<object, unknown>();
  const snapshot = (current: unknown): unknown => {
    // TODO(danfuzz): the leaf test covers `FabricPrimitive` but not
    // `FabricInstance`, so an instance (live traffic — the fetch builtins
    // store a `FabricError` result) falls to the `Object.keys` rebuild below
    // and snapshots as `{}`, its codec contents lost. It wants the same
    // leaf-through treatment until a codec-contents walk exists.
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
