import { refer } from "@commontools/memory/reference";
import { MIME } from "@commontools/memory/interface";
import type { JSONSchemaObj } from "@commontools/api";
import type {
  JSONValue,
  MemorySpace,
  Result,
  SchemaPathSelector,
  StorableDatum,
  StorableValue,
  Unit,
} from "@commontools/memory/interface";
import { deepEqual } from "@commontools/utils/deep-equal";
import { isArrayIndexPropertyName } from "@commontools/memory/storable-value";
// TODO(@ubik2): Ideally this would import from "@commontools/utils/types",
// but rollup has issues
import {
  type Immutable,
  isBoolean,
  isNumber,
  isObject,
  isRecord,
  isString,
} from "../../utils/src/types.ts";
import { getLogger } from "../../utils/src/logger.ts";
import { ContextualFlowControl } from "./cfc.ts";
import type { JSONObject, JSONSchema } from "./builder/types.ts";
import {
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

export type { IAttestation, IMemoryAddress } from "./storage/interface.ts";
export type { SchemaPathSelector };

// An IAttestation where the address is an IMemorySpaceAddress
interface IMemorySpaceAttestation {
  readonly address: IMemorySpaceAddress;
  readonly value?: StorableDatum;
}
/**
 * A data structure that maps keys to sets of values, allowing multiple values
 * to be associated with a single key without duplication.
 *
 * While the default behavior is to use object equality, you can provide an
 * `equalFn` parameter to the constructor, which will be used for the value
 * comparisons.
 *
 * @template K The type of keys in the map
 * @template V The type of values stored in the sets
 */
export class MapSet<K, V> {
  private map = new Map<K, Set<V>>();
  private equalFn?: (a: V, b: V) => boolean;

  constructor(equalFn?: (a: V, b: V) => boolean) {
    this.equalFn = equalFn;
  }

  public get(key: K): Set<V> | undefined {
    return this.map.get(key);
  }

  public add(key: K, value: V) {
    const values = this.map.get(key);
    if (values === undefined) {
      const values = new Set<V>([value]);
      this.map.set(key, values);
    } else if (
      this.equalFn !== undefined &&
      (values.values().some((item) => this.equalFn!(item, value)))
    ) {
      return;
    } else {
      this.map.get(key)!.add(value);
    }
  }

  public has(key: K): boolean {
    return this.map.has(key);
  }

  public hasValue(key: K, value: V): boolean {
    const values = this.map.get(key);
    if (values !== undefined && this.equalFn !== undefined) {
      return values.values().some((item) => this.equalFn!(item, value));
    }
    return values !== undefined && values.has(value);
  }

  public deleteValue(key: K, value: V): boolean {
    if (!this.map.has(key)) {
      return false;
    } else {
      const values = this.map.get(key)!;
      let existing: V = value;
      if (values.has(value)) {
        // Short cut via object identity
        existing = value;
      } else if (this.equalFn !== undefined) {
        const match = values.values().find((item) =>
          this.equalFn!(item, value)
        );
        if (match === undefined) {
          return false;
        }
        existing = match;
      }
      const rv = values.delete(existing);
      if (values.size === 0) {
        this.map.delete(key);
      }
      return rv;
    }
  }

  public delete(key: K) {
    this.map.delete(key);
  }
  /**
   * iterable
   */
  *[Symbol.iterator](): IterableIterator<[K, Set<V>]> {
    for (const [key, values] of this.map) {
      yield [key, values];
    }
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
export class CompoundCycleTracker<EqualKey, DeepEqualKey, Value = unknown> {
  private partial: Map<EqualKey, [DeepEqualKey, Value?][]>;
  constructor() {
    this.partial = new Map<EqualKey, [DeepEqualKey, Value?][]>();
  }

  /**
   * This will do an identity check on the `partialKey` and a deepEqual check on
   * the `extraKey`.
   */
  include(
    partialKey: EqualKey,
    extraKey: DeepEqualKey,
    value?: Value,
    context?: unknown,
  ): Disposable | null {
    let existing = this.partial.get(partialKey);
    if (existing === undefined) {
      existing = [];
      this.partial.set(partialKey, existing);
    }
    if (existing.some(([item, _value]) => deepEqual(item, extraKey))) {
      return null;
    }
    existing.push([extraKey, value]);
    return {
      [Symbol.dispose]: () => {
        const entries = this.partial.get(partialKey)!;
        const index = entries.findIndex(([item, _value]) =>
          deepEqual(item, extraKey)
        );
        if (index === -1) {
          logger.error("traverse-error", () => [
            "Failed to dispose of missing key",
            extraKey,
            context,
          ]);
          return;
        }
        if (entries.length === 0) {
          this.partial.delete(partialKey);
        } else {
          entries.splice(index, 1);
        }
      },
    };
  }

  // After a failed include (that returns null), we can use getExisting to find the registered value
  getExisting(partialKey: EqualKey, extraKey: DeepEqualKey): Value | undefined {
    const existing = this.partial.get(partialKey);
    if (existing === undefined) {
      return undefined; // no match for partialKey
    }
    const match = existing.find(([item, _value]) => deepEqual(item, extraKey));
    if (match === undefined) {
      return undefined; // no match for extraKey
    }
    const [_key, value] = match;
    return value;
  }
}

export type PointerCycleTracker = CompoundCycleTracker<
  Immutable<JSONValue>,
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
 * This is a read-only transaction, and is only used by the traverse code.
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
    _options?: IReadOptions,
  ): Result<IAttestation, ReadError> {
    const source = this.manager.load(address) ??
      { address: { ...address, path: [] } };
    return resolve(source, address);
  }
  writer(_space: MemorySpace): Result<ITransactionWriter, WriterError> {
    throw new Error("Method not implemented.");
  }
  write(
    _address: IMemorySpaceAddress,
    _value?: JSONValue,
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

export type OptJSONValue =
  | undefined
  | JSONValue
  | OptJSONArray
  | OptJSONObject;
interface OptJSONArray extends Array<OptJSONValue> {}
interface OptJSONObject {
  [key: string]: OptJSONValue;
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
class StandardObjectCreator implements IObjectCreator<StorableDatum> {
  mergeMatches(
    matches: StorableDatum[],
    _schema?: JSONSchema,
  ): StorableDatum | undefined {
    // These value objects should be merged. While this isn't JSONSchema
    // spec, when we have an anyOf with branches where name is set in one
    // schema, but the address is ignored, and a second option where
    // address is set, and name is ignored, we want to include both.
    return mergeAnyOfMatches(matches);
  }

  addOptionalProperty(
    obj: Record<string, unknown>,
    key: string,
    value: StorableDatum,
  ) {
    // It's fine to include this non-matching data, since we're not returning
    // the final object to a user. This lets us see the contents better if we
    // need to debug things.
    obj[key] = value;
  }
  applyDefault(
    _link: NormalizedFullLink,
    defaultValue: StorableDatum | undefined,
  ): StorableDatum | undefined {
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
    value: StorableDatum | undefined,
  ): StorableDatum {
    return value === undefined ? null : value;
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
  address: IMemorySpaceAddress,
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
      Immutable<JSONValue>,
      JSONSchema | undefined
    >(),
    protected schemaTracker: MapSet<string, SchemaPathSelector> = new MapSet<
      string,
      SchemaPathSelector
    >(deepEqual),
    protected cfc: ContextualFlowControl = new ContextualFlowControl(),
    public objectCreator: IObjectCreator<StorableDatum> =
      new StandardObjectCreator(),
    protected traverseCells = true,
  ) {}
  abstract traverse(doc: IMemorySpaceAttestation): Immutable<StorableValue>;
  /**
   * Attempt to traverse the document as a directed acyclic graph.
   * This is the simplest form of traversal, where we include everything.
   * If the doc's value is undefined, this will return undefined (or
   * defaultValue if provided).
   * Otherwise, it will return the fully traversed object.
   * If a cycle is detected, it will not traverse the cyclic element
   *
   * @param doc
   * @param defaultValue optional default value
   * @param itemLink optinal item link to use when creating links
   * @returns
   */
  protected traverseDAG(
    doc: IMemorySpaceAttestation,
    defaultValue?: JSONValue,
    itemLink?: NormalizedFullLink,
  ): Immutable<StorableValue> {
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
      const newValue: StorableDatum[] = [];
      using t = this.tracker.include(doc.value, true, newValue, doc);
      if (t === null) {
        return this.tracker.getExisting(doc.value, true);
      }
      const entries = doc.value.map((item, index) => {
        const itemDefault =
          isObject(defaultValue) && Array.isArray(defaultValue) &&
            index < defaultValue.length
            ? defaultValue[index]
            : undefined;
        let docItem: IMemorySpaceAttestation = {
          address: {
            ...doc.address,
            path: [...doc.address.path, index.toString()],
          },
          value: item,
        };
        // We follow the first link in array elements so we don't have
        // strangeness with setting item at 0 to item at 1
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
          itemLink = getNormalizedLink(
            linkDoc.value !== undefined ? linkDoc.address : redirDoc.address,
          );
          // We can follow all the links, since we don't need to track cells
          const [valueDoc, _] = this.getDocAtPath(linkDoc, [], DefaultSelector);
          docItem = valueDoc;
          if (docItem.value === undefined) {
            logger.debug(
              "traverse",
              () => ["getAtPath returned undefined value for array entry", doc],
            );
          }
        }
        return this.traverseDAG(docItem, itemDefault, itemLink);
      });
      // We copy the contents of our result into newValue so that if we have a
      // cycle, we can return newValue before we actually finish populating it.
      for (const v of entries) {
        // Use null for missing/undefined elements (consistent with other value
        // transforms in this system, e.g. toJSON and toStorableValue)
        newValue.push(v === undefined ? null : v as StorableDatum);
      }
      // Our link is based on the last link in the chain and not the first.
      const newLink = getNormalizedLink(doc.address, true);
      return this.objectCreator.createObject(newLink, newValue);
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
        return this.traverseDAG(valueDoc, defaultValue, itemLink);
      } else {
        const newValue: Record<string, any> = {};
        using t = this.tracker.include(doc.value, true, newValue, doc);
        if (t === null) {
          return this.tracker.getExisting(doc.value, true);
        }
        const entries = Object.entries(doc.value as JSONObject).map((
          [k, v],
        ) => {
          const itemDoc = {
            address: { ...doc.address, path: [...doc.address.path, k] },
            value: v,
          };
          const val = this.traverseDAG(
            itemDoc,
            isObject(defaultValue) && !Array.isArray(defaultValue)
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
        return this.objectCreator.createObject(newLink, newValue);
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
    doc: IMemorySpaceAttestation,
    path: readonly string[],
    selector?: SchemaPathSelector,
    lastNode: LastNode = "value",
  ) {
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
   * @param doc
   * @param selector
   * @returns
   */
  protected nextLink(
    doc: IMemorySpaceAttestation,
    selector?: SchemaPathSelector,
  ): [IMemorySpaceAttestation, SchemaPathSelector | undefined] {
    const link = parseLink(doc.value, doc.address);
    if (link !== undefined) {
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
    }
    return [doc, selector];
  }
}

/**
 * Traverses a data structure following a path and resolves any pointers.
 * If we load any additional documents, we will also let the helper know.
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
  doc: IMemorySpaceAttestation,
  path: readonly string[],
  tracker: PointerCycleTracker,
  cfc: ContextualFlowControl,
  schemaTracker: MapSet<string, SchemaPathSelector>,
  selector?: SchemaPathSelector,
  includeSource?: boolean,
  lastNode: LastNode = "value",
): [
  IMemorySpaceAttestation,
  SchemaPathSelector | undefined,
] {
  let curDoc = doc;
  let remaining = [...path];

  while (true) {
    if (isPrimitiveCellLink(curDoc.value)) {
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
          address: { ...curDoc.address, path: [...curDoc.address.path, part] },
          value: curDoc.value.length,
        };
      } else {
        curDoc = {
          ...curDoc,
          address: { ...curDoc.address, path: [...curDoc.address.path, part] },
          value: elementAt(curDoc.value, part),
        };
      }
    } else if (
      isObject(curDoc.value) && part in (curDoc.value as Immutable<JSONObject>)
    ) {
      const cursorObj = curDoc.value as Immutable<JSONObject>;
      curDoc = {
        ...curDoc,
        address: { ...curDoc.address, path: [...curDoc.address.path, part] },
        value: cursorObj[part] as Immutable<JSONValue>,
      };
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
          path: [...curDoc.address.path, ...missing],
        },
        value: undefined,
      };
      return [curDoc, selector];
    }
  }
}

function notFound(address: IMemorySpaceAddress): IMemorySpaceAttestation {
  return {
    address: { ...address, path: [] },
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
 * This method works with `getAtPath`, with the link management and document
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
  doc: IMemorySpaceAttestation,
  path: readonly string[],
  tracker: PointerCycleTracker,
  cfc: ContextualFlowControl,
  schemaTracker: MapSet<string, SchemaPathSelector>,
  selector?: SchemaPathSelector,
  includeSource?: boolean,
  lastNode?: LastNode,
): [
  IMemorySpaceAttestation,
  SchemaPathSelector | undefined,
] {
  // doc.address's path doesn't have the same value nesting semantics as
  // link path, but we don't use the path field from that argument.
  const link = parseLink(doc.value, doc.address)!;
  // We may access portions of the doc outside what we have in our doc
  // attestation, so set the target to the top level doc from the manager.
  const target: IMemorySpaceAddress = {
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
  const { ok: valueEntry, error } = tx.read(target);

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
      ? error.path
      : valueEntry.address.path;
    if (valueEntry === undefined || valueEntry.value === undefined) {
      const lastExisting = lastPath.slice(0, -1);
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
  // Load the sources/recipes recursively unless we're a retracted fact.
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
// This will also load any recipes linked by the doc.
export function loadSource(
  tx: IExtendedStorageTransaction,
  valueEntry: IMemorySpaceAttestation,
  cycleCheck: Set<string> = new Set<string>(),
  schemaTracker: MapSet<string, SchemaPathSelector>,
) {
  loadLinkedRecipe(tx, valueEntry, schemaTracker);
  if (!isObject(valueEntry.value)) {
    return;
  }
  const targetObj = valueEntry.value as Immutable<JSONObject>;
  if (!(isObject(targetObj) || !("source" in targetObj))) {
    return;
  }
  // We also want to include the source cells
  const source = targetObj["source"];
  if (!isObject(source) || !("/" in source) || !isString(source["/"])) {
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
  if (isObject(flagSchema)) {
    // we want to preserve asCell and asStream -- if true, these will override
    // the value in the schema
    const { asCell, asStream } = flagSchema;
    if (asCell || asStream) {
      const mergedFlags: { asCell?: boolean; asStream?: boolean } = {};
      if (asCell || isObject(schema) && schema.asCell) {
        mergedFlags.asCell = true;
      }
      if (asStream || isObject(schema) && schema.asStream) {
        mergedFlags.asStream = true;
      }
      if (isObject(schema)) {
        return {
          ...schema,
          ...mergedFlags,
        };
      } else if (schema === true) {
        return mergedFlags;
      }
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
  if (ContextualFlowControl.isTrueSchema(parentSchema)) {
    return mergeSchemaFlags(parentSchema, linkSchema);
  } else if (ContextualFlowControl.isTrueSchema(linkSchema)) {
    return mergeSchemaFlags(linkSchema, parentSchema);
  } else if (
    (isObject(linkSchema) && linkSchema.type === "object") &&
    (isObject(parentSchema) && parentSchema.type === "object")
  ) {
    // If both schemas have required properties, only include those that are
    // in both lists
    const { required: parentRequired, $defs: parentDefs, ...parentSchemaRest } =
      parentSchema;
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
      const additionalProperties = linkSchema.additionalProperties !== undefined
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
  } else if (
    (isObject(linkSchema) && linkSchema.type === "array") &&
    (isObject(parentSchema) && parentSchema.type === "array")
  ) {
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
  } else if (isObject(linkSchema) && isObject(parentSchema)) {
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
  return linkSchema;
}

// Load the linked recipe from the doc ()
// We don't recurse, since that's not required for recipe links
function loadLinkedRecipe(
  tx: IExtendedStorageTransaction,
  valueEntry: IMemorySpaceAttestation,
  schemaTracker: MapSet<string, SchemaPathSelector>,
) {
  if (!isObject(valueEntry.value)) {
    return;
  }
  const targetObj = valueEntry.value as Immutable<JSONObject>;
  if (!(isObject(targetObj) || !("value" in targetObj))) {
    return;
  }
  // We also want to include the source cells
  const value = targetObj["value"];
  if (!isObject(value)) {
    return;
  }
  let address: IMemorySpaceAddress | undefined;
  // Check for a spell link first, since this is more efficient
  // Older recipes will only have a $TYPE
  if ("spell" in value && isPrimitiveCellLink(value["spell"])) {
    const link = parseLink(value["spell"], valueEntry.address)!;
    address = {
      space: link.space,
      id: link.id!,
      type: link.type! as MIME,
      path: [],
    };
  } else if ("$TYPE" in value && isString(value["$TYPE"])) {
    const recipeId = value["$TYPE"];
    const entityId = refer({ causal: { recipeId, type: "recipe" } });
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
  const { ok: entry, error } = tx.read(address);
  if (error) {
    return;
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
      return { path: [], schema: false };
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

export class SchemaObjectTraverser<V extends JSONValue>
  extends BaseObjectTraverser {
  constructor(
    tx: IExtendedStorageTransaction,
    selector: SchemaPathSelector = DefaultSelector,
    tracker: PointerCycleTracker = new CompoundCycleTracker<
      Immutable<JSONValue>,
      JSONSchema | undefined
    >(),
    schemaTracker: MapSet<string, SchemaPathSelector> = new MapSet<
      string,
      SchemaPathSelector
    >(deepEqual),
    cfc: ContextualFlowControl = new ContextualFlowControl(),
    objectCreator?: IObjectCreator<V>,
    traverseCells?: boolean,
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
  }

  override traverse(
    doc: IMemorySpaceAttestation,
    link?: NormalizedFullLink,
  ): Immutable<StorableValue> {
    this.schemaTracker.add(getTrackerKey(doc.address), this.selector);
    const rv = this.traverseWithSelector(doc, this.selector, link);
    if (rv === undefined) {
      // This helps track down mismatched schemas
      logger.debug("traverse", () => [
        "Call to traverse returned undefined",
        doc,
        JSON.stringify(this.selector?.schema, undefined, 2),
        this.getDebugValue(doc),
      ]);
    }
    return rv;
  }

  // Traverse the specified doc with the selector.
  // The selector should have been re-rooted if needed to be relative to the
  // specified doc. This generally means that its path starts with value.
  // The selector must have a valid (defined) schema
  // Once we've gotten the path of our doc to match the path of our selector,
  // we can call traverseWithSchema instead.
  traverseWithSelector(
    doc: IMemorySpaceAttestation,
    selector: SchemaPathSelector,
    link?: NormalizedFullLink,
  ): Immutable<StorableValue> {
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
      return undefined;
    } else { // valuePath length < selector.path.length
      const [nextDoc, nextSelector] = this.getDocAtPath(
        doc,
        selector.path.slice(docPath.length),
        selector,
        "writeRedirect",
      );
      if (nextDoc.value === undefined) {
        logger.debug("traverse", () => [
          "value is undefined",
          docPath,
          selector.path,
        ]);
        return undefined;
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
   * @param doc
   * @param schema
   * @param link optional top level link information that we may need to
   *  pass to the object creator later
   * @returns the traversed value, or undefined if the doc does not match
   *  the schema
   */
  traverseWithSchema(
    doc: IMemorySpaceAttestation,
    schema: JSONSchema,
    link?: NormalizedFullLink,
  ): Immutable<StorableValue> {
    // Track both the unresolved version of our schema (possibly with top
    // level $ref) and the resolved version.
    let resolved: JSONSchema | undefined = schema;
    if (isObject(schema) && "$ref" in schema) {
      // Handle any top-level $ref in the schema
      resolved = ContextualFlowControl.resolveSchemaRefs(schema);
      if (resolved === undefined) {
        logger.warn(
          "traverse",
          () => ["Failed to resolve schema ref", schema],
        );
        return undefined;
      }
    }
    if (isObject(resolved)) {
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
        const matches: Immutable<StorableValue>[] = [];
        for (const optionSchema of sortedAnyOf) {
          if (ContextualFlowControl.isFalseSchema(optionSchema)) {
            continue;
          }
          const mergedSchema = mergeSchemaOption(restSchema, optionSchema);
          // TODO(@ubik2): do i need to merge the link schema?
          const val = this.traverseWithSchema(doc, mergedSchema, link);
          if (val !== undefined) {
            // We may just have a cell match, so the first match is what we
            // will return, but in this case, we still want to evaluate with
            // all the schema options, so we know to include all the potential
            // docs needed.
            matches.push(val);
          }
        }
        const merged = this.objectCreator.mergeMatches(
          matches as StorableDatum[],
          resolved,
        );
        if (merged !== undefined) {
          return merged;
        }
        // None of the anyOf patterns matched
        logger.debug(
          "traverse",
          () => [
            "No matching anyOf",
            doc,
            sortedAnyOf,
            this.getDebugValue(doc),
          ],
        );
        return undefined;
      } else if (resolved.allOf) {
        let lastVal;
        const { allOf, ...restSchema } = resolved;
        for (const optionSchema of allOf) {
          if (ContextualFlowControl.isFalseSchema(optionSchema)) {
            logger.debug(
              "traverse",
              () => ["Encountered false in allOf", resolved],
            );
            return undefined;
          }
          const mergedSchema = mergeSchemaOption(restSchema, optionSchema);
          // TODO(@ubik2): do i need to merge the link schema?
          const val = this.traverseWithSchema(doc, mergedSchema, link);
          if (val !== undefined) {
            // FIXME(@ubik2): these value objects should be merged. While this
            // isn't JSONSchema spec, when we have an allOf with branches where
            // name is set in one schema, but the address is ignored, and a
            // second option where address is set, and name is ignored, we want
            // to include both.
            lastVal = val;
          } else {
            // One of the allOf patterns failed to match
            logger.debug(
              "traverse",
              () => ["Failed entry in allOf", doc, optionSchema, resolved],
            );
            return undefined;
          }
        }
        if (allOf.length > 0) {
          return lastVal;
        }
        // If we have allOf: [], just ignore it and continue
      }
    }
    if (
      ContextualFlowControl.isTrueSchema(resolved) &&
      !SchemaObjectTraverser.asCellOrStream(resolved)
    ) {
      const defaultValue = isObject(resolved) ? resolved["default"] : undefined;
      // A value of true or {} means we match anything
      // Resolve the rest of the doc, and return
      return this.traverseDAG(doc, defaultValue, link);
    } else if (
      ContextualFlowControl.isFalseSchema(resolved) &&
      !SchemaObjectTraverser.asCellOrStream(resolved)
    ) {
      // This value rejects all objects - just return
      return undefined;
    } else if (!isObject(resolved)) {
      logger.warn(
        "traverse",
        () => ["Invalid schema is not an object", resolved],
      );
      return undefined;
    }
    const schemaObj = resolved;
    if (doc.value === undefined) {
      // If we have a default, annotate it and return it
      // Otherwise, return undefined
      return this.applyDefault(doc, schema);
    } else if (doc.value === null) {
      return this.isValidType(schemaObj, "null")
        ? this.traversePrimitive(doc, schemaObj)
        : undefined;
    } else if (isString(doc.value)) {
      return this.isValidType(schemaObj, "string")
        ? this.traversePrimitive(doc, schemaObj)
        : undefined;
    } else if (isNumber(doc.value)) {
      return this.isValidType(schemaObj, "number")
        ? this.traversePrimitive(doc, schemaObj)
        : undefined;
    } else if (isBoolean(doc.value)) {
      return this.isValidType(schemaObj, "boolean")
        ? this.traversePrimitive(doc, schemaObj)
        : undefined;
    } else if (Array.isArray(doc.value)) {
      if (this.isValidType(schemaObj, "array")) {
        const newValue: any = [];
        // Our link is based on the last link in the chain and not the first.
        const newLink = link ?? getNormalizedLink(
          doc.address,
          schemaObj,
        );
        using t = this.tracker.include(doc.value, schema, newValue, doc);
        if (t === null) {
          // newValue will be converted to a createObject result by the
          // function that added it to the tracker, so don't do that here
          return this.tracker.getExisting(doc.value, schema);
        }
        const entries = this.traverseArrayWithSchema(doc, schemaObj, newLink);
        if (!Array.isArray(entries)) {
          return undefined;
        }
        for (const item of entries) {
          newValue.push(item);
        }
        return this.objectCreator.createObject(newLink, newValue);
      }
      return undefined;
    } else if (isObject(doc.value)) {
      if (isPrimitiveCellLink(doc.value)) {
        // When traversing a pointer, use the unresolved schema, so we have
        // the same values in the schema tracker.
        return this.traversePointerWithSchema(doc, schema, link);
      } else if (this.isValidType(schemaObj, "object")) {
        const newValue: Record<string, Immutable<StorableValue>> = {};
        // Our link is based on the last link in the chain and not the first.
        const newLink = link ?? getNormalizedLink(doc.address, schemaObj);
        using t = this.tracker.include(doc.value, schemaObj, newValue, doc);
        if (t === null) {
          // newValue will be converted to a createObject result by the
          // function that added it to the tracker, so don't do that here
          return this.tracker.getExisting(doc.value, schemaObj);
        }
        const entries = this.traverseObjectWithSchema(doc, schemaObj, newLink);
        if (entries === undefined || entries === null) {
          return undefined;
        }
        for (const [k, v] of Object.entries(entries)) {
          newValue[k] = v;
        }
        // TODO(@ubik2): We should be able to remove this cast when we make
        // our return types more correct (we can hold cells/functions).
        return this.objectCreator.createObject(
          newLink,
          newValue as StorableDatum,
        );
      }
    }
  }

  private isValidType(
    schema: JSONSchema,
    valueType: string,
  ): boolean {
    if (ContextualFlowControl.isTrueSchema(schema)) {
      return true;
    } else if (ContextualFlowControl.isFalseSchema(schema)) {
      return false;
    }
    const schemaObj = schema as JSONSchemaObj;
    // Check the top level type flag
    if ("type" in schemaObj) {
      if (Array.isArray(schemaObj["type"])) {
        if (!schemaObj["type"].includes(valueType)) {
          return false;
        }
      } else if (isString(schemaObj["type"])) {
        if (schemaObj["type"] !== valueType) {
          return false;
        }
      } else {
        // invalid schema type
        return false;
      }
    }
    if (schemaObj.allOf) {
      // Special limited allOf handling here
      for (const option of schemaObj.allOf) {
        if (!this.isValidType(option, valueType)) {
          return false;
        }
      }
    }
    if (schemaObj.anyOf) {
      let validOptions = false;
      // Special limited anyOf handling here
      for (const option of schemaObj.anyOf) {
        if (this.isValidType(option, valueType)) {
          validOptions = true;
          break;
        }
      }
      if (!validOptions) {
        return false;
      }
    }
    if (schemaObj.oneOf) {
      let validOptions = 0;
      // Special limited oneOf handling here
      for (const option of schemaObj.oneOf) {
        if (this.isValidType(option, valueType)) {
          validOptions++;
          break;
        }
      }
      if (validOptions !== 1) {
        return false;
      }
    }
    return true;
  }

  /**
   * Traverse an an array according to the specified schema, returning
   * a new array that includes the elements that matched the schema.
   *
   * @param doc doc with address and value to traverse
   * @param schema schema that applies to this object
   * @param link optional link to pass to createObject callback
   * @returns the newly created array with entries or undefined if one of our
   *  elements failed to validate.
   */
  private traverseArrayWithSchema(
    doc: IMemorySpaceAttestation,
    schema: JSONSchemaObj,
    _link?: NormalizedFullLink,
  ): Immutable<StorableValue> {
    const arrayObj: Immutable<StorableDatum>[] = [];
    for (
      const [index, item] of (doc.value as Immutable<JSONValue>[]).entries()
    ) {
      const itemSchema = this.cfc.schemaAtPath(schema, [index.toString()]);
      let curDoc: IMemorySpaceAttestation = {
        address: {
          ...doc.address,
          path: [...doc.address.path, index.toString()],
        },
        value: item,
      };
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
        const [redirDoc, selector] = this.getDocAtPath(
          curDoc,
          [],
          curSelector,
          "writeRedirect",
        );
        curDoc = redirDoc;
        curSelector = selector!;
        // redirDoc has only followed redirects.
        // If our redirDoc is a link, resolve one step, and use that value instead
        // because arrays dereference one more link.
        const [linkDoc, linkSelector] = this.nextLink(redirDoc, curSelector);
        curDoc = linkDoc;
        curSelector = linkSelector!;
        if (curDoc.value === undefined) {
          logger.debug(
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
        if (curDoc === undefined) {
          // If we hit a broken link following write redirects, I think we have
          // to abort.
          logger.debug(
            "traverse",
            () => ["Encountered broken redirect", curDoc, curSelector],
          );
          return undefined;
        }

        // For my cell link, lastRedirDoc currently points to the last
        // redirect target, but we want cell properties to be based on the
        // link value at that location, so we effectively follow one more
        // link if available.
        // If we have a value instead of a link, create a link to the element
        // We don't traverse and validate, since this is an asCell boundary.
        const cellLink = isPrimitiveCellLink(curDoc.value)
          ? getNextCellLink(curDoc, curSelector.schema!)
          : getNormalizedLink(curDoc.address, curSelector.schema);
        const val = this.objectCreator.createObject(cellLink, undefined);
        arrayObj.push(val);
      } else {
        // We want those links to point directly at the linked cells, instead
        // of using our path (e.g. ["items", "0"]), so don't pass in a
        // modified link.
        const val = this.traverseWithSelector(curDoc, curSelector);
        if (val !== undefined) {
          arrayObj.push(val);
        } else {
          // If our item doesn't match our schema, we may be able to use null,
          // but not if we're supposed to have a cell.
          if (
            this.isValidType(schema, "null") &&
            !SchemaObjectTraverser.asCellOrStream(schema)
          ) {
            arrayObj.push(null);
          } else {
            // this array is invalid; one or more items do not match the schema
            logger.debug(
              "traverse",
              () => ["Item doesn't match array schema", curDoc, curSelector],
            );
            return undefined;
          }
        }
      }
    }
    return arrayObj;
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
    doc: IMemorySpaceAttestation,
    schema: JSONSchemaObj,
    _link?: NormalizedFullLink,
  ): Immutable<StorableValue> {
    const filteredObj: Record<string, Immutable<StorableDatum>> = {};
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
        isObject(propSchema) && (
          propSchema.$comment === "emptyProperties" ||
          propSchema.$comment === "missingProperty"
        )
      ) {
        this.objectCreator.addOptionalProperty(filteredObj, propKey, propValue);
        continue;
      }
      const elementDoc = {
        address: {
          ...doc.address,
          path: [...doc.address.path, propKey],
        },
        value: propValue,
      };
      const val = this.traverseWithSchema(elementDoc, propSchema);
      if (val !== undefined) {
        filteredObj[propKey] = val;
      }
    }

    // Apply defaults from our schema
    if (isObject(schema) && schema.properties) {
      for (const propKey of Object.keys(schema.properties)) {
        if (propKey in filteredObj) {
          continue;
        }
        const subSchema = this.cfc.getSchemaAtPath(schema, [propKey]);
        if (!isObject(subSchema)) {
          continue;
        }
        const propSchema = ContextualFlowControl.resolveSchemaRefs(subSchema);
        if (!isObject(propSchema) || propSchema.default == undefined) {
          continue;
        }
        const propAddress = {
          ...doc.address,
          path: [...doc.address.path, propKey],
        };
        if (propSchema.asCell || propSchema.asStream) {
          const val = this.traverseWithSchema({
            address: propAddress,
            value: undefined,
          }, propSchema);
          if (val !== undefined) {
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
    if (isObject(schema) && "required" in schema) {
      const required = schema["required"] as string[];
      if (Array.isArray(required)) {
        for (const requiredProperty of required) {
          if (!(requiredProperty in filteredObj)) {
            logger.debug("traverse", () => [
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
  // The doc.value should be a primitive cell link.
  private traversePointerWithSchema(
    doc: IMemorySpaceAttestation,
    schema: JSONSchema,
    link?: NormalizedFullLink,
  ): Immutable<StorableValue> {
    const selector = { path: doc.address.path, schema };
    const [redirDoc, redirSelector] = this.getDocAtPath(
      doc,
      [],
      selector,
      "writeRedirect",
    );
    if (redirDoc.value === undefined) {
      logger.debug(
        "traversePointerWithSchema",
        () => [
          "Encountered link to undefined value",
          doc,
          redirDoc,
        ],
      );
      return undefined;
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
      const cellLink = getNextCellLink(redirDoc, combinedSchema);
      logger.debug(
        "traverse",
        () => ["Next cell link:", {
          cellLink,
          redirDoc,
          combinedSchema,
        }],
      );
      return this.objectCreator.createObject(cellLink, undefined);
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
    doc: IMemorySpaceAttestation,
    schemaObj: JSONSchemaObj,
  ): Immutable<StorableValue> {
    if (SchemaObjectTraverser.asCellOrStream(schemaObj)) {
      return this.objectCreator.createObject(
        getNormalizedLink(doc.address, schemaObj),
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
    doc: IMemorySpaceAttestation,
    schema: JSONSchema,
  ): JSONValue | undefined {
    if (isObject(schema) && schema.default !== undefined) {
      const link = getNormalizedLink(doc.address, schema);
      return this.objectCreator.applyDefault(link, schema.default);
    }
    return undefined;
  }

  private getDebugValue(doc: IMemorySpaceAttestation) {
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
 * Is schemaA a superset of schemaB.
 * That is, will every object matched by schema B also be matched by schemaA.
 *
 * @param schemaA
 * @param schemaB
 * @returns true if schemaA is a superset, or false if it cannot be determined.
 */
// TDDO(@ubik2): In cache.ts, we have a SelectorTracker which does more
// sophisticated matching. Break that out into a schema module so we can use
// that logic here.
export function isSchemaSuperset(
  schemaA: JSONSchema,
  schemaB: JSONSchema,
) {
  return (ContextualFlowControl.isTrueSchema(schemaA)) ||
    deepEqual(schemaA, schemaB) || (schemaB === false);
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
  return isObject(innerSchema)
    ? { ...outerSchema, ...innerSchema }
    : innerSchema
    ? outerSchema // innerSchema === true
    : false; // innerSchema === false
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
  doc: IMemorySpaceAttestation,
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

function getSchemaOptions(
  schema: JSONSchema,
  type: "anyOf" | "oneOf",
): JSONSchema[] {
  if (schema === true) {
    return [true];
  } else if (schema === false) {
    return [];
  } else {
    const rv = [];
    // There are a lot of valid logical schema flags, and we only handle
    // a very limited set here, with no support for combinations.
    const { anyOf, oneOf, ...restSchema } = schema;
    const options =
      (type === "anyOf" ? anyOf : type === "oneOf" ? oneOf : []) ?? [];
    // Consider items without asCell or asStream first, since if we aren't
    // traversing cells, we consider them a match.
    const sortedOptions = [
      ...options.filter((option) =>
        !SchemaObjectTraverser.asCellOrStream(option)
      ),
      ...options.filter(SchemaObjectTraverser.asCellOrStream),
    ];
    for (const optionSchema of sortedOptions) {
      if (ContextualFlowControl.isFalseSchema(optionSchema)) {
        continue;
      }
      const mergedSchema = mergeSchemaOption(restSchema, optionSchema);
      rv.push(mergedSchema);
    }
    return rv;
  }
}
