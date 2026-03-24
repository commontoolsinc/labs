import { hashOf } from "@commontools/data-model/value-hash";
import {
  hashSchema,
  hashSchemaItem,
} from "@commontools/data-model/schema-hash";
import { MIME } from "@commontools/memory/interface";
import type { JSONSchemaObj } from "@commontools/api";
import type {
  MemorySpace,
  Result,
  SchemaPathSelector,
  Unit,
} from "@commontools/memory/interface";
import {
  type FabricDatum,
  type FabricValue,
  isArrayIndexPropertyName,
} from "@commontools/data-model/fabric-value";
import { deepEqual } from "@commontools/utils/deep-equal";
// TODO(@ubik2): Ideally this would import from "@commontools/utils/types",
// but rollup has issues
import {
  type Immutable,
  isBoolean,
  isFiniteNumber,
  isObject,
  isRecord,
  isString,
} from "../../utils/src/types.ts";
import { getLogger } from "../../utils/src/logger.ts";
import { ContextualFlowControl } from "./cfc.ts";
import { toDeepFrozenSchema } from "@commontools/data-model/schema-utils";
import type { JSONObject, JSONSchema } from "./builder/types.ts";
import {
  addressKey,
  createDataCellURI,
  isPrimitiveCellLink,
  NormalizedFullLink,
  parseLink,
} from "./link-utils.ts";
import type {
  Activity,
  CommitError,
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  InactiveTransactionError,
  IReadOptions,
  IStorageTransaction,
  ITransactionJournal,
  ITransactionReader,
  ITransactionWriter,
  ReaderError,
  ReadError,
  StorageTransactionStatus,
  WriteError,
  WriterError,
} from "./storage/interface.ts";
import { resolve } from "./storage/transaction/attestation.ts";
import { isWriteRedirectLink } from "./link-types.ts";
import { LastNode } from "./link-resolution.ts";
import type { IAttestation, IMemoryAddress } from "./storage/interface.ts";

const logger = getLogger("traverse", { enabled: true, level: "warn" });

const READ_NON_RECURSIVE: IReadOptions = {
  nonRecursive: true,
};
const READ_FOR_SCHEDULING: IReadOptions = {
  trackReadWithoutLoad: true,
};
const READ_NON_RECURSIVE_FOR_SCHEDULING: IReadOptions = {
  nonRecursive: true,
  trackReadWithoutLoad: true,
};

export type { IAttestation, IMemoryAddress } from "./storage/interface.ts";
export type { SchemaPathSelector };

// An IAttestation where the address is an IMemorySpaceAddress
interface IMemorySpaceAttestation {
  readonly address: IMemorySpaceAddress;
  readonly value?: FabricDatum;
}

// Only false is falsy
const enum TypeValidity {
  False = 0,
  True = 1,
  Unknown = 2,
}

type ValuePath = readonly ["value", ...string[]];
export type IMemorySpaceValueAddress = IMemorySpaceAddress & {
  path: ValuePath;
};
export type IMemorySpaceValueAttestation = IMemorySpaceAttestation & {
  address: IMemorySpaceValueAddress;
};

// Schema operation intern caches: memoize merge/combine results so
// structurally-identical operations return the same object identity.
// This ensures downstream hashSchema hits the WeakMap cache
// (O(1) identity lookup) instead of re-walking the schema tree.
// Capped to prevent unbounded growth in long-running servers.
const INTERN_CACHE_MAX = 10_000;
const _mergeSchemaOptionCache = new Map<string, JSONSchema>();
const _combineSchemaCache = new Map<string, JSONSchema>();
const _mergeSchemaFlagsCache = new Map<string, JSONSchema>();
const _mergeAnyOfBranchCache = new Map<string, JSONSchema | null>();

function internSet(
  cache: Map<string, JSONSchema>,
  key: string,
  value: JSONSchema,
) {
  if (cache.size >= INTERN_CACHE_MAX) cache.clear();
  cache.set(key, toDeepFrozenSchema(value, true));
}

/**
 * A data structure that maps keys to sets of values, allowing multiple values
 * to be associated with a single key without duplication.
 *
 * When a `hashFunction` is provided, values are deduped using hash-based
 * lookup for O(1) add/hasValue. Structurally-equal values (per the hash
 * function) are treated as duplicates.
 *
 * When no `hashFunction` is provided, values are stored in a plain Set using
 * reference equality.
 *
 * @template K The type of keys in the map
 * @template V The type of values stored in the sets
 */
export class MapSet<K, V> {
  // When hashFunction is set, use hash-based dedup: key → (hash → value)
  // When unset, use plain Set: key → Set<value>
  private hashMap?: Map<K, Map<string, V>>;
  private setMap?: Map<K, Set<V>>;
  private hashFunction?: (value: V) => string;

  // Instrumentation counters (kept for diagnostics)
  deepEqualCalls = 0;
  deepEqualMs = 0;

  constructor(hashFunction?: (value: V) => string) {
    if (hashFunction) {
      this.hashFunction = hashFunction;
      this.hashMap = new Map();
    } else {
      this.setMap = new Map();
    }
  }

  /** Total number of keys in the map */
  public get size(): number {
    if (this.hashMap) return this.hashMap.size;
    return this.setMap!.size;
  }

  /** Total number of values across all keys */
  public get totalValues(): number {
    let count = 0;
    if (this.hashMap) {
      for (const m of this.hashMap.values()) count += m.size;
    } else {
      for (const s of this.setMap!.values()) count += s.size;
    }
    return count;
  }

  public get(key: K): Set<V> | undefined {
    if (this.hashMap) {
      const m = this.hashMap.get(key);
      return m ? new Set(m.values()) : undefined;
    }
    return this.setMap!.get(key);
  }

  public add(key: K, value: V) {
    if (this.hashMap) {
      let m = this.hashMap.get(key);
      if (m === undefined) {
        m = new Map<string, V>();
        this.hashMap.set(key, m);
      }
      const hash = this.hashFunction!(value);
      if (!m.has(hash)) {
        m.set(hash, value);
      }
      return;
    }
    // Non-hash path (no equalFn)
    const values = this.setMap!.get(key);
    if (values === undefined) {
      this.setMap!.set(key, new Set([value]));
    } else {
      values.add(value);
    }
  }

  public has(key: K): boolean {
    if (this.hashMap) return this.hashMap.has(key);
    return this.setMap!.has(key);
  }

  public hasValue(key: K, value: V): boolean {
    if (this.hashMap) {
      const m = this.hashMap.get(key);
      if (!m) return false;
      return m.has(this.hashFunction!(value));
    }
    const values = this.setMap!.get(key);
    return values !== undefined && values.has(value);
  }

  public deleteValue(key: K, value: V): boolean {
    if (this.hashMap) {
      const m = this.hashMap.get(key);
      if (!m) return false;
      const hash = this.hashFunction!(value);
      const rv = m.delete(hash);
      if (m.size === 0) this.hashMap.delete(key);
      return rv;
    }
    const values = this.setMap!.get(key);
    if (!values) return false;
    const rv = values.delete(value);
    if (values.size === 0) this.setMap!.delete(key);
    return rv;
  }

  public delete(key: K) {
    if (this.hashMap) {
      this.hashMap.delete(key);
    } else {
      this.setMap!.delete(key);
    }
  }

  /**
   * iterable
   */
  *[Symbol.iterator](): IterableIterator<[K, Set<V>]> {
    if (this.hashMap) {
      for (const [key, m] of this.hashMap) {
        yield [key, new Set(m.values())];
      }
    } else {
      for (const [key, values] of this.setMap!) {
        yield [key, values];
      }
    }
  }
}

/**
 * Convenience subclass of `MapSet` specialized for `string` keys and
 * `SchemaPathSelector` values — the common case throughout traverse/query
 * code. When `hashValues` is `true`, uses `hashSchemaItem` from the
 * schema-hash dispatch layer as the hash function.
 */
export class MapSetStringToPathSelectors extends MapSet<
  string,
  SchemaPathSelector
> {
  constructor(hashValues: boolean = false) {
    super(hashValues ? hashSchemaItem : undefined);
  }
}

/**
 * Convenience subclass of `MapSet` specialized for `string` keys and
 * `string` values. Uses reference equality (plain Set) for dedup.
 */
export class MapSetStringToStrings extends MapSet<string, string> {
  constructor() {
    super();
  }
}

// SchemaPathSelectors are relative to the doc root, so if we want to look at
// the value of the doc, we need to have "value" in the path.
const DefaultSelector: SchemaPathSelector = { path: ["value"], schema: true };

export class CycleTracker<K> {
  private partial: Set<K>;
  private expectCycles: boolean;
  constructor(expectCycles = false) {
    this.expectCycles = expectCycles;
    this.partial = new Set<K>();
  }
  include(k: K, context?: unknown): Disposable | null {
    if (this.partial.has(k)) {
      if (!this.expectCycles) {
        logger.warn("traverse", () => [
          "Cycle Detected!",
          k,
          context,
        ]);
      }
      return null;
    }
    this.partial.add(k);
    return {
      [Symbol.dispose]: () => {
        this.partial.delete(k);
      },
    };
  }
}

/**
 * Cycle tracker for more complex objects with multiple parts.
 *
 * This will not work correctly if the key is modified after being added.
 */
export class CompoundCycleTracker<
  EqualKey,
  ExtraKey extends FabricValue,
  Value = unknown,
> {
  // partialKey (identity) → Map<hash(extraKey), Value?>
  private partial: Map<EqualKey, Map<string, Value | undefined>>;
  constructor() {
    this.partial = new Map();
  }

  /**
   * Identity check on `partialKey`, hash-based check on `extraKey`.
   * Uses `hashSchemaItem` (with WeakMap identity cache in legacy mode)
   * so schema objects hash in O(1) amortized after the first call.
   */
  include(
    partialKey: EqualKey,
    extraKey: ExtraKey,
    value?: Value,
    _context?: unknown,
  ): Disposable | null {
    let existing = this.partial.get(partialKey);
    if (existing === undefined) {
      existing = new Map();
      this.partial.set(partialKey, existing);
    }
    const hash = hashSchemaItem(extraKey);
    if (existing.has(hash)) {
      return null;
    }
    existing.set(hash, value);
    return {
      [Symbol.dispose]: () => {
        const entries = this.partial.get(partialKey);
        if (entries) {
          entries.delete(hash);
          if (entries.size === 0) {
            this.partial.delete(partialKey);
          }
        }
      },
    };
  }

  // After a failed include (that returns null), we can use getExisting to find the registered value
  getExisting(partialKey: EqualKey, extraKey: ExtraKey): Value | undefined {
    const existing = this.partial.get(partialKey);
    if (existing === undefined) {
      return undefined;
    }
    const hash = hashSchemaItem(extraKey);
    return existing.get(hash);
  }
}

export type PointerCycleTracker = CompoundCycleTracker<
  Immutable<FabricDatum>,
  JSONSchema | undefined,
  any
>;

class ManagedStorageJournal implements ITransactionJournal {
  activity(): Iterable<Activity> {
    return [];
  }
  novelty(_space: MemorySpace): Iterable<IAttestation> {
    return [];
  }
  history(_space: MemorySpace): Iterable<IAttestation> {
    return [];
  }
}

/**
 * Implementation of IStorageTransaction that is backed by an ObjectManager
 * This is a read-only transaction, and is only used by the query traversal.
 */
export class ManagedStorageTransaction implements IStorageTransaction {
  constructor(
    private manager: ObjectStorageManager,
    public journal = new ManagedStorageJournal(),
  ) {
  }

  status(): StorageTransactionStatus {
    return { status: "ready", journal: this.journal };
  }

  read(
    address: IMemorySpaceAddress,
    options?: IReadOptions,
  ): Result<IAttestation, ReadError> {
    if (options?.trackReadWithoutLoad === true) {
      return { ok: { address, value: undefined } };
    }
    const source = this.manager.load(address) ??
      { address: { ...address, path: [] } };
    return resolve(source, address);
  }
  writer(_space: MemorySpace): Result<ITransactionWriter, WriterError> {
    throw new Error("Method not implemented.");
  }
  write(
    _address: IMemorySpaceAddress,
    _value?: FabricDatum,
  ): Result<IAttestation, WriterError | WriteError> {
    throw new Error("Method not implemented.");
  }
  reader(_space: MemorySpace): Result<ITransactionReader, ReaderError> {
    throw new Error("Method not implemented.");
  }
  abort(_reason?: unknown): Result<Unit, InactiveTransactionError> {
    throw new Error("Method not implemented.");
  }
  commit(): Promise<Result<Unit, CommitError>> {
    throw new Error("Method not implemented.");
  }
}

export type BaseMemoryAddress = Omit<IMemoryAddress, "path">;

// I've really got two different concepts here.
// A. How we traverse the object
//  1. For a schema query, we traverse the object, but avoid visiting branches that don't match our schema
//  2. For a normal traversal, we traverse the object, visiting all child nodes.
// B. How we interact with the objects
//  1. Loading objects from the DB (on the server)
//  2. Loading objects from our memory interface (on the client)

export interface ObjectStorageManager {
  // load the object for the specified key
  load(address: BaseMemoryAddress): IAttestation | null;
}

// Create objects based on the data and schema (in the link)
// I think this callback system is a bit of a kludge, but it lets me
// use the core traversal together with different object types for the runner.
export interface IObjectCreator<T> {
  // When we have multiple matches, we may need to do something special to
  // combine them (for example, merging properties)
  mergeMatches(
    matches: T[],
    schema?: JSONSchema,
  ): T | undefined;
  // In the SchemaObjectTraverser system, we'll copy the object's value into
  // the new version
  // In the validateAndTransform system, we'll skip these properties
  addOptionalProperty(
    obj: Record<string, unknown>,
    key: string,
    value: T,
  ): void;

  // In the SchemaObjectTraverser system, we don't need to apply defaults
  // In the validateAndTransform system, we apply defaults from the schema
  // This should also handle annotation of the default value if needed.
  applyDefault(
    link: NormalizedFullLink,
    defaultValue: T | undefined,
  ): T | undefined;

  // In the SchemaObjectTraverser system, we don't need to annotate the object
  // or even create a returned value.
  // In the validateAndTransform system, we may add the toCell and toOpaqueRef
  // functions or actualy create the cell.
  createObject(
    link: NormalizedFullLink,
    value: (T | undefined)[] | Record<string, (T | undefined)> | T | undefined,
  ): T;
}

/**
 * This is the ObjectCreator used by the SchemaObjectTraverser for processing
 * queries. We don't need to do anything special here.
 */
class StandardObjectCreator implements IObjectCreator<FabricDatum> {
  mergeMatches(
    matches: FabricDatum[],
    _schema?: JSONSchema,
  ): FabricDatum | undefined {
    // These value objects should be merged. While this isn't JSONSchema
    // spec, when we have an anyOf with branches where name is set in one
    // schema, but the address is ignored, and a second option where
    // address is set, and name is ignored, we want to include both.
    return mergeAnyOfMatches(matches);
  }

  addOptionalProperty(
    obj: Record<string, unknown>,
    key: string,
    value: FabricDatum,
  ) {
    // It's fine to include this non-matching data, since we're not returning
    // the final object to a user. This lets us see the contents better if we
    // need to debug things.
    obj[key] = value;
  }
  applyDefault(
    _link: NormalizedFullLink,
    defaultValue: FabricDatum | undefined,
  ): FabricDatum | undefined {
    return defaultValue;
  }
  /**
   * When processing queries, we want JSON, so we replace undefined with null.
   *
   * @param _link
   * @param value
   * @returns
   */
  createObject(
    _link: NormalizedFullLink,
    value: FabricDatum | undefined,
  ): FabricDatum {
    return value;
  }
}

/**
 * When we match on multiple clauses of an anyOf, we want to merge the results
 * If they aren't objects, we can't really do this, but if they are, we can
 * combine the properties from the various matches.
 *
 * This isn't perfectly aligned with JSONSchema spec, but it's generally useful.
 *
 * @param matches the list of matched values
 * @returns an object created by combining properties from the matches, or the first
 *  match if they aren't all objects, or undefined if there are no matches.
 */
export function mergeAnyOfMatches<T>(
  matches: T[],
): T | Record<string, T> | undefined {
  // These value objects should be merged. While this isn't JSONSchema
  // spec, when we have an anyOf with branches where name is set in one
  // schema, but the address is ignored, and a second option where
  // address is set, and name is ignored, we want to include both.
  if (matches.length > 1) {
    // If all our matches are objects, merge the properties.
    if (matches.every((v) => isRecord(v))) {
      const unified: Record<string, T> = {};
      for (const match of matches) {
        Object.assign(unified, match);
      }
      return unified;
    }
  }
  // If we have any match, return that.
  if (matches.length > 0) {
    return matches[0];
  }
}

/**
 * Convert an IMemoryAddress to a NormalizedFullLink.
 *
 * The address must start with "value", or we won't be able to generate this link.
 */
function getNormalizedLink(
  address: IMemorySpaceValueAddress,
  schema?: JSONSchema,
): NormalizedFullLink {
  if (address.path.length === 0 || address.path[0] !== "value") {
    throw new Error("Unable to create link to non-value address");
  }
  const { space, id, path, type } = address;
  return {
    space,
    id,
    type,
    path: path.slice(1),
    ...(schema !== undefined && { schema }),
  };
}

// Value traversed must be a DAG, though it may have aliases or cell links
// that make it seem like it has cycles
export abstract class BaseObjectTraverser {
  constructor(
    protected tx: IExtendedStorageTransaction,
    protected selector: SchemaPathSelector = DefaultSelector,
    protected tracker: PointerCycleTracker = new CompoundCycleTracker<
      Immutable<FabricDatum>,
      JSONSchema | undefined
    >(),
    protected schemaTracker: MapSetStringToPathSelectors =
      new MapSetStringToPathSelectors(true),
    protected cfc: ContextualFlowControl = new ContextualFlowControl(),
    public objectCreator: IObjectCreator<FabricDatum> =
      new StandardObjectCreator(),
    protected traverseCells = true,
  ) {}
  protected dagMemo = new Map<string, Immutable<FabricValue>>();
  traverseDAGCalls = 0;
  getDocAtPathCalls = 0;
  abstract traverse(
    doc: IMemorySpaceValueAttestation,
  ): TraverseResult<Immutable<FabricValue>>;
  /**
   * Attempt to traverse the document as a directed acyclic graph.
   * This is the simplest form of traversal, where we include everything.
   * If the doc's value is undefined, this will return undefined (or
   * defaultValue if provided).
   * Otherwise, it will return the fully traversed object.
   * If a cycle is detected, it will not traverse the cyclic element
   *
   * Our reactivity mark strategy is to mark the doc read before calling this,
   * and any time we follow a link, also mark that returned doc read.
   *
   * @param doc a doc whose value has been read recursively
   * @param defaultValue optional default value
   * @param itemLink optinal item link to use when creating links
   * @returns
   */
  protected traverseDAG(
    doc: IMemorySpaceValueAttestation,
    defaultValue?: FabricDatum,
    itemLink?: NormalizedFullLink,
  ): Immutable<FabricValue> {
    this.traverseDAGCalls++;
    // Memoize by cell address + itemLink to avoid exponential path explosion
    // in DAGs. When multiple parents share children, every unique path triggers
    // a full re-traversal. Caching collapses this to one visit per cell.
    // itemLink must be part of the key because the same data reached through
    // different links produces different query result proxies / cell identities.
    // Skip when defaultValue is provided since it can alter the result.
    if (defaultValue === undefined) {
      const memoKey = itemLink
        ? addressKey(doc.address) + "|" + addressKey(itemLink)
        : addressKey(doc.address);
      const cached = this.dagMemo.get(memoKey);
      if (cached !== undefined) {
        return cached;
      }
    }
    if (doc.value === undefined) {
      // If we have a default, annotate it and return it
      // Otherwise, return undefined
      // doc.path can be [] here, so we can't just normalize the link, which
      // would trim "value". This does impact the back to cell symbols.
      return this.objectCreator.applyDefault(
        doc.address,
        defaultValue,
      );
    } else if (isPrimitive(doc.value)) {
      return doc.value;
    } else if (Array.isArray(doc.value)) {
      const newValue = new Array<Immutable<FabricValue>>(doc.value.length);
      using t = this.tracker.include(doc.value, true, newValue, doc);
      if (t === null) {
        return this.tracker.getExisting(doc.value, true);
      }
      doc.value.forEach((item, index) => {
        const itemDefault =
          isRecord(defaultValue) && Array.isArray(defaultValue) &&
            index < defaultValue.length
            ? defaultValue[index]
            : undefined;
        let docItem: IMemorySpaceValueAttestation = {
          address: {
            ...doc.address,
            path: appendToPath(doc.address.path, index.toString()),
          },
          value: item,
        };
        // We follow the first link in array elements so we don't have
        // strangeness with setting item at 0 to item at 1
        let arrayElementLink = itemLink;
        if (isPrimitiveCellLink(item)) {
          const [redirDoc, redirSelector] = this.getDocAtPath(
            docItem,
            [],
            DefaultSelector,
            "writeRedirect",
          );
          const [linkDoc, _selector] = this.nextLink(redirDoc, redirSelector);
          // our item link should point one past the last redirect, but it may
          // be invalid (in which case, we should base the link on redirDoc).
          arrayElementLink = getNormalizedLink(
            linkDoc.value !== undefined ? linkDoc.address : redirDoc.address,
          );
          // We can follow all the links, since we don't need to track cells
          const [valueDoc, _] = this.getDocAtPath(linkDoc, [], DefaultSelector);
          docItem = valueDoc;
          this.tx.read(docItem.address, READ_FOR_SCHEDULING);
          if (docItem.value === undefined) {
            logger.debug(
              "traverse",
              () => ["getAtPath returned undefined value for array entry", doc],
            );
          }
        }
        const v = this.traverseDAG(docItem, itemDefault, arrayElementLink);
        // Use null for missing/undefined elements (consistent with other value
        // transforms in this system, e.g. toJSON and shallowFabricFromNativeValue)
        newValue[index] = v === undefined ? null : v as FabricDatum;
      });
      // Our link is based on the last link in the chain and not the first.
      const newLink = getNormalizedLink(doc.address, true);
      const arrayResult = this.objectCreator.createObject(newLink, newValue);
      if (defaultValue === undefined) {
        const memoKey = itemLink
          ? addressKey(doc.address) + "|" + addressKey(itemLink)
          : addressKey(doc.address);
        this.dagMemo.set(memoKey, arrayResult);
      }
      return arrayResult;
    } else if (isRecord(doc.value)) {
      // First, see if we need special handling
      if (isPrimitiveCellLink(doc.value)) {
        // FIXME(@ubik2): A cell link with a schema should go back into traverseSchema behavior
        // Check if target doc is already tracked BEFORE calling getAtPath,
        // since getAtPath/followPointer will add it to schemaTracker
        let alreadyTracked = false;
        // If the link didn't have a space/type, make sure we add one
        const link = parseLink(doc.value, doc.address);
        if (link.id !== undefined) {
          const targetKey = `${link.space}/${link.id}/${link.type}`;
          alreadyTracked = this.schemaTracker.hasValue(targetKey, {
            path: ["value", ...link.path],
            schema: true,
          });
        }
        const [redirDoc, _redirSelector] = this.getDocAtPath(
          doc,
          [],
          DefaultSelector,
          "writeRedirect",
        );
        this.tx.read(redirDoc.address, READ_FOR_SCHEDULING);
        if (redirDoc.value === undefined) {
          logger.debug(
            "traverse",
            () => [
              "getAtPath returned undefined value for",
              doc,
            ],
          );
          return null;
        }
        // If the target doc was already tracked before this traversal,
        // skip re-traversing it (followPointer already loaded and tracked it)
        // We can only do this in the querySchema version.
        // For validateAndTransform, we need the returned value, so we can't
        // optmize this out. We can tell based on traverseCells.
        if (
          this.traverseCells && alreadyTracked &&
          doc.address.id !== redirDoc.address.id
        ) {
          return null;
        }
        // our item link should point to the target of the last redirect
        itemLink = getNormalizedLink(redirDoc.address, true);
        // We can follow all the links, since we don't need to track cells
        const [valueDoc, _] = this.getDocAtPath(redirDoc, [], DefaultSelector);
        this.tx.read(valueDoc.address, READ_FOR_SCHEDULING);
        return this.traverseDAG(valueDoc, defaultValue, itemLink);
      } else {
        const newValue: Record<string, Immutable<FabricValue>> = {};
        using t = this.tracker.include(doc.value, true, newValue, doc);
        if (t === null) {
          return this.tracker.getExisting(doc.value, true);
        }
        const entries = Object.entries(doc.value as JSONObject).map((
          [k, v],
        ) => {
          const itemDoc = {
            address: {
              ...doc.address,
              path: appendToPath(doc.address.path, k),
            },
            value: v,
          };
          const val = this.traverseDAG(
            itemDoc,
            isRecord(defaultValue) && !Array.isArray(defaultValue)
              ? (defaultValue as JSONObject)[k]
              : undefined,
          )!;
          return [k, val];
        });
        // We copy the contents of our result into newValue so that if we have
        // a cycle, we can return newValue before we actually populate it.
        for (const [k, v] of entries) {
          if (typeof k === "string") {
            newValue[k] = v;
          }
        }
        // Our link is based on the last link in the chain and not the first.
        const newLink = itemLink ?? getNormalizedLink(doc.address, true);
        const recordResult = this.objectCreator.createObject(newLink, newValue);
        if (defaultValue === undefined) {
          const memoKey = itemLink
            ? addressKey(doc.address) + "|" + addressKey(itemLink)
            : addressKey(doc.address);
          this.dagMemo.set(memoKey, recordResult);
        }
        return recordResult;
      }
    } else {
      logger.error(
        "traverse-error",
        () => ["Encountered unexpected object: ", doc.value],
      );
      return null;
    }
  }

  // Wrapper for getAtPath that provides all the parameters that are class fields.
  protected getDocAtPath(
    doc: IMemorySpaceValueAttestation,
    path: readonly string[],
    selector?: SchemaPathSelector,
    lastNode: LastNode = "value",
  ) {
    this.getDocAtPathCalls++;
    return getAtPath(
      this.tx,
      doc,
      path,
      this.tracker,
      this.cfc,
      this.schemaTracker,
      selector,
      this.traverseCells,
      lastNode,
    );
  }

  /**
   * If the doc value has a link, we will follow that link one step and return
   * the result. Otherwise, we will just return the current doc.
   *
   * @param doc doc which has been read with nonRecursive
   * @param selector
   * @returns
   */
  protected nextLink(
    doc: IMemorySpaceValueAttestation,
    selector?: SchemaPathSelector,
  ): [IMemorySpaceValueAttestation, SchemaPathSelector | undefined] {
    if (isPrimitiveCellLink(doc.value)) {
      this.tx.read(doc.address, READ_FOR_SCHEDULING);
      return followPointer(
        this.tx,
        doc,
        [],
        this.tracker,
        this.cfc,
        this.schemaTracker,
        selector,
        this.traverseCells,
        "top",
      );
    } else {
      return [doc, selector];
    }
  }
}

/**
 * Traverses a data structure following a path and resolves any pointers.
 * If we load any additional documents, we will also let the helper know.
 *
 * We are passed a doc with a value, but this read has only been read in
 * nonRecursive mode. While we have the data, if we use these deeper portions,
 * we need to call tx.read to flag our usage.
 *
 * Our caller is responsible for registering further reads on the returned
 * attestation, though we will have flagged a nonRecursive read on any linked
 * docs, as well as deeper paths within a doc, and if we return the initial
 * doc untouched, it should have been flagged before we were called.
 *
 * @param manager - Storage manager for document access.
 * @param doc - IAttestation for the current document
 * @param path - Property/index path to follow beyond doc.address.path
 * @param tracker - Prevents pointer cycles
 * @param cfc: ContextualFlowControl with classification rules
 * @param schemaTracker: Tracks schema used for loaded docs
 * @param selector: The selector being used (its path is relative to doc's root)
 * @param includeSource: if true, we will include linked source as well as
 *   spell and $TYPE recursively
 * @param lastNode: defaults to "value", but if provided "writeRedirect", the
 *   return value will be the target of the last redirect pointer instead.
 *
 * @returns a tuple containing the following:
 *  - IAttestation object with the target doc, docRoot, path, and value.
 *  - Updated SchemaPathSelector that applies to the target doc.
 */
export function getAtPath(
  tx: IExtendedStorageTransaction,
  doc: IMemorySpaceValueAttestation,
  path: readonly string[],
  tracker: PointerCycleTracker,
  cfc: ContextualFlowControl,
  schemaTracker: MapSet<string, SchemaPathSelector>,
  selector?: SchemaPathSelector,
  includeSource?: boolean,
  lastNode: LastNode = "value",
): [
  IMemorySpaceValueAttestation,
  SchemaPathSelector | undefined,
] {
  let curDoc = doc;
  let remaining = [...path];

  while (true) {
    if (isPrimitiveCellLink(curDoc.value)) {
      // We've only done a nonRecursive read on curDoc, so promote that
      tx.read(curDoc.address, READ_FOR_SCHEDULING);
      // we follow links when we point to a child of the link, since we need
      // them to resolve the link.
      // we follow all links when the lastNode is value
      // we follow write redirect links when lastNode is writeRedirect
      const followLink = remaining.length !== 0 || lastNode === "value" ||
        lastNode === "writeRedirect" && isWriteRedirectLink(curDoc.value);
      if (!followLink) {
        return [curDoc, selector];
      }
      [curDoc, selector] = followPointer(
        tx,
        curDoc,
        remaining,
        tracker,
        cfc,
        schemaTracker,
        selector,
        includeSource,
        lastNode,
      );
      // followPointer/getAtPath have resolved all path elements
      remaining = [];
    }
    // Our return should never be a link
    //assert(!isPrimitiveCellLink(curDoc.value));
    const part = remaining.shift();
    if (part === undefined) {
      return [curDoc, selector];
    }
    // curDoc.value is not a pointer, since we either resolved those above
    // or will at the end of this loop.
    if (Array.isArray(curDoc.value)) {
      if (part === "length") {
        curDoc = {
          ...curDoc,
          address: {
            ...curDoc.address,
            path: appendToPath(curDoc.address.path, part),
          },
          value: curDoc.value.length,
        };
      } else {
        curDoc = {
          ...curDoc,
          address: {
            ...curDoc.address,
            path: appendToPath(curDoc.address.path, part),
          },
          value: elementAt(curDoc.value, part),
        };
      }
      tx.read(curDoc.address, READ_NON_RECURSIVE_FOR_SCHEDULING);
    } else if (isString(curDoc.value) && part === "length") {
      // Handle native property access on string primitives (e.g., .length).
      // Intentionally do not call tx.read here: string length changes only when
      // the string value itself is replaced, and the parent string read already
      // captures that invalidation.
      curDoc = {
        ...curDoc,
        address: {
          ...curDoc.address,
          path: appendToPath(curDoc.address.path, part),
        },
        value: curDoc.value.length,
      };
    } else if (isRecord(curDoc.value) && part in curDoc.value) {
      const cursorObj = curDoc.value as Immutable<JSONObject>;
      curDoc = {
        ...curDoc,
        address: {
          ...curDoc.address,
          path: appendToPath(curDoc.address.path, part),
        },
        value: cursorObj[part] as Immutable<FabricDatum>,
      };
      tx.read(curDoc.address, READ_NON_RECURSIVE_FOR_SCHEDULING);
    } else {
      // we can only descend into pointers, objects, and arrays
      // this can happen when things aren't set up yet, so it's just debug.
      const missing = [part, ...remaining];
      logger.debug("traverse", () => [
        "Attempted to traverse into non-object/non-array value",
        curDoc,
        missing,
      ]);
      curDoc = {
        ...curDoc,
        address: {
          ...curDoc.address,
          path: appendPartsToPath(curDoc.address.path, missing),
        },
        value: undefined,
      };
      // go ahead and register this read -- a subsequent write
      // at this location should re-trigger us
      tx.read(curDoc.address, READ_NON_RECURSIVE_FOR_SCHEDULING);
      return [curDoc, selector];
    }
  }
}

function notFound(
  address: IMemorySpaceValueAddress,
): IMemorySpaceValueAttestation {
  return {
    address,
    value: undefined,
  };
}

/**
 * Get a string to use as a key for the specified address
 *
 * @param address an IMemorySpaceAddress
 */
function getTrackerKey(
  address: IMemorySpaceAddress,
): string {
  return `${address.space}/${address.id}/${address.type}`;
}

/**
 * Resolves a pointer reference to its target value.
 *
 * This method works with @see getAtPath, with the link management and document
 * loading being handled in `followPointer`, while `getAtPath` handles the
 * path traversal.
 *
 * We only follow one pointer here, before calling `getAtPath`, but that will
 * often call back into this method to resolve links (including if the target
 * of this link is also a link).
 *
 * We'll handle tracking of the docs, combining schema, and marking the linked
 * source docs as read if needed.
 *
 * I can't just use resolveLink, since I need to also track all the
 * intermediate documents if we includeSource.
 *
 * @param tx - IStorageTransaction that can be used to read data
 * @param doc - IAttestation for the current document
 * @param path - Property/index path to follow
 * @param tracker - Prevents infinite pointer cycles
 * @param cfc: ContextualFlowControl with classification rules
 * @param schemaTracker: Tracks schema to use for loaded docs
 * @param selector: SchemaPathSelector used to query the target doc
 * @param includeSource: if true, we will include linked source as well as
 *   spell and $TYPE recursively
 * @param lastNode: This is just passed back into successive getAtPath calls,
 *   so @see getAtPath for details.
 *
 * @returns a tuple containing the following:
 *  - IAttestation object with the target doc, docRoot, path, and value.
 *  - Updated SchemaPathSelector that applies to the target doc.
 *    After following a pointer, we generally will still have path segments
 *    that we haven't handled. These will be included in the selector.path,
 *    which is relative to the top of the returned doc.
 */
function followPointer(
  tx: IExtendedStorageTransaction,
  doc: IMemorySpaceValueAttestation,
  path: readonly string[],
  tracker: PointerCycleTracker,
  cfc: ContextualFlowControl,
  schemaTracker: MapSet<string, SchemaPathSelector>,
  selector?: SchemaPathSelector,
  includeSource?: boolean,
  lastNode?: LastNode,
): [
  IMemorySpaceValueAttestation,
  SchemaPathSelector | undefined,
] {
  // doc.address's path doesn't have the same value nesting semantics as
  // link path, but we don't use the path field from that argument.
  const link = parseLink(doc.value, doc.address)!;
  // We may access portions of the doc outside what we have in our doc
  // attestation, so set the target to the top level doc from the manager.
  const target: IMemorySpaceValueAddress = {
    space: link.space,
    id: link.id,
    type: "application/json",
    // The link.path doesn't include the initial "value", so prepend it
    path: ["value", ...link.path as string[]],
  };
  if (selector !== undefined) {
    // We'll need to re-root the selector for the target doc
    // Remove the portions of doc.path from selector.path, limiting schema if
    // needed.
    // Also insert the portions of target.path, so selector is relative to
    // new target doc. We do this even if the target doc is the same doc, since
    // we want the selector path to match.
    selector = narrowSchema(doc.address.path, selector, target.path, cfc);
    // When traversing links, we combine the schema
    selector.schema = combineOptionalSchema(selector.schema, link.schema);
  }
  // Check to see if we've already included this link with this schema context
  using t = tracker.include(doc.value!, selector?.schema, null, doc);
  if (t === null) {
    // Cycle detected - treat this as notFound to avoid traversal
    logger.warn("traverse", () => ["Encountered cycle!", doc.value]);
    return [notFound(doc.address), selector];
  }
  // Attempt to read the actual link location. This will often fail because
  // there is an intermediate link, but we'll handle that below
  // Load the data from the manager.
  // The path here is just the link path, but we may be interested in the deeper
  // contents and this could just be an intermediate link, so ignore this read
  // for scheduling. We'll have to tag it later.
  // We use a nonRecursive read, since we may not need everything at the target.
  const { ok: valueEntry, error } = tx.read(target, READ_NON_RECURSIVE);

  if (error !== undefined) {
    // If we had an unexpected error, or didn't find the doc at all, return.
    if (error.name === "NotFoundError" && error.path.length === 0) {
      // If the object we're pointing to is a retracted fact, just return undefined.
      logger.info(
        "traverse",
        () => ["followPointer found missing/retracted fact", valueEntry],
      );
      // We include the path in the address, so that information is available,
      return [notFound(target), selector];
    } else if (error.name !== "NotFoundError") {
      // Unexpected error
      logger.warn("traverse", () => ["Read error!", target, error]);
      return [notFound(target), selector];
    }
  }

  // If we followed a link to a doc, and the doc exists, track our visit
  // We do this even if the id is the same, since the path may differ.
  if (link.id !== undefined) {
    trackVisitedDoc(tx, target, schemaTracker, selector, includeSource);
  }

  // If we got a NotFoundError, or an undefined because the last element
  // wasn't found, back up and try again
  if (
    error !== undefined ||
    (valueEntry != undefined && valueEntry.value === undefined)
  ) {
    // If the doc exists, but we don't have our entire path to the link target,
    // see if we can get there through intermediate documents.
    const lastPath = (error !== undefined)
      ? error.path // this may not be a ValuePath
      : valueEntry.address.path; // this is a ValuePath
    if (valueEntry === undefined || valueEntry.value === undefined) {
      let lastExisting: ValuePath = ["value"];
      // Never slice below "value" - it's the minimum valid path for getNormalizedLink
      if (lastPath.length > 1) {
        // It's possible an error path may not have a value. If so, we throw.
        if (lastPath[0] !== "value") {
          logger.error(
            "traverse",
            () => ["Invalid path:", lastPath, error, valueEntry?.address],
          );
          throw new Error("Invalid path (not a ValuePath)");
        }
        // The last element in path wasn't found, so chop that off
        lastExisting = ["value", ...lastPath.slice(1, -1)];
      }
      const remaining = target.path.slice(lastExisting.length);
      const partialTarget = { ...target, path: lastExisting };
      const lastValue = tx.readOrThrow(partialTarget)!;
      // We can continue with the target, but provide the top level target doc
      // to getAtPath.
      // An assertion fact.is will be an object with a value property, and
      // that's what our schema is relative to.
      const partialTargetDoc = {
        address: partialTarget,
        value: lastValue,
      };
      // We've loaded the linked doc, so walk the path to get to the right part of that doc (or whatever doc that path leads to),
      // then the provided path from the arguments.
      return getAtPath(
        tx,
        partialTargetDoc,
        [...remaining, ...path],
        tracker,
        cfc,
        schemaTracker,
        selector,
        includeSource,
        lastNode,
      );
    }
  }

  // We can continue with the target, but provide the top level target doc
  // to getAtPath.
  // An assertion fact.is will be an object with a value property, and
  // that's what our schema is relative to.
  const targetDoc = {
    address: target,
    value: valueEntry.value,
  };

  // We've loaded the linked doc, so walk the path to get to the right part of that doc (or whatever doc that path leads to),
  // then the provided path from the arguments.
  return getAtPath(
    tx,
    targetDoc,
    path,
    tracker,
    cfc,
    schemaTracker,
    selector,
    includeSource,
    lastNode,
  );
}
function trackVisitedDoc(
  tx: IExtendedStorageTransaction,
  target: IMemorySpaceAddress,
  schemaTracker: MapSet<string, SchemaPathSelector>,
  selector: SchemaPathSelector | undefined,
  includeSource: boolean = false,
) {
  // We have a reference to a different doc, so track the dependency
  // and update our targetDoc
  if (selector !== undefined) {
    schemaTracker.add(getTrackerKey(target), selector);
  }
  // Load the sources/patterns recursively unless we're a retracted fact.
  if (includeSource) {
    // Loading source requires the full doc. This could be narrowed, but it
    // happens in a non-reactive context.
    const { ok: fullDoc } = tx.read({ ...target, path: [] });
    if (fullDoc) {
      loadSource(
        tx,
        {
          address: { ...fullDoc.address, space: target.space },
          value: fullDoc.value,
        },
        new Set<string>(),
        schemaTracker,
      );
    }
  }
}

// Recursively load the source from the doc ()
// This will also load any patterns linked by the doc.
export function loadSource(
  tx: IExtendedStorageTransaction,
  valueEntry: IMemorySpaceAttestation,
  cycleCheck: Set<string> = new Set<string>(),
  schemaTracker: MapSet<string, SchemaPathSelector>,
) {
  loadLinkedPattern(tx, valueEntry, schemaTracker);
  if (!isRecord(valueEntry.value)) {
    return;
  }
  const targetObj = valueEntry.value as Immutable<JSONObject>;
  if (!(isRecord(targetObj) || !("source" in targetObj))) {
    return;
  }
  // We also want to include the source cells
  const source = targetObj["source"];
  if (!isRecord(source) || !("/" in source) || !isString(source["/"])) {
    // undefined is strange, but acceptable
    if (source !== undefined) {
      logger.warn(
        "traverse",
        () => ["Invalid source link", source, "in", valueEntry.address],
      );
    }
    return;
  }
  const shortId: string = source["/"];
  if (cycleCheck.has(shortId)) {
    return;
  }
  cycleCheck.add(shortId);
  const address: IMemorySpaceAddress = {
    space: valueEntry.address.space,
    id: `of:${shortId}`,
    type: "application/json",
    path: [],
  };
  // This only happens in the query path, so don't worry about scheduler
  const { ok: entry, error } = tx.read(address);
  if (error) {
    return;
  }
  if (error || entry === null || entry.value === undefined) {
    return;
  }
  const docKey = getTrackerKey(address);
  schemaTracker.add(docKey, { path: [], schema: false });

  // We've lost the space from our address in the tx.read, so recreate
  const fullEntry = { address: address, value: entry.value };
  loadSource(tx, fullEntry, cycleCheck, schemaTracker);
}

// With unified traversal code, we don't need to worry about the server
// sending a different set of files than the client needs, so we could
// tweak this policy, but we do want to be able to restrict what we have
// to send to the client, and what the client needs to watch.
// We could do this by forking our state, then doing an allOf with each
// schema. That works well for standards, but I'd have to figure out how
// to combine the resulting objects into one.
// NOTE: I forgot about https://github.com/commontoolsinc/labs/pull/1868,
// which is a more sophisticated approach.
function combineOptionalSchema(
  parentSchema: JSONSchema | undefined,
  linkSchema: JSONSchema | undefined,
): JSONSchema | undefined {
  if (parentSchema === undefined) {
    return linkSchema;
  } else if (linkSchema === undefined) {
    return parentSchema;
  } else if (ContextualFlowControl.isTrueSchema(parentSchema)) {
    return combineSchema(parentSchema, linkSchema);
  } else if (ContextualFlowControl.isTrueSchema(linkSchema)) {
    return parentSchema;
  }
  return combineSchema(parentSchema, linkSchema);
}

// Merge any schema flags like asCell or asStream from flagSchema into schema.
export function mergeSchemaFlags(flagSchema: JSONSchema, schema: JSONSchema) {
  const key = hashSchema(flagSchema) + "|" + hashSchema(schema);
  const cached = _mergeSchemaFlagsCache.get(key);
  if (cached !== undefined) return cached;
  const result = _mergeSchemaFlagsUncached(flagSchema, schema);
  internSet(_mergeSchemaFlagsCache, key, result);
  return result;
}

function _mergeSchemaFlagsUncached(
  flagSchema: JSONSchema,
  schema: JSONSchema,
) {
  if (isRecord(flagSchema)) {
    // we want to preserve asCell and asStream -- if true, these will override
    // the value in the schema
    const { asCell, asStream } = flagSchema;
    if (asCell || asStream) {
      if (schema === true) {
        return {
          ...(asCell && { asCell: true }),
          ...(asStream && { asStream: true }),
        };
      } else if (schema === false) {
        return false;
      }
      return {
        ...schema,
        ...((asCell || schema.asCell) && { asCell: true }),
        ...((asStream || schema.asStream) && { asStream: true }),
      };
    }
  }
  return schema;
}

/**
 * Generate a schema that represents the pseudo-intersection of two other
 * schemas.
 *
 * This lets us combine the schema that we entered this doc with a schema
 * encountered within a link in the doc.
 *
 * We could handle this with an allOf (implemented with state snapshots),
 * and be JSONSchema compliant, but that leaves an unclear strategy for
 * merging the resulting objects.
 *
 * There's a lot of things you can express with JSONSchema that aren't
 * going to be properly handled here, but make a best effort.
 *
 * We don't handle $refs in the schema, so it's quite possible to end up with
 * $ref links that can't be resolved.
 *
 * @param parentSchema
 * @param linkSchema
 * @returns
 */
export function combineSchema(
  parentSchema: JSONSchema,
  linkSchema: JSONSchema,
): JSONSchema {
  const key = hashSchema(parentSchema) + "|" + hashSchema(linkSchema);
  const cached = _combineSchemaCache.get(key);
  if (cached !== undefined) return cached;
  const result = _combineSchemaUncached(parentSchema, linkSchema);
  internSet(_combineSchemaCache, key, result);
  return result;
}

function _combineSchemaUncached(
  parentSchema: JSONSchema,
  linkSchema: JSONSchema,
): JSONSchema {
  if (ContextualFlowControl.isTrueSchema(parentSchema)) {
    return mergeSchemaFlags(parentSchema, linkSchema);
  } else if (ContextualFlowControl.isTrueSchema(linkSchema)) {
    return mergeSchemaFlags(linkSchema, parentSchema);
  } else if (isRecord(linkSchema) && isRecord(parentSchema)) {
    if (linkSchema.type === "object" && parentSchema.type === "object") {
      // If both schemas have required properties, only include those that are
      // in both lists
      const {
        required: parentRequired,
        $defs: parentDefs,
        ...parentSchemaRest
      } = parentSchema;
      const { required: linkRequired, $defs: linkDefs, ...linkSchemaRest } =
        linkSchema;
      const required = parentRequired && linkRequired
        ? parentRequired.filter((item) => linkRequired.includes(item))
        : parentRequired
        ? parentRequired
        : linkRequired;
      const mergedDefs = { ...linkDefs, ...parentDefs };
      // When combining these object types, if they both have properties,
      // we only want to include any properties that they both have.
      // If only one has properties, we will use that set
      // If neither have properties, since that enables all, we will leave
      // that alone.
      // Our additionalProperties default is based on whether we we have defined
      // properties
      // If one schema has a property defined, and another schema has an
      // additionalProperties that covers that, we use the defined property
      // and don't pick up flags like asCell from additionalProperties.
      const parentAdditionalProperties = parentSchema.additionalProperties ??
        (parentSchema.properties === undefined);
      const linkAdditionalProperties = linkSchema.additionalProperties ??
        (linkSchema.properties === undefined);
      if (
        parentSchema.properties === undefined &&
        ContextualFlowControl.isTrueSchema(parentAdditionalProperties)
      ) {
        const additionalProperties =
          linkSchema.additionalProperties !== undefined
            ? mergeSchemaFlags(
              parentAdditionalProperties,
              linkSchema.additionalProperties,
            )
            : parentAdditionalProperties;
        // Need to keep the flags from parent schema here
        // We'll also be explicit about additionalProperties and required
        return mergeSchemaFlags(parentSchema, {
          ...linkSchemaRest,
          additionalProperties,
          ...(required && { required }),
          ...(Object.keys(mergedDefs).length && { $defs: mergedDefs }),
        });
      } else if (
        linkSchema.properties === undefined &&
        ContextualFlowControl.isTrueSchema(linkAdditionalProperties)
      ) {
        if (parentSchema.additionalProperties !== undefined) {
          return {
            ...parentSchemaRest,
            additionalProperties: mergeSchemaFlags(
              linkAdditionalProperties,
              parentSchema.additionalProperties,
            ),
            ...(required && { required }),
            ...(Object.keys(mergedDefs).length && { $defs: mergedDefs }),
          };
        }
        return {
          ...parentSchemaRest,
          ...(required && { required }),
          ...(Object.keys(mergedDefs).length && { $defs: mergedDefs }),
        };
      }
      // Both objects may have properties
      const mergedSchemaProperties: Record<string, JSONSchema> = {};
      if (linkSchema.properties !== undefined) {
        for (const [key, value] of Object.entries(linkSchema.properties)) {
          if (
            parentSchema.properties !== undefined &&
            parentSchema.properties[key] !== undefined
          ) {
            mergedSchemaProperties[key] = combineSchema(
              parentSchema.properties[key],
              value,
            );
          } else {
            mergedSchemaProperties[key] = combineSchema(
              parentAdditionalProperties,
              value,
            );
          }
        }
      }
      if (parentSchema.properties !== undefined) {
        for (const [key, value] of Object.entries(parentSchema.properties)) {
          if (
            linkSchema.properties !== undefined &&
            linkSchema.properties[key] !== undefined
          ) {
            continue; // already handled
          } else {
            mergedSchemaProperties[key] = combineSchema(
              value,
              linkAdditionalProperties,
            );
          }
        }
      }
      return {
        type: "object",
        ...linkSchema,
        ...parentSchema,
        properties: mergedSchemaProperties,
        ...(required && { required }),
        ...(Object.keys(mergedDefs).length && { $defs: mergedDefs }),
      };
    } else if (linkSchema.type === "array" && parentSchema.type === "array") {
      if (parentSchema.items === undefined) {
        return linkSchema;
      } else if (linkSchema.items === undefined) {
        return parentSchema;
      }
      const mergedDefs = { ...linkSchema.$defs, ...parentSchema.$defs };
      const mergedSchemaItems = combineSchema(
        parentSchema.items,
        linkSchema.items,
      );
      // this isn't great, but at least grab the flags from parent schema
      return mergeSchemaFlags(parentSchema, {
        ...linkSchema,
        type: "array",
        items: mergedSchemaItems,
        ...(Object.keys(mergedDefs).length && { $defs: mergedDefs }),
      });
    } else {
      // this isn't great, but at least grab the flags from parent schema
      // Merge $defs from the two schema, with parent taking priority
      const mergedDefs = { ...linkSchema.$defs, ...parentSchema.$defs };
      // In this case, we use the link for flags, but generally use the parent
      // since the object types may be different
      return mergeSchemaFlags(linkSchema, {
        ...parentSchema,
        ...(Object.keys(mergedDefs).length && { $defs: mergedDefs }),
      });
    }
  }
  return linkSchema;
}

// Load the linked pattern from the doc ()
// We don't recurse, since that's not required for pattern links
// We don't mark anything for reactivity, since this is for queries
function loadLinkedPattern(
  tx: IExtendedStorageTransaction,
  valueEntry: IMemorySpaceAttestation,
  schemaTracker: MapSet<string, SchemaPathSelector>,
) {
  if (!isRecord(valueEntry.value)) {
    return;
  }
  const targetObj = valueEntry.value as Immutable<JSONObject>;
  if (!(isRecord(targetObj) || !("value" in targetObj))) {
    return;
  }
  // We also want to include the source cells
  const value = targetObj["value"];
  if (!isRecord(value)) {
    return;
  }
  let address: IMemorySpaceAddress | undefined;
  // Check for a spell link first, since this is more efficient
  // Older patterns will only have a $TYPE
  if ("spell" in value && isPrimitiveCellLink(value["spell"])) {
    const link = parseLink(value["spell"], valueEntry.address)!;
    address = {
      space: link.space,
      id: link.id!,
      type: link.type! as MIME,
      path: [],
    };
  } else if ("$TYPE" in value && isString(value["$TYPE"])) {
    const patternId = value["$TYPE"];
    const entityId = hashOf({ causal: { patternId, type: "pattern" } });
    const shortId = entityId.toJSON()["/"];
    address = {
      space: valueEntry.address.space,
      id: `of:${shortId}`,
      type: "application/json",
      path: [],
    };
  }
  if (address === undefined) {
    return;
  }
  // This only happens in the query path, so don't worry about scheduler
  const result = tx.read(address);
  if (result.error) {
    return;
  }
  let entry = result.ok;
  // Fall back to legacy {recipeId, type: "recipe"} cause for backwards compat
  if (
    (entry === null || entry.value === undefined) &&
    "$TYPE" in value && isString(value["$TYPE"])
  ) {
    const patternId = value["$TYPE"];
    const legacyEntityId = hashOf({
      causal: { recipeId: patternId, type: "recipe" },
    });
    const legacyShortId = legacyEntityId.toJSON()["/"];
    const legacyAddress: IMemorySpaceAddress = {
      space: address.space,
      id: `of:${legacyShortId}` as IMemorySpaceAddress["id"],
      type: "application/json" as MIME,
      path: [],
    };
    // This only happens in the query path, so don't worry about scheduler
    const legacyResult = tx.read(legacyAddress);
    if (!legacyResult.error) {
      entry = legacyResult.ok;
      address = legacyAddress;
    }
  }
  if (entry === null || entry.value === undefined) {
    return;
  }
  const docKey = getTrackerKey(address);
  schemaTracker.add(docKey, { path: [], schema: false });
}

// docPath is where we found the pointer and are doing this work. It should
// include the initial "value" portion.
// Selector path and schema used to be relative to the "value" of the doc, but
// we want them relative to the "value" of the new doc.
// targetPath is the path in the target doc that the pointer points to -- the
// targetPath should include the initial "value"
function narrowSchema(
  docPath: readonly string[],
  selector: SchemaPathSelector,
  targetPath: readonly string[],
  cfc: ContextualFlowControl,
): SchemaPathSelector {
  let pathIndex = 0;
  while (pathIndex < docPath.length && pathIndex < selector.path.length) {
    if (docPath[pathIndex] !== selector.path[pathIndex]) {
      logger.warn(
        "traverse",
        () => ["Mismatched paths", docPath, selector.path],
      );
      // these paths should include value even if we failed to match
      return { path: ["value"], schema: false };
    }
    pathIndex++;
  }
  if (pathIndex < docPath.length) {
    // we've reached the end of our selector path, but still have parts in our doc path, so narrow the schema
    // Some of the schema may have been applicable to other parts of the doc, but we only want to use the
    // portion that will apply to the next doc.
    const schema = cfc.schemaAtPath(selector.schema!, docPath.slice(pathIndex));
    return { path: [...targetPath], schema };
  } else {
    // We've reached the end of the doc path, but may still have stuff in our
    // selector path, so remove the path parts we've already walked from the
    // selector.
    return {
      path: [...targetPath, ...selector.path.slice(docPath.length)],
      schema: selector.schema,
    };
  }
}

function elementAt<T>(array: T[], path: string): T | undefined {
  // Only access as array index if path is a valid index string.
  // Out-of-bounds access returns undefined (standard JS behavior).
  return isArrayIndexPropertyName(path)
    ? (array as unknown as Record<string, T>)[path]
    : undefined;
}

type Primitive = string | number | boolean | null | undefined | symbol | bigint;

export function isPrimitive(val: unknown): val is Primitive {
  const type = typeof val;
  return val === null || (type !== "object" && type !== "function");
}

type TraverseResult<T> = { ok: T; error?: never } | {
  ok?: never;
  error: Error;
};

/** Opaque memo cache shared across SchemaObjectTraverser instances within a query */
export type SchemaMemo = Map<string, TraverseResult<Immutable<FabricValue>>>;

/** Create a shared memo cache to pass to multiple SchemaObjectTraverser instances */
export function createSchemaMemo(): SchemaMemo {
  return new Map();
}

export class SchemaObjectTraverser<V extends FabricDatum>
  extends BaseObjectTraverser {
  private sharedSchemaMemo?: SchemaMemo;

  constructor(
    tx: IExtendedStorageTransaction,
    selector: SchemaPathSelector = DefaultSelector,
    tracker: PointerCycleTracker = new CompoundCycleTracker<
      Immutable<FabricDatum>,
      JSONSchema | undefined
    >(),
    schemaTracker: MapSetStringToPathSelectors =
      new MapSetStringToPathSelectors(true),
    cfc: ContextualFlowControl = new ContextualFlowControl(),
    objectCreator?: IObjectCreator<V>,
    traverseCells?: boolean,
    sharedSchemaMemo?: SchemaMemo,
  ) {
    super(
      tx,
      selector,
      tracker,
      schemaTracker,
      cfc,
      objectCreator,
      traverseCells,
    );
    this.sharedSchemaMemo = sharedSchemaMemo;
  }

  // Traversal stats counters
  traverseWithSchemaCalls = 0;
  traversePointerCalls = 0;
  traverseArrayCalls = 0;
  traverseObjectCalls = 0;
  override traverseDAGCalls = 0;
  anyOfBranches = 0;
  anyOfFastRejects = 0;
  anyOfPropertyMerges = 0;
  override getDocAtPathCalls = 0;
  // Track per-doc visit counts and unique paths
  private docVisits = new Map<string, number>();
  private uniquePaths = new Set<string>();
  private maxDepth = 0;
  private currentDepth = 0;
  // Memoization cache for traverseWithSchema: key → result
  // Only used when traverseCells=true (query path) where the link
  // parameter doesn't affect the result (StandardObjectCreator ignores it).
  // When sharedSchemaMemo is provided, it's used instead (persists across
  // multiple traverse() calls for the same selectSchema query).
  private schemaMemo = new Map<
    string,
    TraverseResult<Immutable<FabricValue>>
  >();
  schemaMemoHits = 0;

  private get activeMemo(): Map<
    string,
    TraverseResult<Immutable<FabricValue>>
  > {
    return this.sharedSchemaMemo ?? this.schemaMemo;
  }

  override traverse(
    doc: IMemorySpaceValueAttestation,
    link?: NormalizedFullLink,
  ): TraverseResult<Immutable<FabricValue>> {
    // Reset per-traverse stats (but NOT the shared memo)
    this.traverseWithSchemaCalls = 0;
    this.traversePointerCalls = 0;
    this.traverseArrayCalls = 0;
    this.traverseObjectCalls = 0;
    this.traverseDAGCalls = 0;
    this.anyOfBranches = 0;
    this.anyOfFastRejects = 0;
    this.anyOfPropertyMerges = 0;
    this.getDocAtPathCalls = 0;
    this.docVisits.clear();
    this.uniquePaths.clear();
    this.maxDepth = 0;
    this.currentDepth = 0;
    this.schemaMemoHits = 0;
    // Only clear private memo, not shared
    if (!this.sharedSchemaMemo) {
      this.schemaMemo.clear();
    }
    // Reset MapSet deepEqual counters
    this.schemaTracker.deepEqualCalls = 0;
    this.schemaTracker.deepEqualMs = 0;

    logger.timeStart("traverse");
    this.schemaTracker.add(getTrackerKey(doc.address), this.selector);
    // Flag the top level read of doc for the scheduler
    this.tx.readOrThrow(doc.address, READ_NON_RECURSIVE_FOR_SCHEDULING);
    const rv = this.traverseWithSelector(doc, this.selector, link);
    const { error } = rv;
    const elapsed = logger.timeEnd("traverse") ?? 0;
    if (elapsed > 100) {
      // Find top visited docs
      const topDocs = [...this.docVisits.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([id, count]) => `${id.slice(0, 20)}..=${count}`)
        .join(" ");
      logger.warn("slow-traverse", () => [
        `${elapsed.toFixed(0)}ms`,
        `doc=${doc.address.id}/${doc.address.type}`,
        `trackerKeys=${this.schemaTracker.size}`,
        `trackerVals=${this.schemaTracker.totalValues}`,
        `traverseSchema=${this.traverseWithSchemaCalls}`,
        `traversePtr=${this.traversePointerCalls}`,
        `traverseArr=${this.traverseArrayCalls}`,
        `traverseObj=${this.traverseObjectCalls}`,
        `traverseDAG=${this.traverseDAGCalls}`,
        `anyOfBranches=${this.anyOfBranches}`,
        `anyOfFastRejects=${this.anyOfFastRejects}`,
        `anyOfPropertyMerges=${this.anyOfPropertyMerges}`,
        `getDocAtPath=${this.getDocAtPathCalls}`,
        `dagMemo=${this.dagMemo.size}`,
        `uniqueDocs=${this.docVisits.size}`,
        `uniquePaths=${this.uniquePaths.size}`,
        `maxDepth=${this.maxDepth}`,
        `schemaMemo=${this.activeMemo.size}`,
        `schemaMemoHits=${this.schemaMemoHits}`,
        `topDocs=${topDocs}`,
      ]);
    }
    if (error !== undefined) {
      // This helps track down mismatched schemas, but may be fine
      logger.debug("traverse", () => [
        "Call to traverse failed validation",
        doc,
        JSON.stringify(this.selector?.schema, undefined, 2),
        this.getDebugValue(doc),
      ]);
    }
    return rv;
  }

  /**
   * Traverse the specified doc with the selector.
   * The selector should have been re-rooted if needed to be relative to the
   * specified doc. This generally means that its path starts with value.
   * The selector must have a valid (defined) schema
   * Once we've gotten the path of our doc to match the path of our selector,
   * we can call traverseWithSchema instead.
   */
  traverseWithSelector(
    doc: IMemorySpaceValueAttestation,
    selector: SchemaPathSelector,
    link?: NormalizedFullLink,
  ): TraverseResult<Immutable<FabricValue>> {
    const docPath = doc.address.path;
    if (deepEqual(docPath, selector.path)) {
      return this.traverseWithSchema(doc, selector.schema!, link);
    } else if (docPath.length > selector.path.length) {
      throw new Error("Doc path should never exceed selector path");
    } else if (
      !deepEqual(docPath, selector.path.slice(0, docPath.length))
    ) {
      // There's a mismatch in the initial part, so this will not match
      logger.debug("traverse", () => ["path mismatch", docPath, selector.path]);
      return { error: new Error("Path mismatch") };
    } else { // valuePath length < selector.path.length
      const [nextDoc, nextSelector] = this.getDocAtPath(
        doc,
        selector.path.slice(docPath.length),
        selector,
        "writeRedirect",
      );
      if (nextDoc.value === undefined) {
        // While this is technically acceptable, log it
        logger.debug("traverse", () => [
          "value is undefined",
          docPath,
          selector.path,
        ]);
        if (
          nextSelector?.schema === undefined ||
          SchemaObjectTraverser.asCellOrStream(nextSelector.schema)
        ) {
          // If we don't have a schema, we don't allow undefined
          // If we have a schema with asCell, we can't create a cell for this,
          // since we can't follow all the write-redirect links.
          // In the future, getAtPath could be altered to convey whether we
          // found a valid undefined node, and we can handle this better, but
          // right now there's no way for that to happen.
          return { error: new Error("Encountered link to undefined value") };
        } else {
          return this.isValidType(nextSelector.schema, "undefined")
            ? { ok: this.traversePrimitive(nextDoc, nextSelector.schema) }
            : { error: new Error("Encountered link to undefined value") };
        }
      }
      if (!deepEqual(nextDoc.address.path, nextSelector!.path)) {
        throw new Error("New doc path doesn't match selector path");
      }
      // our link should point to the target of the last redirect
      link = getNormalizedLink(nextDoc.address, nextSelector?.schema);
      return this.traverseWithSchema(
        nextDoc,
        nextSelector!.schema!,
        link,
      );
    }
  }

  // Generally handles anyOf
  // TODO(@ubik2): Need to break this up -- it's too long
  /**
   * Traverse the doc with the specified schema.
   *
   * Our doc parameter has been read in nonRecursive mode.
   *
   * @param doc
   * @param schema
   * @param link optional top level link information that we may need to
   *   pass to the object creator later
   * @returns the traversed value, wrapped in a Result object, or an error if
   *   the doc does not match the schema
   */
  traverseWithSchema(
    doc: IMemorySpaceValueAttestation,
    schema: JSONSchema,
    link?: NormalizedFullLink,
  ): TraverseResult<Immutable<FabricValue>> {
    this.traverseWithSchemaCalls++;
    this.currentDepth++;
    if (this.currentDepth > this.maxDepth) this.maxDepth = this.currentDepth;
    // Track doc visits
    const docId = doc.address.id;
    this.docVisits.set(docId, (this.docVisits.get(docId) ?? 0) + 1);
    // Track unique doc+path combos
    this.uniquePaths.add(docId + "/" + doc.address.path.join("/"));
    try {
      // Memoize by doc address + schema for the query path (traverseCells=true).
      // In the query path, StandardObjectCreator ignores the link param,
      // so the result is fully determined by address + schema.
      if (this.traverseCells) {
        const memo = this.activeMemo;
        const memoKey = docId + "|" + doc.address.path.join("/") + "|" +
          hashSchema(schema);
        const cached = memo.get(memoKey);
        if (cached !== undefined) {
          this.schemaMemoHits++;
          return cached;
        }
        const result = this._traverseWithSchemaInner(doc, schema, link);
        memo.set(memoKey, result);
        return result;
      }
      return this._traverseWithSchemaInner(doc, schema, link);
    } finally {
      this.currentDepth--;
    }
  }

  private _traverseWithSchemaInner(
    doc: IMemorySpaceValueAttestation,
    schema: JSONSchema,
    link?: NormalizedFullLink,
  ): TraverseResult<Immutable<FabricValue>> {
    // Track both the unresolved version of our schema (possibly with top
    // level $ref) and the resolved version.
    let resolved: JSONSchema | undefined = schema;
    if (isRecord(schema) && "$ref" in schema) {
      // Handle any top-level $ref in the schema
      resolved = ContextualFlowControl.resolveSchemaRefs(schema);
      if (resolved === undefined) {
        logger.warn(
          "traverse",
          () => ["Failed to resolve schema ref", schema],
        );
        return { error: new Error("Failed to resolve schema ref") };
      }
    }
    if (isRecord(resolved)) {
      // There are a lot of valid logical schema flags, and we only handle
      // a very limited set here, with no support for combinations.
      if (resolved.anyOf) {
        const { anyOf, ...restSchema } = resolved;
        // Consider items without asCell or asStream first, since if we aren't
        // traversing cells, we consider them a match.
        const sortedAnyOf = [
          ...anyOf.filter((option) =>
            !SchemaObjectTraverser.asCellOrStream(option)
          ),
          ...anyOf.filter(SchemaObjectTraverser.asCellOrStream),
        ];

        // Branch-by-branch traversal; fast-reject after merge so canBranchMatch
        // sees the full merged constraints (type/required from restSchema too).
        const matches: Immutable<FabricValue>[] = [];
        for (const optionSchema of sortedAnyOf) {
          this.anyOfBranches++;
          if (ContextualFlowControl.isFalseSchema(optionSchema)) {
            continue;
          }
          const mergedSchema = mergeSchemaOption(restSchema, optionSchema);
          if (!canBranchMatch(mergedSchema, doc.value)) {
            this.anyOfFastRejects++;
            continue;
          }
          // TODO(@ubik2): do i need to merge the link schema?
          const { ok: val, error } = this.traverseWithSchema(
            doc,
            mergedSchema,
            link,
          );
          if (error === undefined) {
            // We may just have a cell match, so the first match is what we
            // will return, but in this case, we still want to evaluate with
            // all the schema options, so we know to include all the potential
            // docs needed.
            matches.push(val);
          }
        }
        const merged = this.objectCreator.mergeMatches(
          matches as FabricDatum[],
          resolved,
        );
        if (matches.length > 0) {
          return { ok: merged };
        }
        // None of the anyOf patterns matched
        logger.info(
          "traverse",
          () => [
            "No matching anyOf",
            doc,
            sortedAnyOf,
            this.getDebugValue(doc),
          ],
        );
        return { error: new Error("No matching anyOf") };
      } else if (resolved.oneOf) {
        const { oneOf, ...restSchema } = resolved;
        // Consider items without asCell or asStream first, since if we aren't
        // traversing cells, we consider them a match.
        const sortedOneOf = [
          ...oneOf.filter((option) =>
            !SchemaObjectTraverser.asCellOrStream(option)
          ),
          ...oneOf.filter(SchemaObjectTraverser.asCellOrStream),
        ];
        let matchCount = 0;
        let match: Immutable<FabricValue> | undefined = undefined;
        for (const optionSchema of sortedOneOf) {
          if (ContextualFlowControl.isFalseSchema(optionSchema)) {
            continue;
          }
          const mergedSchema = mergeSchemaOption(restSchema, optionSchema);
          // TODO(@ubik2): do i need to merge the link schema?
          const { ok: val, error } = this.traverseWithSchema(
            doc,
            mergedSchema,
            link,
          );
          if (error === undefined) {
            matchCount++;
            match = val;
          }
        }
        if (matchCount === 1) {
          return { ok: match! };
        }
        if (matchCount === 0) {
          logger.info(
            "traverse",
            () => [
              "No matching oneOf",
              doc,
              sortedOneOf,
              this.getDebugValue(doc),
            ],
          );
          return { error: new Error("No matching oneOf") };
        }
        logger.info(
          "traverse",
          () => [
            "Multiple matching oneOf",
            doc,
            sortedOneOf,
            this.getDebugValue(doc),
          ],
        );
        return { error: new Error("Multiple matching oneOf") };
      } else if (resolved.allOf) {
        const matches: Immutable<FabricValue>[] = [];
        const { allOf, ...restSchema } = resolved;
        for (const optionSchema of allOf) {
          if (ContextualFlowControl.isFalseSchema(optionSchema)) {
            logger.debug(
              "traverse",
              () => ["Encountered false in allOf", resolved],
            );
            return { error: new Error("Encountered false in allOf") };
          }
          const mergedSchema = mergeSchemaOption(restSchema, optionSchema);
          // TODO(@ubik2): do i need to merge the link schema?
          const { ok: val, error } = this.traverseWithSchema(
            doc,
            mergedSchema,
            link,
          );
          if (error !== undefined) {
            // One of the allOf patterns failed to match
            logger.debug(
              "traverse",
              () => ["Failed entry in allOf", doc, optionSchema, resolved],
            );
            return { error };
          }
          matches.push(val);
        }
        if (allOf.length > 0) {
          const merged = this.objectCreator.mergeMatches(
            matches as FabricDatum[],
            resolved,
          );
          return {
            ok: (merged ?? matches[matches.length - 1]) as Immutable<
              FabricValue
            >,
          };
        }
        // If we have allOf: [], just ignore it and continue
        // TODO(@ubik2) -- maybe swap the schema to true
      }
    }
    if (
      ContextualFlowControl.isTrueSchema(resolved) &&
      !SchemaObjectTraverser.asCellOrStream(resolved)
    ) {
      const defaultValue = isRecord(resolved) ? resolved["default"] : undefined;
      // A value of true or {} means we match anything
      // Resolve the rest of the doc, and return
      this.tx.read(doc.address, READ_FOR_SCHEDULING); // recursively read this doc
      return { ok: this.traverseDAG(doc, defaultValue, link) };
    } else if (
      ContextualFlowControl.isFalseSchema(resolved) &&
      !SchemaObjectTraverser.asCellOrStream(resolved)
    ) {
      // This value rejects all objects - just return
      return { error: new Error("Schema is false") };
    } else if (!isRecord(resolved)) {
      logger.warn(
        "traverse",
        () => ["Invalid schema is not an object", resolved],
      );
      throw new Error("Schema is neither boolean nor an object");
    }
    const schemaObj = resolved;
    if (doc.value === undefined) {
      // If we have a default, annotate it and return it
      // Otherwise, return undefined
      const defaultValue = this.applyDefault(doc, resolved);
      return (defaultValue !== undefined)
        ? { ok: defaultValue }
        : this.isValidType(schemaObj, "undefined")
        ? { ok: this.traversePrimitive(doc, schemaObj) }
        : { error: new Error("Invalid type") };
    } else if (doc.value === null) {
      return this.isValidType(schemaObj, "null")
        ? { ok: this.traversePrimitive(doc, schemaObj) }
        : { error: new Error("Invalid type") };
    } else if (isString(doc.value)) {
      return this.isValidType(schemaObj, "string")
        ? { ok: this.traversePrimitive(doc, schemaObj) }
        : { error: new Error("Invalid type") };
    } else if (isFiniteNumber(doc.value)) {
      return this.isValidType(schemaObj, "number")
        ? { ok: this.traversePrimitive(doc, schemaObj) }
        : { error: new Error("Invalid type") };
    } else if (isBoolean(doc.value)) {
      return this.isValidType(schemaObj, "boolean")
        ? { ok: this.traversePrimitive(doc, schemaObj) }
        : { error: new Error("Invalid type") };
    } else if (Array.isArray(doc.value)) {
      const valid = this.isValidType(schemaObj, "array");
      if (valid === TypeValidity.False) {
        return { error: new Error("Invalid type") };
      }

      const newValue: Immutable<FabricValue>[] = [];
      // Our link is based on the last link in the chain and not the first.
      const newLink = link ?? getNormalizedLink(
        doc.address,
        schemaObj,
      );
      using t = this.tracker.include(doc.value, schema, newValue, doc);
      if (t === null) {
        // newValue will be converted to a createObject result by the
        // function that added it to the tracker, so don't do that here
        return { ok: this.tracker.getExisting(doc.value, schema) };
      }
      if (valid === TypeValidity.Unknown) {
        return { ok: this.objectCreator.createObject(newLink, undefined) };
      }
      const entries = this.traverseArrayWithSchema(doc, schemaObj, newLink);
      if (!Array.isArray(entries)) {
        return { error: new Error("Invalid array") };
      }
      entries.forEach((item, i) => {
        newValue[i] = item;
      });
      newValue.length = entries.length;
      return { ok: this.objectCreator.createObject(newLink, newValue) };
    } else if (isRecord(doc.value)) {
      if (isPrimitiveCellLink(doc.value)) {
        this.tx.read(doc.address, READ_FOR_SCHEDULING);
        // When traversing a pointer, use the unresolved schema, so we have
        // the same values in the schema tracker.
        return this.traversePointerWithSchema(doc, schema, link);
      } else {
        const valid = this.isValidType(schemaObj, "object");
        if (valid === TypeValidity.False) {
          return { error: new Error("Invalid type") };
        }
        const newValue: Record<string, Immutable<FabricValue>> = {};
        // Our link is based on the last link in the chain and not the first.
        const newLink = link ?? getNormalizedLink(doc.address, schemaObj);
        using t = this.tracker.include(doc.value, schemaObj, newValue, doc);
        if (t === null) {
          // newValue will be converted to a createObject result by the
          // function that added it to the tracker, so don't do that here
          return { ok: this.tracker.getExisting(doc.value, schemaObj) };
        }
        if (valid === TypeValidity.Unknown) {
          return { ok: this.objectCreator.createObject(newLink, undefined) };
        }
        const entries = this.traverseObjectWithSchema(doc, schemaObj, newLink);
        if (entries === undefined || entries === null) {
          return { error: new Error("Invalid object") };
        }
        for (const [k, v] of Object.entries(entries)) {
          newValue[k] = v;
        }
        // TODO(@ubik2): We should be able to remove this cast when we make
        // our return types more correct (we can hold cells/functions).
        return {
          ok: this.objectCreator.createObject(
            newLink,
            newValue as FabricDatum,
          ),
        };
      }
    }
    return { error: new Error("Unexpected type for doc value") };
  }

  /**
   * Check whether the javascript type of the value matches the schema type
   *
   * This is a pruning method, and is not the full test, so don't reject early
   *
   * @param schema
   * @param valueType
   * @returns TypeValidity.True if the value type matches the schema type,
   *  TypeValidity.False if it doesn't, and TypeValidity.Unknown if we match
   *  the "unknown" type.
   */
  private isValidType(
    schema: JSONSchema,
    valueType: string,
  ): TypeValidity {
    if (ContextualFlowControl.isTrueSchema(schema)) {
      return TypeValidity.True;
    } else if (ContextualFlowControl.isFalseSchema(schema)) {
      return TypeValidity.False;
    }
    const schemaObj = schema as JSONSchemaObj;
    // Check the top level type flag
    let typeValidity: TypeValidity.True | TypeValidity.Unknown | undefined;
    if ("type" in schemaObj) {
      if (Array.isArray(schemaObj["type"])) {
        const types = schemaObj["type"];
        // type unknown matches anything
        if (types.includes("unknown")) {
          typeValidity = TypeValidity.Unknown;
        } else if (!types.includes(valueType)) {
          return TypeValidity.False;
        }
      } else if (isString(schemaObj["type"])) {
        const type = schemaObj["type"];
        // type unknown matches anything
        if (type === "unknown") {
          typeValidity = TypeValidity.Unknown;
        } else if (type !== valueType) {
          return TypeValidity.False;
        }
      } else {
        // invalid schema type
        throw new Error("Invalid schema type");
      }
    }
    // Limited allOf handling
    let allOfValidity: TypeValidity.True | TypeValidity.Unknown | undefined;
    if (schemaObj.allOf) {
      // unknown & T => T
      let match: TypeValidity.True | TypeValidity.Unknown | undefined;
      for (const option of schemaObj.allOf) {
        const valid = this.isValidType(option, valueType);
        // ignore undefined result (unknown type), but if any option returns
        // false, the whole thing is false
        if (valid === TypeValidity.False) {
          return TypeValidity.False;
        } else if (valid === TypeValidity.True) {
          match = TypeValidity.True;
        } else if (valid === TypeValidity.Unknown && match === undefined) {
          match = TypeValidity.Unknown;
        }
      }
      allOfValidity = match ?? TypeValidity.True;
    }
    // Limited anyOf handling
    let anyOfValidity: TypeValidity.True | TypeValidity.Unknown | undefined;
    if (schemaObj.anyOf) {
      // unknown | T => unknown
      let match: TypeValidity.True | TypeValidity.Unknown | undefined;
      for (const option of schemaObj.anyOf) {
        if (ContextualFlowControl.isTrueSchema(option)) {
          // unknown | any => any
          match = TypeValidity.True;
          break;
        }
        const valid = this.isValidType(option, valueType);
        if (valid === TypeValidity.False) {
          continue;
        } else if (match !== TypeValidity.Unknown) {
          match = valid;
        }
      }
      if (match === undefined) {
        return TypeValidity.False;
      } else {
        anyOfValidity = match;
      }
    }
    // Limited oneOf handling
    // This is handled the same as anyOf here
    let oneOfValidity: TypeValidity.True | TypeValidity.Unknown | undefined;
    if (schemaObj.oneOf) {
      let match: TypeValidity.True | TypeValidity.Unknown | undefined;
      for (const option of schemaObj.oneOf) {
        if (ContextualFlowControl.isTrueSchema(option)) {
          // unknown | any => any
          match = TypeValidity.True;
          break;
        }
        const valid = this.isValidType(option, valueType);
        if (valid === TypeValidity.False) {
          continue;
        } else if (match !== TypeValidity.Unknown) {
          // this may be more than one, but we don't know that the rest of
          // the validation will pass, so don't reject.
          match = valid;
        }
      }
      if (match === undefined) {
        return TypeValidity.False;
      } else {
        oneOfValidity = match;
      }
    }
    // We can't rule out a matched type based on the logical `not` clause,
    // so we don't deal with that here.
    // We have four sources of validity, which are all and-ed together.
    // Since unknown disappears in type intersections, any true will win.
    const validities = [
      typeValidity,
      allOfValidity,
      anyOfValidity,
      oneOfValidity,
    ];
    if (
      validities.some((x) => x === TypeValidity.True) ||
      validities.every((x) => x === undefined)
    ) {
      return TypeValidity.True;
    }
    return TypeValidity.Unknown;
  }

  /**
   * Traverse an an array according to the specified schema, returning
   * a new array that includes the elements that matched the schema.
   *
   * We are passed a doc that has been read with the nonRecursive flag.
   *
   * @param doc doc with address and value to traverse
   * @param schema schema that applies to this object
   * @param link optional link to pass to createObject callback
   * @returns the newly created array with entries or undefined if one of our
   *  elements failed to validate.
   */
  private traverseArrayWithSchema(
    doc: IMemorySpaceValueAttestation,
    schema: JSONSchemaObj,
    _link?: NormalizedFullLink,
  ): Immutable<FabricValue>[] | undefined {
    this.traverseArrayCalls++;
    const docArray = doc.value as Immutable<FabricDatum>[];
    const arrayObj = new Array<Immutable<FabricValue>>(docArray.length);

    // We use `every` here so if our input is a sparse array, so is our output.
    const valid = docArray.every((item, index) => {
      const itemSchema = this.cfc.schemaAtPath(schema, [index.toString()]);
      let curDoc: IMemorySpaceValueAttestation = {
        address: {
          ...doc.address,
          path: appendToPath(doc.address.path, index.toString()),
        },
        value: item,
      };
      this.tx.read(curDoc.address, READ_NON_RECURSIVE_FOR_SCHEDULING);
      let curSelector: SchemaPathSelector = {
        path: curDoc.address.path,
        schema: itemSchema,
      };
      // We follow the first link in array elements so we don't have
      // strangeness with setting item at 0 to item at 1. If the element on
      // the array is a link, we follow that link so the returned object is
      // the current item at that location (otherwise the link would refer to
      // "Nth element"). This is important when turning returned objects back
      // into cells: We want to then refer to the actual object by default,
      // not the array location.
      //
      // If the element is an object, but not a link, we create an immutable
      // cell to hold the object, except when it is requested as Cell. While
      // this means updates aren't propagated, it seems like the right trade-off
      // for stability of links and the ability to mutate them without creating
      // loops (see below).
      //
      // This makes
      // ```ts
      // const array = [...cell.get()];
      // array.splice(index, 1);
      // cell.set(array);
      // ```
      // work as expected. Handle boolean items values for element schema
      // let createdDataURI = false;
      // const maybeLink = parseLink(item, arrayLink);
      if (isPrimitiveCellLink(item)) {
        this.tx.read(curDoc.address, READ_FOR_SCHEDULING);
        const [redirDoc, selector] = this.getDocAtPath(
          curDoc,
          [],
          curSelector,
          "writeRedirect",
        );
        curDoc = redirDoc;
        curSelector = selector!;
        // call to nextLink will mark curDoc read recursively
        // redirDoc has only followed redirects.
        // If our redirDoc is a link, resolve one step, and use that value instead
        // because arrays dereference one more link.
        const [linkDoc, linkSelector] = this.nextLink(redirDoc, curSelector);
        curDoc = linkDoc;
        curSelector = linkSelector!;
        this.tx.read(curDoc.address, READ_NON_RECURSIVE_FOR_SCHEDULING);
        if (curDoc.value === undefined) {
          logger.info(
            "traverse",
            () => ["Value is undefined following array element link", curDoc],
          );
        }
      } else if (
        isRecord(item) &&
        !SchemaObjectTraverser.asCellOrStream(curSelector.schema)
      ) {
        // We create an element link, but this is just to establish the id if we encounter
        // other links in our data value and we need to construct a relative link.
        const elementLink = getNormalizedLink(
          curDoc.address,
          curSelector.schema,
        );
        // Replace doc with a DataCellURI style doc
        // Need to read recursively here
        this.tx.read(curDoc.address, READ_FOR_SCHEDULING);
        // TODO(@ubik2): ideally, we wouldn't use this path in query traversal.
        // Right now, we aren't passing both the link info and doc info, so we
        // will override the doc here.
        // I could switch based off the traverseCells flag (true for queries),
        // but I don't want to have that change behavior here.
        curDoc = {
          ...curDoc,
          address: {
            ...curDoc.address,
            id: createDataCellURI(curDoc.value, elementLink),
            path: ["value"],
          },
        };
        // Our selector's path needs to be updated to match the new doc
        curSelector.path = curDoc.address.path;
      }
      // If we've asked for cells in the array and we don't need to traverse cells,
      // add the created cell instead. We check asCellOrStream regardless of
      // whether the value is a link — inline objects should also become cells
      // when the schema says asCell, to avoid reading nested data on the
      // parent's reactive transaction.
      if (
        !this.traverseCells &&
        SchemaObjectTraverser.asCellOrStream(curSelector.schema)
      ) {
        if (curDoc.value === undefined) {
          // If we hit a broken link following write redirects, I think we have
          // to abort.
          logger.info(
            "traverse",
            () => ["Encountered broken redirect", doc, curDoc],
          );
          return false;
        }
        // For my cell link, curDoc currently points to the last
        // redirect target, but we want cell properties to be based on the
        // link value at that location, so we effectively follow one more
        // link if available.
        // If we have a value instead of a link, create a link to the element
        // We don't traverse and validate, since this is an asCell boundary.
        const isLink = isPrimitiveCellLink(curDoc.value);
        if (isLink) this.tx.read(curDoc.address, READ_FOR_SCHEDULING);
        const cellLink = isLink
          ? getNextCellLink(curDoc, curSelector.schema!)
          : getNormalizedLink(curDoc.address, curSelector.schema);
        const val = this.objectCreator.createObject(cellLink, undefined);
        arrayObj[index] = val;
      } else {
        // We want those links to point directly at the linked cells, instead
        // of using our path (e.g. ["items", "0"]), so don't pass in a
        // modified link.
        const { ok: val, error } = this.traverseWithSelector(
          curDoc,
          curSelector,
        );
        if (error !== undefined) {
          // If our item doesn't match our schema, we may be able to use
          // undefined or null if those are valid according to our schema.
          if (this.isValidType(curSelector.schema!, "undefined")) {
            arrayObj[index] = undefined;
          } else if (this.isValidType(curSelector.schema!, "null")) {
            arrayObj[index] = null;
          } else {
            // this array is invalid; one or more items do not match the schema
            logger.info(
              "traverse",
              () => ["Item doesn't match array schema", curDoc, curSelector],
            );
            return undefined;
          }
        } else {
          arrayObj[index] = val;
        }
      }
      return true;
    });
    return valid ? arrayObj : undefined;
  }

  /**
   * Traverse an object according to the specified schema, returning
   * a new object that only includes the properties that matched the schema.
   *
   * When properties are specified in the schema, and additionalProperties
   * is not specified, properties not in the schema are not traversed, but
   * the objectCreator can control whether these optional properties are
   * included.
   *
   * When properties are not specified in the schema, and additionalProperties
   * is not specified, we have the standard JSONSchema behavior, where this is
   * equivalent to additionalProperties of true.
   *
   * @param doc doc with address and value to traverse
   * @param schema schema that applies to this object
   * @param link optional link to pass to createObject callback
   * @returns An object with only the properties that matched the schema
   */
  private traverseObjectWithSchema(
    doc: IMemorySpaceValueAttestation,
    schema: JSONSchemaObj,
    _link?: NormalizedFullLink,
  ): Record<string, Immutable<FabricValue>> | undefined {
    this.traverseObjectCalls++;
    const filteredObj: Record<string, Immutable<FabricValue>> = {};
    for (const [propKey, propValue] of Object.entries(doc.value!)) {
      // We'll use marker schemas to detect some places where we want special
      // schema behavior
      const propSchema = this.cfc.schemaAtPath(
        schema,
        [propKey],
        undefined,
        { $comment: "emptyProperties" },
        { $comment: "missingProperty" },
      );
      // Normally, if additionalProperties is not specified, it would
      // default to true. However, if we provided the `properties` field, we
      // treat this specially, and don't invalidate the object, but also don't
      // descend down into that property.
      // This behavior is delegated to the objectCreator, so we can have
      // different handling in cell.get (validateAndTransform) and query.
      // cell.get will ignore these properties, while the query system will
      // include their raw value (and will not follow links).
      if (
        isRecord(propSchema) && (
          propSchema.$comment === "emptyProperties" ||
          propSchema.$comment === "missingProperty"
        )
      ) {
        this.objectCreator.addOptionalProperty(filteredObj, propKey, propValue);
        continue;
      }
      const propAddress = {
        ...doc.address,
        path: appendToPath(doc.address.path, propKey),
      };
      // If we have a link, the traverseWithSchema will handle that for us.
      // If we have a value, we instead need to handle it ourselves
      if (
        !this.traverseCells &&
        SchemaObjectTraverser.asCellOrStream(propSchema) &&
        !isPrimitiveCellLink(propValue)
      ) {
        // Intentionally treat asCell/asStream as an opaque boundary in
        // traverseCells=false mode for inline object values. We create a cell
        // link and do not descend/read nested properties from this value here.
        // If we have a value instead of a link, create a link to the value
        // We don't traverse and validate, since this is an asCell boundary.
        const cellLink = getNormalizedLink(propAddress, propSchema);
        const val = this.objectCreator.createObject(cellLink, undefined);
        filteredObj[propKey] = val;
      } else {
        const propDoc = { address: propAddress, value: propValue };
        this.tx.read(propDoc.address, READ_NON_RECURSIVE_FOR_SCHEDULING);
        const { ok: val, error } = this.traverseWithSchema(propDoc, propSchema);
        if (error === undefined) {
          filteredObj[propKey] = val;
        }
      }
    }

    // Apply defaults from our schema
    if (isRecord(schema) && schema.properties) {
      for (const propKey of Object.keys(schema.properties)) {
        if (propKey in filteredObj) {
          continue;
        }
        const subSchema = this.cfc.getSchemaAtPath(schema, [propKey]);
        if (!isRecord(subSchema)) {
          continue;
        }
        const propSchema = ContextualFlowControl.resolveSchemaRefs(subSchema);
        if (!isRecord(propSchema) || propSchema.default == undefined) {
          continue;
        }
        const propAddress = {
          ...doc.address,
          path: appendToPath(doc.address.path, propKey),
        };
        if (SchemaObjectTraverser.asCellOrStream(propSchema)) {
          const { ok: val, error } = this.traverseWithSchema({
            address: propAddress,
            value: undefined,
          }, propSchema);
          if (error === undefined) {
            logger.debug(
              "traverse",
              () => ["merging asCell/asStream default", propKey, val],
            );
            filteredObj[propKey] = val;
          }
        } else {
          const propLink = getNormalizedLink(propAddress, propSchema);
          const val = this.objectCreator.applyDefault(
            propLink,
            propSchema.default,
          );
          if (val !== undefined) {
            logger.debug(
              "traverse",
              () => ["merging schema default", propKey, val],
            );
            filteredObj[propKey] = val;
          }
        }
      }
    }

    // Check that all required fields are present
    if (isRecord(schema) && "required" in schema) {
      const required = schema["required"] as string[];
      if (Array.isArray(required)) {
        for (const requiredProperty of required) {
          if (!(requiredProperty in filteredObj)) {
            logger.info("traverse", () => [
              "Missing required property",
              requiredProperty,
              "in object",
              doc.address,
              doc.value,
              "with schema",
              schema,
            ]);
            return undefined;
          }
        }
      }
    }
    return filteredObj;
  }

  // This just has a schema, since the doc.address.path should match the
  // selector.path.
  // The doc.value should be a primitive cell link, and we've already
  // done a nonRecursive read on it.
  private traversePointerWithSchema(
    doc: IMemorySpaceValueAttestation,
    schema: JSONSchema,
    link?: NormalizedFullLink,
  ): TraverseResult<Immutable<FabricValue>> {
    this.traversePointerCalls++;
    const selector = { path: doc.address.path, schema };
    const [redirDoc, redirSelector] = this.getDocAtPath(
      doc,
      [],
      selector,
      "writeRedirect",
    );
    if (redirDoc.value === undefined) {
      // This may be ok, but log it anyhow
      logger.info(
        "traversePointerWithSchema",
        () => [
          "Encountered link to undefined value",
          doc,
          redirDoc,
        ],
      );
      if (
        redirSelector?.schema === undefined ||
        SchemaObjectTraverser.asCellOrStream(redirSelector.schema)
      ) {
        // If we don't have a schema, we don't allow undefined
        // If we have a schema with asCell, we can't create a cell for this,
        // since we can't follow all the write-redirect links.
        return { error: new Error("Encountered link to undefined value") };
      } else {
        return this.isValidType(redirSelector.schema, "undefined")
          ? { ok: this.traversePrimitive(redirDoc, redirSelector.schema) }
          : { error: new Error("Encountered link to undefined value") };
      }
    }
    // For the runtime, where we don't traverse cells, we just want
    // to create a cell object and don't walk into the object beyond
    // what we need to resolve the pointers.
    // For the memory system, where we do traverse cells, we will
    // still walk into these objects regardless of the schema flag,
    // since we still need to get the connected objects.
    if (
      !this.traverseCells &&
      SchemaObjectTraverser.asCellOrStream(schema)
    ) {
      const combinedSchema = combineOptionalSchema(
        schema,
        redirSelector?.schema,
      )!;
      // For my cell link, redirDoc currently points to the last redirect
      // target, but we want cell properties to be based on the link value at
      // that location, so we effectively follow one more link if available.
      if (isPrimitiveCellLink(redirDoc.value)) {
        this.tx.read(redirDoc.address, READ_FOR_SCHEDULING);
      }
      const cellLink = getNextCellLink(redirDoc, combinedSchema);
      logger.debug(
        "traverse",
        () => ["Next cell link:", {
          cellLink,
          redirDoc,
          combinedSchema,
        }],
      );
      return { ok: this.objectCreator.createObject(cellLink, undefined) };
    }

    // our link should point to the target of the last redirect
    link = getNormalizedLink(redirDoc.address, schema);
    const [newDoc, newSelector] = this.getDocAtPath(
      redirDoc,
      [],
      redirSelector,
    );
    return this.traverseWithSelector(newDoc, newSelector!, link);
  }

  private traversePrimitive(
    doc: IMemorySpaceValueAttestation,
    schema: JSONSchema,
  ): Immutable<FabricValue> {
    if (SchemaObjectTraverser.asCellOrStream(schema)) {
      return this.objectCreator.createObject(
        getNormalizedLink(doc.address, schema),
        doc.value,
      );
    } else {
      return doc.value;
    }
  }

  /**
   * Check whether the schema specifies asCell or asStream
   *
   * This handling gets a little blurry with anyOf or oneOf schemas, and
   * in those cases, we base the value on whether every option has the flag.
   *
   * A future improvement is to operate on pre-processed schemas, where the
   * asCell and asStream flags are factored out when possible.
   *
   * We do not resolve references in the anyOf or oneOf options, which means
   * we don't need to worry about cycles, but it also means we may miss some
   * references that should be asCell or asStream.
   *
   * @param schema
   * @returns
   */
  static asCellOrStream(schema: JSONSchema | undefined): boolean {
    if (schema === undefined || typeof schema === "boolean") {
      return false;
    }
    if (
      schema.asCell || schema.asStream ||
      (Array.isArray(schema.anyOf) &&
        schema.anyOf.every((option) =>
          SchemaObjectTraverser.asCellOrStream(option)
        )) ||
      (Array.isArray(schema.oneOf) &&
        schema.oneOf.every((option) =>
          SchemaObjectTraverser.asCellOrStream(option)
        ))
    ) {
      return true;
    }
    return false;
  }

  private applyDefault(
    doc: IMemorySpaceValueAttestation,
    schema: JSONSchema,
  ): FabricDatum | undefined {
    if (isRecord(schema) && schema.default !== undefined) {
      const link = getNormalizedLink(doc.address, schema);
      return this.objectCreator.applyDefault(link, schema.default);
    }
    return undefined;
  }

  private getDebugValue(doc: IMemorySpaceValueAttestation) {
    if (doc.value === undefined) {
      return "undefined";
    }
    return JSON.stringify(
      this.traverseWithSelector(doc, {
        path: doc.address.path,
        schema: true,
      }),
      getCircularReplacer(),
      2,
    );
  }
}

/**
 * When we have anyOf/allOf/oneOf schemas, the outer portion may contain some
 * of our shared information, while the inner portion contains other parts.
 *
 * This combines the two while also handling potential boolean innerSchema.
 *
 * @param outerSchema
 * @param innerSchema
 */
function mergeSchemaOption(
  outerSchema: JSONSchemaObj,
  innerSchema: JSONSchema,
) {
  // TODO(@ubik2): There are situations where this merge doesn't do what the
  // JSONSchema rules should.
  // For example, `{type: "object", anyOf: [{type: "string"}]}` schema should
  // never match
  const key = hashSchema(outerSchema) + "|" + hashSchema(innerSchema);
  const cached = _mergeSchemaOptionCache.get(key);
  if (cached !== undefined) return cached;
  const result = isRecord(innerSchema)
    ? { ...outerSchema, ...innerSchema }
    : innerSchema
    ? outerSchema // innerSchema === true
    : false; // innerSchema === false
  internSet(_mergeSchemaOptionCache, key, result as JSONSchema);
  return result;
}

/**
 * Cheap pre-check: can this anyOf branch possibly match the given value?
 * Returns `true` (don't reject) when uncertain — conservative by design.
 * Never rejects asCell/asStream branches since they represent cell boundaries.
 *
 * Checks performed (all on the top-level resolved branch):
 * - Type mismatch: branch.type vs actual JS type of value
 * - Missing required properties
 *
 * Const/enum checks are intentionally omitted: property values may contain
 * unresolved links that would match after link resolution during traversal.
 */
export function canBranchMatch(
  branch: JSONSchema,
  value: unknown,
): boolean {
  // Boolean schemas: true matches everything, false matches nothing
  if (typeof branch === "boolean") return branch;

  // Never reject asCell/asStream branches
  if (branch.asCell || branch.asStream) return true;

  // If the value is an object that could be a link/pointer, bail out entirely.
  // Links are dereferenced during traversal, so the current shape of the value
  // tells us nothing about the resolved type or properties.
  if (isPrimitiveCellLink(value)) return true;

  let resolved: JSONSchema | undefined = branch;
  if ("$ref" in branch) {
    resolved = ContextualFlowControl.resolveSchemaRefs(branch);
    if (typeof resolved === "boolean") return resolved;
    else if (resolved === undefined) return true; // we'll properly complain later
  }

  // Type mismatch check — only safe for non-link primitive values and
  // plain record objects / arrays
  if (resolved.type !== undefined) {
    const actualType = getJsonType(value);
    if (actualType !== null) {
      const schemaTypes = Array.isArray(resolved.type)
        ? resolved.type
        : [resolved.type];
      if (!schemaTypes.includes(actualType)) return false;
    }
  }

  // For plain object values, check missing required properties.
  // Const/enum checks are omitted — property values may contain unresolved
  // links that would match after link resolution during traversal.
  if (isRecord(value)) {
    const typeIncludesObject = resolved.type === undefined ||
      resolved.type === "object" ||
      (Array.isArray(resolved.type) && resolved.type.includes("object"));
    if (typeIncludesObject && Array.isArray(resolved.required)) {
      for (const req of resolved.required) {
        if (!(req as string in value)) return false;
      }
    }
  }

  return true;
}

/** Map JS typeof to JSON Schema type string, or null if unknown */
function getJsonType(
  value: unknown,
): string | null {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (isString(value)) return "string";
  if (isFiniteNumber(value)) return "number";
  if (isBoolean(value)) return "boolean";
  if (Array.isArray(value)) return "array";
  if (isObject(value)) return "object";
  return null;
}

/**
 * Merge multiple anyOf object branches into a single object schema.
 * Instead of traversing each branch independently, this produces ONE merged
 * schema where:
 * - Properties that appear in all branches with identical schemas → used directly
 * - Properties that differ across branches → wrapped in { anyOf: [s1, s2, ...] }
 * - `required`: intersection (only required if ALL branches require it)
 * - `additionalProperties`: union (allow if ANY branch allows)
 * - `$defs`: merged from all branches
 *
 * Returns null when merging isn't applicable (non-object branches, boolean schemas,
 * or fewer than 2 branches).
 */
export function mergeAnyOfBranchSchemas(
  branches: JSONSchema[],
  outerSchema: JSONSchemaObj,
): JSONSchema | null {
  if (branches.length < 2) return null;

  const key = hashSchema(outerSchema) + "||" +
    branches.map(hashSchema).join("|");
  const cached = _mergeAnyOfBranchCache.get(key);
  if (cached !== undefined) return cached;

  const result = _mergeAnyOfBranchSchemasUncached(branches, outerSchema);
  const frozen = result !== null ? toDeepFrozenSchema(result, true) : null;
  if (_mergeAnyOfBranchCache.size >= INTERN_CACHE_MAX) {
    _mergeAnyOfBranchCache.clear();
  }
  _mergeAnyOfBranchCache.set(key, frozen);
  return frozen;
}

function _mergeAnyOfBranchSchemasUncached(
  branches: JSONSchema[],
  outerSchema: JSONSchemaObj,
): JSONSchema | null {
  // Resolve and merge each branch with the outer schema, then check they're all objects
  const resolvedBranches: JSONSchemaObj[] = [];
  for (const branch of branches) {
    const merged = mergeSchemaOption(outerSchema, branch);
    if (!isRecord(merged)) return null;
    // Must be object type or unspecified (compatible with object)
    // type can be a string or an array of strings
    if (merged.type !== undefined) {
      const types = Array.isArray(merged.type) ? merged.type : [merged.type];
      if (!types.includes("object")) return null;
    }
    resolvedBranches.push(merged);
  }

  // Collect all property schemas from all branches, keyed by property name
  const allProps = new Map<string, JSONSchema[]>();
  const allRequiredSets: Set<string>[] = [];
  let mergedDefs: Record<string, JSONSchema> | undefined;
  let anyAllowsAdditional = false;

  for (const branch of resolvedBranches) {
    // Collect properties
    if (isRecord(branch.properties)) {
      for (const [k, v] of Object.entries(branch.properties)) {
        let arr = allProps.get(k);
        if (!arr) {
          arr = [];
          allProps.set(k, arr);
        }
        arr.push(v as JSONSchema);
      }
    }

    // Collect required sets
    if (Array.isArray(branch.required)) {
      allRequiredSets.push(new Set(branch.required as string[]));
    } else {
      allRequiredSets.push(new Set());
    }

    // Merge $defs
    if (isRecord(branch.$defs)) {
      mergedDefs ??= {};
      Object.assign(mergedDefs, branch.$defs);
    }

    // additionalProperties: union
    if (
      branch.additionalProperties === undefined ||
      branch.additionalProperties === true ||
      (isRecord(branch.additionalProperties))
    ) {
      anyAllowsAdditional = true;
    }
  }

  // If no branches have properties, merging isn't useful
  if (allProps.size === 0) return null;

  // Build merged properties
  const mergedProperties: Record<string, JSONSchema> = {};
  for (const [propKey, schemas] of allProps) {
    // Deduplicate schemas using hashSchema
    const uniqueHashes = new Map<string, JSONSchema>();
    for (const s of schemas) {
      uniqueHashes.set(hashSchema(s), s);
    }
    if (uniqueHashes.size === 1) {
      // All branches agree on this property's schema
      mergedProperties[propKey] = schemas[0];
    } else {
      // Different schemas across branches — wrap in anyOf
      mergedProperties[propKey] = { anyOf: [...uniqueHashes.values()] };
    }
  }

  // Required: intersection — only required if ALL branches require it
  const requiredSet = new Set<string>();
  if (allRequiredSets.length > 0) {
    for (const r of allRequiredSets[0]) {
      if (allRequiredSets.every((s) => s.has(r))) {
        requiredSet.add(r);
      }
    }
  }

  return {
    type: "object",
    properties: mergedProperties,
    ...(requiredSet.size > 0 && { required: [...requiredSet] }),
    ...(!anyAllowsAdditional && { additionalProperties: false }),
    ...(mergedDefs && { $defs: mergedDefs }),
    ...(outerSchema.asCell && { asCell: true }),
    ...(outerSchema.asStream && { asStream: true }),
  } as JSONSchemaObj;
}

// Utility function used for debugging so we can convert proxy objects into
// regular objects when there's circular references.
function getCircularReplacer() {
  const ancestors: object[] = [];
  return function (_key: string, value: any) {
    if (typeof value !== "object" || value === null) {
      return value;
    }
    // Check if the value has been seen before in the current ancestry path
    if (ancestors.includes(value)) {
      return "[Circular]"; // Replace cyclic reference with a string
    }
    ancestors.push(value);
    return value;
  };
}

/**
 * Get the link for a cell reached by following one link if available.
 * If doc.value does not contain a link, the cell will point to doc.address.
 *
 * @param doc - IAttestation for the location of the link
 * @param schema - JSONSchema for the item
 *
 * @returns a normalized full link which will have the address and schema
 *   information that we should use for the cell.
 */
function getNextCellLink(
  doc: IMemorySpaceValueAttestation,
  schema: JSONSchema,
): NormalizedFullLink {
  // For my cell link, itemLink currently points to the last redirect
  // target, but we want cell properties to be based on the link value at
  // that location, so we effectively follow one more link if available.
  const lastLink = parseLink(doc.value, doc.address);
  if (lastLink !== undefined) {
    // The link may not have the asCell flags, so pull that from itemSchema
    return {
      ...lastLink,
      schema: combineSchema(schema, lastLink.schema ?? true),
    };
  }
  // It's fine if we don't have a pointer. In that case, just use the doc
  // address. If I have asCell in the schema, but a plain value, we want
  // the cell to wrap that value at its current location.
  logger.debug("traverse", [
    "getNextCellLink with non-link doc value",
    doc.value,
  ]);
  return getNormalizedLink(doc.address, schema);
}

// helper function - since path starts with value, the new array will too
function appendToPath(path: ValuePath, part: string): ValuePath {
  return [...path, part] as ValuePath;
}

// helper function - since path starts with value, the new array will too
function appendPartsToPath(path: ValuePath, parts: string[]): ValuePath {
  return [...path, ...parts] as ValuePath;
}
