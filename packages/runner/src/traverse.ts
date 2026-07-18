import { toIndentedDebugString } from "@commonfabric/data-model/value-debug";
import { hashStringOf } from "@commonfabric/data-model/value-hash";
import { isDeepFrozen } from "@commonfabric/data-model/deep-freeze";
import {
  hashSchema,
  internSchema,
  internSchemaAsTaggedHashString,
  isInternedSchema,
} from "@commonfabric/data-model/schema-hash";
import type { JSONSchemaObj, SchemaPathSelector } from "@commonfabric/api";
import type { MemorySpace, Result, Unit } from "@commonfabric/memory/interface";
import {
  FabricSpecialObject,
  type FabricValue,
} from "@commonfabric/data-model/fabric-value";
import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";
import { deepEqual } from "@commonfabric/utils/deep-equal";
// TODO(@ubik2): Ideally this would import from "@commonfabric/utils/types",
// but rollup has issues
import {
  type Immutable,
  isBoolean,
  isObject,
  isRecord,
  isString,
} from "../../utils/src/types.ts";
import { getLogger } from "../../utils/src/logger.ts";
import { ContextualFlowControl } from "./cfc.ts";
import {
  DEFAULT_SELECTOR,
  internPathSelector,
  internSchemaPairAsKey,
  REJECTING_SELECTOR,
  schemaWithProperties,
} from "@commonfabric/data-model/schema-utils";
import type {
  CellScope,
  JSONObject,
  JSONSchema,
  JSONSchemaTypes,
  SchemaScope,
} from "./builder/types.ts";
import {
  addressKey,
  createDataCellURI,
  NormalizedFullLink,
  parseLink,
} from "./link-utils.ts";
import { canFollowScopedLink } from "./scope.ts";
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
import { createReadOnlyTransactionError } from "./storage/interface.ts";
import {
  excludeReadFromConflict,
  ignoreReadForScheduling,
} from "./storage/reactivity-log.ts";
import { resolve } from "./storage/transaction/attestation.ts";
import {
  type IMemorySpaceValueAddress,
  isSigilLink,
  isWriteRedirectLink,
  type ValuePath,
} from "./link-types.ts";
import type { LastNode } from "./link-resolution.ts";
import type { IAttestation, IMemoryAddress } from "./storage/interface.ts";
import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import { type CellLinkRefPayload, SigilLink } from "./sigil-types.ts";
import {
  recordTraverseInvocation,
  wrapTxForTraverseCapture,
} from "./traverse-recorder.ts";

const logger = getLogger("traverse", { enabled: true, level: "warn" });

type ScopedMemorySpaceValueAddress = IMemorySpaceValueAddress & {
  scope: CellScope;
};

const scopedAddressForKey = (
  address: IMemorySpaceValueAddress,
): ScopedMemorySpaceValueAddress => ({
  ...address,
  // Storage value addresses may omit scope on legacy/default-space paths.
  scope: address.scope ?? "space",
});

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
  readonly value?: FabricValue;
}

// Only false is falsy
const enum TypeValidity {
  False = 0,
  True = 1,
  Unknown = 2,
}

export type IMemorySpaceValueAttestation = IMemorySpaceAttestation & {
  address: IMemorySpaceValueAddress;
};

// Schema operation intern caches: memoize merge/combine results so
// structurally-identical operations return the same object identity.
// The cached value is run through `internSchema`, which deep-freezes and
// dedups structurally-equal results — so downstream `hashSchema` calls
// on the cached output hit `internSchema`'s WeakMap in O(1) instead of
// re-walking the schema tree.
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
): JSONSchema {
  if (cache.size >= INTERN_CACHE_MAX) cache.clear();

  const result = internSchema(value);
  cache.set(key, result);
  return result;
}

/**
 * True when a schema input can safely feed an identity-keyed memo: interned
 * (which covers `undefined` and boolean schemas) or deep-frozen. Frozen
 * suffices — the identity cannot go stale through later mutation. The
 * distinction matters on the server: doc values arrive deep-frozen from the
 * wire-decode boundary, so their embedded link schemas are frozen but never
 * interned, and an interned-only gate would bypass every seam memo there.
 */
function isMemoizableSchemaInput(schema: JSONSchema | undefined): boolean {
  return isInternedSchema(schema) || isDeepFrozen(schema);
}

/**
 * Injective string key for a path: each component is length-prefixed, so a
 * component containing a separator byte (e.g. a `"\0"`-bearing property
 * name) cannot collide with a differently-split path.
 */
function pathKey(path: readonly string[]): string {
  let key = "";
  for (const part of path) key += `${part.length}:${part}`;
  return key;
}

const keyComponent = (value: string): string => `${value.length}:${value}`;

/**
 * Full address identity for the shared schema-result memo.
 *
 * A document id is only unique within its space and scope. Omitting those
 * fields let a shared query memo return another partition's result when the
 * same id/path/schema appeared in both. Length prefixes keep the key
 * injective without paying for JSON serialization on every schema visit.
 */
function schemaMemoAddressKey(address: IMemorySpaceAddress): string {
  return `s${keyComponent(address.space)}c${
    keyComponent(address.scope ?? "space")
  }i${keyComponent(address.id)}t${
    keyComponent(address.type ?? "application/json")
  }p${pathKey(address.path)}`;
}

/**
 * Memoized `narrowSchema()` + `combineOptionalSchema()` for link hops
 * (`followPointer` / `isLinkedDocumentCovered`).
 *
 * Without this, every pointer follow mints a fresh selector (and often a
 * fresh combined schema), so each downstream structural hash — the
 * schemaTracker `MapSet` add, coverage checks, `traverseWithSchema` memo
 * keys — re-walks a brand-new object. Memoizing returns one canonical
 * `internPathSelector`-interned (deep-frozen) selector per repeat hop, so
 * those hashes hit the existing identity-keyed `WeakMap` caches in O(1).
 * The output is structurally identical to the un-memoized computation
 * (interning only substitutes the canonical instance of an equal schema).
 *
 * Keyed on content (injective `pathKey()` encodings) plus cached schema
 * hashes (`hashSchema()`), in one module-level capped `Map`: callers
 * like `traversePointerWithSchema` mint a fresh selector object per call
 * (only its `schema` is identity-stable), so a cache rooted on selector
 * identity would never hit, and every miss would mint yet another distinct
 * frozen selector for downstream code to full-hash. Memoization requires
 * both schemas to be `isMemoizableSchemaInput` (immutable identities, hash
 * cached after first touch); otherwise the exact un-memoized computation
 * runs. The capped string-keyed `Map` follows the `_combineSchemaCache`
 * precedent for bounding growth.
 */
const _linkHopSelectorCache = new Map<string, SchemaPathSelector>();

/** See `BaseObjectTraverser.internCoverageSelector()`. */
const _coverageSelectorCache = new Map<string, SchemaPathSelector>();

function narrowAndCombineSelectorForLink(
  docPath: readonly string[],
  selector: SchemaPathSelector,
  targetPath: readonly string[],
  linkSchema: JSONSchema | undefined,
  cfc: ContextualFlowControl,
): SchemaPathSelector {
  const key = isMemoizableSchemaInput(selector.schema) &&
      isMemoizableSchemaInput(linkSchema)
    ? `${pathKey(selector.path)}|${pathKey(docPath)}|${pathKey(targetPath)}|${
      hashSchema(selector.schema)
    }|${hashSchema(linkSchema)}`
    : undefined;
  if (key !== undefined) {
    const cached = _linkHopSelectorCache.get(key);
    if (cached !== undefined) return cached;
  }
  const narrowed = narrowSchema(docPath, selector, targetPath, cfc);
  // A link schema describes the value at the link's target path. If the
  // selector continues below the source link, narrow the link schema by that
  // source-relative suffix before combining it with the selector schema.
  // `targetPath` already accounts for the link's destination path, so applying
  // that path to the link schema here would narrow it twice.
  const linkSchemaPath = selector.path.length > docPath.length &&
      pathStartsWith(selector.path, docPath)
    ? selector.path.slice(docPath.length)
    : [];
  const narrowedLinkSchema = linkSchema !== undefined &&
      linkSchemaPath.length > 0
    // Match resolveLink(): if the link schema does not describe the remaining
    // path (for example, an array's synthetic `length` property), the link
    // stops contributing a schema rather than rejecting the traversal.
    ? cfc.getSchemaAtPath(linkSchema, linkSchemaPath)
    : linkSchema;
  narrowed.schema = combineOptionalSchema(
    narrowed.schema,
    narrowedLinkSchema,
  );
  const interned = internPathSelector(narrowed);
  if (key !== undefined) {
    if (_linkHopSelectorCache.size >= INTERN_CACHE_MAX) {
      _linkHopSelectorCache.clear();
    }
    _linkHopSelectorCache.set(key, interned);
  }
  return interned;
}

/**
 * Memoized, canonicalizing wrapper around `cfc.schemaAtPath()` for the hot
 * traversal seams (object properties, array items). The core method now
 * symbolically memoizes its common boolean-default derivations; this seam also
 * covers the marker-object variant used below, which is intentionally outside
 * that cache. It returns one interned (canonical, deep-frozen) result per
 * (schema identity, path, marker variant), so downstream identity-keyed hash
 * caches (most notably the `traverseWithSchema` memo) hit.
 *
 * Only memoizes when `schema` is a memoizable input (interned or deep-frozen
 * — see `isMemoizableSchemaInput()`), so the identity key cannot go stale.
 * (`schemaAtPath()` is deterministic — `ContextualFlowControl` carries no
 * instance state — so a module-level cache across cfc instances is sound.)
 * Mutable input falls back to the exact un-memoized computation.
 *
 * `markers` selects the `$comment` marker pair `traverseObjectWithSchema`
 * uses to detect properties it should not descend into.
 */
const EMPTY_PROPERTIES_MARKER: JSONSchema = Object.freeze(
  { $comment: "emptyProperties" },
);
const MISSING_PROPERTY_MARKER: JSONSchema = Object.freeze(
  { $comment: "missingProperty" },
);
const _schemaAtPathCache = new WeakMap<
  JSONSchemaObj,
  Map<string, JSONSchema>
>();

function schemaAtPathCanonical(
  cfc: ContextualFlowControl,
  schema: JSONSchema,
  path: readonly string[],
  markers = false,
): JSONSchema {
  const compute = () =>
    markers
      ? cfc.schemaAtPath(
        schema,
        path,
        undefined,
        EMPTY_PROPERTIES_MARKER,
        MISSING_PROPERTY_MARKER,
      )
      : cfc.schemaAtPath(schema, path);
  if (typeof schema === "boolean" || !isMemoizableSchemaInput(schema)) {
    return compute();
  }
  let byPath = _schemaAtPathCache.get(schema);
  if (byPath === undefined) {
    byPath = new Map();
    _schemaAtPathCache.set(schema, byPath);
  }
  const key = (markers ? "m|" : "d|") + pathKey(path);
  const cached = byPath.get(key);
  if (cached !== undefined) return cached;
  // Marker-bearing calls return freshly-spread tops over the (deep-frozen,
  // since `schema` is interned) children. Default calls may already be the
  // core method's canonical result; interning is idempotent in that case.
  const result = internSchema(compute());
  if (byPath.size >= INTERN_CACHE_MAX) byPath.clear();
  byPath.set(key, result);
  return result;
}

type PlainPrimitiveType =
  | "undefined"
  | "null"
  | "string"
  | "number"
  | "boolean";

type PlainSchemaPlan =
  | {
    kind: "primitive";
    schema: JSONSchemaObj;
    type: PlainPrimitiveType;
  }
  | {
    kind: "array";
    schema: JSONSchemaObj;
    items: PlainSchemaPlan;
  }
  | {
    kind: "object";
    schema: JSONSchemaObj;
    properties: ReadonlyMap<string, PlainSchemaPlan>;
  };

type PlainSchemaReads = {
  address: Omit<IMemorySpaceValueAddress, "path">;
  paths: (readonly string[])[];
};

const _plainSchemaPlanCache = new WeakMap<
  JSONSchemaObj,
  PlainSchemaPlan | false
>();

/** Exact `{ type }` schemas have no traversal semantics beyond this check. */
function isPlainTypeSchema(schema: JSONSchemaObj, type: string): boolean {
  return schema.type === type && Object.keys(schema).length === 1;
}

/**
 * Return direct children only when the parent has no keywords for
 * schemaAtPath() to propagate or interpret.
 */
function plainArrayItems(schema: JSONSchemaObj): JSONSchema | undefined {
  return schema.type === "array" && schema.items !== undefined &&
      Object.keys(schema).length === 2
    ? schema.items
    : undefined;
}

function plainObjectProperties(
  schema: JSONSchemaObj,
): Record<string, JSONSchema> | undefined {
  return schema.type === "object" && isRecord(schema.properties) &&
      Object.keys(schema).length === 2
    ? schema.properties as Record<string, JSONSchema>
    : undefined;
}

/**
 * Compile schemas made exclusively from `type`, `properties`, and `items`.
 * Any other keyword keeps the subtree on the general traversal path.
 */
function preparePlainSchemaPlan(
  schema: JSONSchema,
  seen: Set<JSONSchemaObj> = new Set(),
): PlainSchemaPlan | undefined {
  if (!isRecord(schema)) return undefined;

  const cacheable = isInternedSchema(schema);
  if (cacheable) {
    const cached = _plainSchemaPlanCache.get(schema);
    if (cached !== undefined) return cached || undefined;
  }
  if (seen.has(schema)) return undefined;
  seen.add(schema);

  let plan: PlainSchemaPlan | undefined;
  const keys = Object.keys(schema);
  if (keys.length === 1) {
    const type = schema.type;
    if (
      type === "undefined" || type === "null" || type === "string" ||
      type === "number" || type === "boolean"
    ) {
      plan = { kind: "primitive", schema, type };
    }
  } else if (keys.length === 2 && schema.type === "array") {
    const items = schema.items === undefined
      ? undefined
      : preparePlainSchemaPlan(schema.items, seen);
    if (items !== undefined) plan = { kind: "array", schema, items };
  } else if (
    keys.length === 2 && schema.type === "object" &&
    isRecord(schema.properties)
  ) {
    const properties = new Map<string, PlainSchemaPlan>();
    let valid = true;
    for (const [key, childSchema] of Object.entries(schema.properties)) {
      const child = preparePlainSchemaPlan(childSchema, seen);
      if (child === undefined) {
        valid = false;
        break;
      }
      properties.set(key, child);
    }
    if (valid) plan = { kind: "object", schema, properties };
  }

  seen.delete(schema);
  if (cacheable) _plainSchemaPlanCache.set(schema, plan ?? false);
  return plan;
}

/**
 * Returns `schema` minus the given combinator keyword, interned and memoized
 * per (schema identity, keyword). anyOf/oneOf/allOf handling destructures
 * `const { anyOf, ...restSchema } = resolved` on every visit; that fresh
 * `restSchema` made every `mergeSchemaOption()` cache lookup re-hash it from
 * scratch. Canonicalizing it once per resolved-schema identity lets those
 * lookups hit the interned-schema hash cache in O(1).
 *
 * Like the other seam memos, only a memoizable (interned or deep-frozen,
 * hence identity-stable) `schema` is memoized; otherwise this is exactly the
 * old inline destructure.
 */
const _restSchemaCache = new WeakMap<
  JSONSchemaObj,
  Map<string, JSONSchemaObj>
>();

function combinatorRestSchema(
  schema: JSONSchemaObj,
  keyword: "anyOf" | "oneOf" | "allOf",
): JSONSchemaObj {
  if (!isMemoizableSchemaInput(schema)) {
    const { [keyword]: _dropped, ...rest } = schema;
    return rest as JSONSchemaObj;
  }
  let byKeyword = _restSchemaCache.get(schema);
  if (byKeyword === undefined) {
    byKeyword = new Map();
    _restSchemaCache.set(schema, byKeyword);
  }
  const cached = byKeyword.get(keyword);
  if (cached !== undefined) return cached;
  const { [keyword]: _dropped, ...rest } = schema;
  const interned = internSchema(rest);
  byKeyword.set(keyword, interned);
  return interned;
}

/**
 * Per-branch precomputation for an anyOf schema. The per-node loop in
 * `_traverseWithSchemaInner` previously re-did, on EVERY visited node, work
 * that depends only on the schema: sorting branches (two `hasAsCell` filter
 * passes), merging rest+option per branch, and `canBranchMatch`'s static
 * derivations ($ref resolution, type-list normalization, required-props
 * applicability). Tail-latency motivated: anyOf-heavy vnode docs evaluate
 * thousands of branches per traversal, so the per-branch constant dominates
 * p99/max traversal time. Prepared once per identity, the per-node check
 * collapses to a few field reads.
 *
 * Semantics are exactly `canBranchMatch(mergeSchemaOption(rest, option))`
 * in the exact pre-existing branch order, including counter accounting for
 * `false` options.
 */
type PreparedAnyOfBranch = {
  /** Original option was the `false` schema: counted, never matched. */
  optionIsFalse: boolean;
  merged: JSONSchema;
  /** Prefilter verdict known statically (boolean merged / unresolved $ref). */
  constant: boolean | undefined;
  hasAsCell: boolean;
  /** Normalized type list of the resolved merged schema, if constrained. */
  types: readonly JSONSchemaTypes[] | undefined;
  /** Required property names, when the resolved type admits objects. */
  required: readonly string[] | undefined;
};

const _preparedAnyOfCache = new WeakMap<
  JSONSchemaObj,
  readonly PreparedAnyOfBranch[]
>();

function prepareAnyOfBranch(
  restSchema: JSONSchemaObj,
  option: JSONSchema,
): PreparedAnyOfBranch {
  const rejected: PreparedAnyOfBranch = {
    optionIsFalse: true,
    merged: false,
    constant: false,
    hasAsCell: false,
    types: undefined,
    required: undefined,
  };
  if (ContextualFlowControl.isFalseSchema(option)) return rejected;
  const merged = mergeSchemaOption(restSchema, option);
  if (typeof merged === "boolean") {
    // canBranchMatch's first check: boolean schemas decide immediately.
    return {
      optionIsFalse: false,
      merged,
      constant: merged,
      hasAsCell: false,
      types: undefined,
      required: undefined,
    };
  }
  const hasAsCell = SchemaObjectTraverser.hasAsCell(merged);
  let resolved: JSONSchema | undefined = merged;
  if ("$ref" in merged) {
    resolved = resolveSchemaRefsCanonical(merged);
    if (typeof resolved === "boolean") {
      return {
        optionIsFalse: false,
        merged,
        constant: resolved,
        hasAsCell,
        types: undefined,
        required: undefined,
      };
    } else if (resolved === undefined) {
      // Unresolved $ref: pass the prefilter; traversal complains properly.
      return {
        optionIsFalse: false,
        merged,
        constant: true,
        hasAsCell,
        types: undefined,
        required: undefined,
      };
    }
  }
  const types = resolved.type !== undefined
    ? (Array.isArray(resolved.type) ? resolved.type : [resolved.type])
    : undefined;
  const typeIncludesObject = resolved.type === undefined ||
    resolved.type === "object" ||
    (Array.isArray(resolved.type) && resolved.type.includes("object"));
  const required = typeIncludesObject && Array.isArray(resolved.required)
    ? resolved.required as readonly string[]
    : undefined;
  return {
    optionIsFalse: false,
    merged,
    constant: undefined,
    hasAsCell,
    types,
    required,
  };
}

/**
 * Callers must gate on `isMemoizableSchemaInput(resolved)`: for mutable
 * schemas the preparation cannot be cached, and rebuilding it per visited
 * node costs more than the legacy inline loop (a measured ~25% regression
 * on dynamic-schema patterns) — those take the legacy path instead.
 */
function prepareAnyOf(
  resolved: JSONSchemaObj,
  anyOf: readonly JSONSchema[],
): readonly PreparedAnyOfBranch[] {
  const cached = _preparedAnyOfCache.get(resolved);
  if (cached !== undefined) return cached;
  const restSchema = combinatorRestSchema(resolved, "anyOf");
  // Consider items without asCell or asStream first, since if we aren't
  // traversing cells, we consider them a match.
  const sortedAnyOf = [
    ...anyOf.filter((option) => !SchemaObjectTraverser.hasAsCell(option)),
    ...anyOf.filter(SchemaObjectTraverser.hasAsCell),
  ];
  const prepared = sortedAnyOf.map((option) =>
    prepareAnyOfBranch(restSchema, option)
  );
  _preparedAnyOfCache.set(resolved, prepared);
  return prepared;
}

/**
 * Per-call doc-visit/unique-path diagnostics in `traverseWithSchema` build a
 * string and touch a Map+Set on EVERY schema visit — measurable in tail
 * traversals (thousands of visits each). They only feed the slow-traverse
 * log, so they are collected only when explicitly enabled.
 */
const TRAVERSE_DIAGNOSTICS: boolean = (() => {
  try {
    return typeof Deno !== "undefined" &&
      typeof Deno.env?.get === "function" &&
      Deno.env.get("CF_TRAVERSE_DIAGNOSTICS") === "1";
  } catch {
    return false;
  }
})();

/**
 * Identity-memoized `ContextualFlowControl.resolveSchemaRefs()` with an
 * interned result. `$ref` resolution mints a fresh schema per call, which
 * de-canonicalizes the whole subtree below it: every identity-keyed hash
 * cache downstream (memo keys, cycle-tracker keys, pair-merge keys) misses
 * and re-walks. Only memoizes memoizable (interned or deep-frozen, hence
 * identity-stable) inputs; the un-memoized fallback is byte-identical to
 * the direct call.
 * `null` records a failed resolution (`undefined` result).
 */
const _resolvedRefCache = new WeakMap<JSONSchemaObj, JSONSchema | null>();

export function resolveSchemaRefsCanonical(
  schema: JSONSchemaObj,
): JSONSchema | undefined {
  if (!isMemoizableSchemaInput(schema)) {
    return ContextualFlowControl.resolveSchemaRefs(schema);
  }
  let cached = _resolvedRefCache.get(schema);
  if (cached === undefined) {
    const resolved = ContextualFlowControl.resolveSchemaRefs(schema);
    // `null` (not `undefined`) is the cache's "resolved to nothing" sentinel,
    // so it stays distinct from "absent" on `Map.get()`.
    cached = internSchema(resolved) ?? null;
    _resolvedRefCache.set(schema, cached);
  }
  return cached === null ? undefined : cached;
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

  /**
   * Iterate the values for a key without materializing a `Set` (unlike
   * `get()`, which copies in hash mode). Yields nothing for an absent key.
   */
  public *values(key: K): IterableIterator<V> {
    if (this.hashMap) {
      const m = this.hashMap.get(key);
      if (m) yield* m.values();
    } else {
      const s = this.setMap!.get(key);
      if (s) yield* s;
    }
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
 * code. When `hashValues` is `true`, uses `hashStringOf()`.
 *
 * **Contract:** Callers must hand in selectors that have already been
 * interned via `internPathSelector` (from `@commonfabric/data-model/schema-utils`).
 * That helper deep-freezes `v.path` and `v`, and interns `v.schema`, so the
 * `isDeepFrozen` guard in `hashOfModernInternal` is satisfied and repeat
 * hashes of the same selector reference hit the WeakMap cache. Selectors
 * constructed fresh at insertion sites should be wrapped with
 * `internPathSelector(...)` there; see
 * `coordination/docs/2026-04-16-modern-schema-hash-cache-audit.md` §4
 * Phase 2 "DEFEAT-8" for the motivating analysis.
 */
export class MapSetStringToPathSelectors extends MapSet<
  string,
  SchemaPathSelector
> {
  /**
   * Per-key index of selectors carrying a `true` schema — the only ones that
   * can grant prefix coverage in `schemaTrackerCoversSelector()`. Keeping
   * them separately turns each coverage check from a scan over every
   * selector for the key into a scan over the (typically tiny) permissive
   * subset. May hold structurally-equal duplicates under distinct
   * identities; that only costs a redundant scan step, never correctness.
   */
  private trueSchemaIndex = new Map<string, Set<SchemaPathSelector>>();

  constructor(hashValues: boolean = false) {
    super(hashValues ? (v) => hashStringOf(v) : undefined);
  }

  trueSchemaSelectors(key: string): Iterable<SchemaPathSelector> {
    return this.trueSchemaIndex.get(key) ?? [];
  }

  private isIndexable(value: SchemaPathSelector): boolean {
    return value.schema !== undefined &&
      ContextualFlowControl.isTrueSchema(value.schema);
  }

  public override add(key: string, value: SchemaPathSelector) {
    super.add(key, value);
    if (this.isIndexable(value)) {
      let indexed = this.trueSchemaIndex.get(key);
      if (indexed === undefined) {
        indexed = new Set();
        this.trueSchemaIndex.set(key, indexed);
      }
      indexed.add(value);
    }
  }

  public override deleteValue(
    key: string,
    value: SchemaPathSelector,
  ): boolean {
    const rv = super.deleteValue(key, value);
    // Dedup in the base map is structural while the index is by identity, so
    // a removal can't be mirrored directly; rebuild the (small) key's index.
    if (rv && this.trueSchemaIndex.has(key)) {
      const rebuilt = new Set<SchemaPathSelector>();
      for (const existing of this.values(key)) {
        if (this.isIndexable(existing)) rebuilt.add(existing);
      }
      if (rebuilt.size > 0) this.trueSchemaIndex.set(key, rebuilt);
      else this.trueSchemaIndex.delete(key);
    }
    return rv;
  }

  public override delete(key: string) {
    super.delete(key);
    this.trueSchemaIndex.delete(key);
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

const pathStartsWith = (
  path: readonly string[],
  prefix: readonly string[],
): boolean =>
  prefix.length <= path.length &&
  prefix.every((part, index) => path[index] === part);

/**
 * Determines whether `schemaTracker` already covers `selector` for the given
 * `key` — either by an exact (hash-equal) match, or by an existing permissive
 * (`true`-schema) selector whose path is a prefix of this selector's path.
 *
 * Most efficient when handed an already-interned selector: the
 * `internPathSelector()` call below is then a near-no-op that returns the same
 * reference. An un-interned selector is still handled correctly — it is simply
 * canonicalized (and deep-frozen) on the way in.
 *
 * A schema-less (`undefined`) selector is normalized to `false` ("reject") —
 * the opposite of the `undefined ≈ true` ("accept") convention used elsewhere
 * in this file.
 */
export const schemaTrackerCoversSelector = (
  schemaTracker: MapSet<string, SchemaPathSelector>,
  key: string,
  selector: SchemaPathSelector,
): boolean => {
  const internedSelector = internPathSelector(
    selector.schema === undefined ? { ...selector, schema: false } : selector,
  );
  if (schemaTracker.hasValue(key, internedSelector)) {
    return true;
  }

  // Only true-schema selectors can grant prefix coverage; scan just those
  // when the tracker indexes them.
  const candidates = schemaTracker instanceof MapSetStringToPathSelectors
    ? schemaTracker.trueSchemaSelectors(key)
    : schemaTracker.values(key);
  for (const existing of candidates) {
    if (
      existing.schema !== undefined &&
      ContextualFlowControl.isTrueSchema(existing.schema) &&
      pathStartsWith(internedSelector.path, existing.path)
    ) {
      return true;
    }
  }
  return false;
};

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
 * Identity check on `partialKey`, structural check on `extraKey` via
 * the interned hash string of `extraKey`: the inner per-partialKey map
 * is keyed on `internSchemaAsTaggedHashString(extraKey ?? true)`, so repeat
 * calls with a structurally-equal schema re-lookup the same entry in
 * O(1) without re-hashing — the intern cache's WeakMap returns the
 * canonical hash string without invoking `hashStringOf()` on
 * already-interned inputs.
 *
 * By contract, an `undefined` `extraKey` is equivalent to `true` (JSON
 * Schema's "accept everything"): both are normalized to `true`, so they share
 * one cache entry.
 *
 * This will not work correctly if the key is modified after being
 * added.
 */
export class CompoundCycleTracker<
  EqualKey,
  ExtraKey extends JSONSchema | undefined,
  Value = unknown,
> {
  // partialKey (identity) → Map<interned extraKey hashString, Value?>
  private partial: Map<EqualKey, Map<string, Value | undefined>>;
  constructor() {
    this.partial = new Map();
  }

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
    const hash = internSchemaAsTaggedHashString(extraKey ?? true);
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
    const hash = internSchemaAsTaggedHashString(extraKey ?? true);
    return existing.get(hash);
  }
}

export type PointerCycleTracker = CompoundCycleTracker<
  Immutable<FabricValue>,
  JSONSchema | undefined,
  any
>;

export type TraversalContext = {
  tracker: PointerCycleTracker;
  cfc: ContextualFlowControl;
  schemaTracker: MapSet<string, SchemaPathSelector>;
  includeMeta: boolean;
  metaDocsVisited: Set<string>;
  /**
   * Reports a followed link whose target document is absent from the local
   * replica. Cross-space targets (target space !== `sourceSpace`) can never
   * be covered by the source doc's per-space subscription; same-space
   * targets can still be absent when no selector ever walked them (the
   * fresh-replica read asymmetry). The receiver decides whether to fetch —
   * see `Runtime.ensureLinkedDocLoaded`. Optional: server-side schema
   * traversals have no replica gap.
   */
  onMissingLinkTarget?: (
    link: NormalizedFullLink,
    sourceSpace: MemorySpace,
  ) => void;
};

export function createTraversalContext(
  tracker: PointerCycleTracker,
  cfc: ContextualFlowControl,
  schemaTracker: MapSet<string, SchemaPathSelector>,
  includeMeta: boolean = false,
  metaDocsVisited: Set<string> = new Set<string>(),
  onMissingLinkTarget?: (
    link: NormalizedFullLink,
    sourceSpace: MemorySpace,
  ) => void,
): TraversalContext {
  return {
    tracker,
    cfc,
    schemaTracker,
    includeMeta,
    metaDocsVisited,
    onMissingLinkTarget,
  };
}

export function createDefaultTraversalContext(
  includeMeta: boolean = true,
  schemaTracker: MapSet<string, SchemaPathSelector> =
    new MapSetStringToPathSelectors(true),
  metaDocsVisited: Set<string> = new Set<string>(),
  onMissingLinkTarget?: (
    link: NormalizedFullLink,
    sourceSpace: MemorySpace,
  ) => void,
): TraversalContext {
  return createTraversalContext(
    new CompoundCycleTracker<
      Immutable<FabricValue>,
      JSONSchema | undefined
    >(),
    new ContextualFlowControl(),
    schemaTracker,
    includeMeta,
    metaDocsVisited,
    onMissingLinkTarget,
  );
}

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
  #readOnlySource?: string;

  constructor(
    private manager: ObjectStorageManager,
    public journal = new ManagedStorageJournal(),
  ) {
  }

  setReadOnly(reason = "runtime.readTx()"): void {
    this.#readOnlySource = reason;
  }

  clearReadOnly(): void {
    this.#readOnlySource = undefined;
  }

  isReadOnly(): boolean {
    return this.#readOnlySource !== undefined;
  }

  private assertWritable(method: string): void {
    if (this.#readOnlySource === undefined) {
      return;
    }
    throw createReadOnlyTransactionError(method, this.#readOnlySource);
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
    this.assertWritable("writer()");
    throw new Error("Method not implemented.");
  }
  write(
    _address: IMemorySpaceAddress,
    _value?: FabricValue,
  ): Result<IAttestation, WriterError | WriteError> {
    this.assertWritable("write()");
    throw new Error("Method not implemented.");
  }
  reader(_space: MemorySpace): Result<ITransactionReader, ReaderError> {
    throw new Error("Method not implemented.");
  }
  abort(_reason?: unknown): Result<Unit, InactiveTransactionError> {
    this.assertWritable("abort()");
    throw new Error("Method not implemented.");
  }
  commit(): Promise<Result<Unit, CommitError>> {
    this.assertWritable("commit()");
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
    schema: JSONSchemaObj,
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
  // In the validateAndTransform system, we may add the toCell and toReactive
  // functions or actualy create the cell.
  createObject(
    link: NormalizedFullLink,
    value: (T | undefined)[] | Record<string, (T | undefined)> | T | undefined,
  ): T;

  /**
   * Creates a value whose schema has already been proven to contain only exact
   * `type`, `properties`, and `items` keywords. Implementations may skip the
   * generic asCell/default/schema-shape checks; the result must otherwise have
   * the same observable wrapping and annotation as `createObject()`.
   */
  createPlainSchemaObject?(
    link: NormalizedFullLink,
    value: (T | undefined)[] | Record<string, (T | undefined)> | T | undefined,
  ): T;
}

/**
 * This is the ObjectCreator used by the SchemaObjectTraverser for processing
 * queries. We don't need to do anything special here.
 */
class StandardObjectCreator implements IObjectCreator<FabricValue> {
  mergeMatches(
    matches: FabricValue[],
    _schema: JSONSchemaObj,
  ): FabricValue {
    // These value objects should be merged. While this isn't JSONSchema
    // spec, when we have an anyOf with branches where name is set in one
    // schema, but the address is ignored, and a second option where
    // address is set, and name is ignored, we want to include both.
    return mergeAnyOfMatches(matches);
  }

  addOptionalProperty(
    obj: Record<string, unknown>,
    key: string,
    value: FabricValue,
  ) {
    // It's fine to include this non-matching data, since we're not returning
    // the final object to a user. This lets us see the contents better if we
    // need to debug things.
    obj[key] = value;
  }
  applyDefault(
    _link: NormalizedFullLink,
    defaultValue: FabricValue,
  ): FabricValue {
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
    value: FabricValue,
  ): FabricValue {
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
    // If all our matches are non-array objects, merge the properties.
    if (matches.every((v) => isObject(v))) {
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
  const { space, id, path } = address;
  return {
    space,
    id,
    scope: address.scope ?? "space",
    path: path.slice(1),
    ...(schema !== undefined && { schema }),
  };
}

// Value traversed must be a DAG, though it may have aliases or cell links
// that make it seem like it has cycles
export abstract class BaseObjectTraverser {
  constructor(
    protected tx: IExtendedStorageTransaction,
    protected selector: SchemaPathSelector = DEFAULT_SELECTOR,
    protected context: TraversalContext = createDefaultTraversalContext(),
    public objectCreator: IObjectCreator<FabricValue> =
      new StandardObjectCreator(),
  ) {
    // Identity passthrough unless CF_TRAVERSE_CAPTURE is recording a fixture.
    this.tx = wrapTxForTraverseCapture(tx);
  }
  protected dagMemo = new Map<string, Immutable<FabricValue>>();
  traverseDAGCalls = 0;
  getDocAtPathCalls = 0;
  abstract traverse(
    doc: IMemorySpaceValueAttestation,
  ): TraverseResult<Immutable<FabricValue>>;

  protected get tracker(): PointerCycleTracker {
    return this.context.tracker;
  }

  protected get schemaTracker(): MapSet<string, SchemaPathSelector> {
    return this.context.schemaTracker;
  }

  protected get cfc(): ContextualFlowControl {
    return this.context.cfc;
  }

  protected get traverseCells(): boolean {
    return this.context.includeMeta;
  }

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
    defaultValue?: FabricValue,
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
        ? addressKey(scopedAddressForKey(doc.address)) + "|" +
          addressKey(itemLink)
        : addressKey(scopedAddressForKey(doc.address));
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
        { ...doc.address, scope: doc.address.scope ?? "space" },
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
        if (isSigilLink(item)) {
          const [redirDoc, redirSelector] = this.getDocAtPath(
            docItem,
            [],
            DEFAULT_SELECTOR,
            "writeRedirect",
          );
          const [linkDoc, _selector] = this.nextLink(redirDoc, redirSelector);
          // our item link should point one past the last redirect, but it may
          // be invalid (in which case, we should base the link on redirDoc).
          arrayElementLink = getNormalizedLink(
            linkDoc.value !== undefined ? linkDoc.address : redirDoc.address,
          );
          // We can follow all the links, since we don't need to track cells
          const [valueDoc, _] = this.getDocAtPath(
            linkDoc,
            [],
            DEFAULT_SELECTOR,
          );
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
        newValue[index] = v === undefined ? null : v as FabricValue;
      });
      // Our link is based on the last link in the chain and not the first.
      const newLink = getNormalizedLink(doc.address, true);
      const arrayResult = this.objectCreator.createObject(newLink, newValue);
      if (defaultValue === undefined) {
        const memoKey = itemLink
          ? addressKey(scopedAddressForKey(doc.address)) + "|" +
            addressKey(itemLink)
          : addressKey(scopedAddressForKey(doc.address));
        this.dagMemo.set(memoKey, arrayResult);
      }
      return arrayResult;
    } else if (isRecord(doc.value)) {
      // First, see if we need special handling
      if (isSigilLink(doc.value)) {
        // Check coverage before getAtPath/followPointer adds this link target
        // to schemaTracker.
        const alreadyTracked = this.traverseCells &&
          this.isLinkedDocumentCovered(doc, DEFAULT_SELECTOR);
        const link = parseLink(doc.value, doc.address);
        const [redirDoc, _redirSelector] = this.getDocAtPath(
          doc,
          [],
          DEFAULT_SELECTOR,
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
        const [valueDoc, _] = this.getDocAtPath(redirDoc, [], DEFAULT_SELECTOR);
        this.tx.read(valueDoc.address, READ_FOR_SCHEDULING);
        return this.traverseLinkedDoc(
          valueDoc,
          link.schema,
          defaultValue,
          itemLink,
        );
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
            ? addressKey(scopedAddressForKey(doc.address)) + "|" +
              addressKey(itemLink)
            : addressKey(scopedAddressForKey(doc.address));
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
    return getAtPath(this.tx, doc, path, this.context, selector, lastNode);
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
    if (isSigilLink(doc.value)) {
      this.tx.read(doc.address, READ_FOR_SCHEDULING);
      return followPointer(this.tx, doc, [], this.context, selector, "top");
    } else {
      return [doc, selector];
    }
  }

  protected isLinkedDocumentCovered(
    doc: IMemorySpaceValueAttestation,
    selector: SchemaPathSelector,
  ): boolean {
    const link = parseLink(doc.value, doc.address);
    if (link?.id === undefined) {
      return false;
    }

    const targetSelector = narrowAndCombineSelectorForLink(
      doc.address.path,
      selector,
      ["value", ...(link.path as readonly string[])],
      link.schema,
      this.cfc,
    );

    return schemaTrackerCoversSelector(
      this.schemaTracker,
      `${link.space}/${link.scope}/${link.id}`,
      this.internCoverageSelector(targetSelector),
    );
  }

  /**
   * Returns the interned form of a coverage `selector`, memoized so repeated
   * structurally-equal checks reuse one frozen instance.
   *
   * Safe to call on a frozen or mutable `selector` — it never requires a
   * mutable one. Interning may deep-freeze the selector and its `path` in place
   * (a mutable selector's `schema` may also be canonicalized); a frozen input is
   * left untouched, with a fresh interned selector returned when needed. See
   * `internPathSelector()`. A schema-less (`undefined`) selector is treated as
   * `false` ("reject").
   *
   * The memo matters: `combineOptionalSchema()` mints a new un-interned schema
   * on every call, so without it each repeated coverage check would
   * re-deep-freeze, re-clone, and re-hash that schema — measurably (~2x) slower
   * on link-heavy refreshes. The cache key joins the path with a single schema
   * hash rather than hashing the whole selector: hashing the path array (vs a
   * string join) is pure added cost on the hot cache-hit path.
   *
   * Module-level (capped, see `_coverageSelectorCache`) rather than
   * per-instance: short-lived traversers are created per query, and a
   * per-instance memo would re-mint (and re-full-hash) the same coverage
   * selectors for every one of them. Validity is global — the key is pure
   * content, and interning is process-wide.
   */
  private internCoverageSelector(
    selector: SchemaPathSelector,
  ): SchemaPathSelector {
    const schema = selector.schema ?? false;
    const schemaKey = hashSchema(schema);
    const cacheKey = `${selector.path.join("\0")}\0${schemaKey}`;
    const cached = _coverageSelectorCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    // Copy only to substitute the `false` schema for a missing one; otherwise
    // pass the selector through (`internPathSelector()` handles frozen input).
    const interned = internPathSelector(
      selector.schema === undefined ? { ...selector, schema } : selector,
    );
    if (_coverageSelectorCache.size >= INTERN_CACHE_MAX) {
      _coverageSelectorCache.clear();
    }
    _coverageSelectorCache.set(cacheKey, interned);
    return interned;
  }

  /**
   * Traverse a document reached by following a link. The base implementation
   * always uses traverseDAG; subclasses may override to switch to a
   * schema-aware traversal when the link carries a schema.
   */
  protected traverseLinkedDoc(
    doc: IMemorySpaceValueAttestation,
    _linkSchema: JSONSchema | undefined,
    defaultValue: FabricValue,
    itemLink: NormalizedFullLink | undefined,
  ): Immutable<FabricValue> {
    return this.traverseDAG(doc, defaultValue, itemLink);
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
 * @param context - Shared traversal state, including pointer cycles, schema
 *   tracking, metadata traversal, and metadata cycle checks.
 * @param selector: The selector being used (its path is relative to doc's root)
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
  context: TraversalContext,
  selector?: SchemaPathSelector,
  lastNode: LastNode = "value",
): [
  IMemorySpaceValueAttestation,
  SchemaPathSelector | undefined,
] {
  let curDoc = doc;
  let remaining = [...path];

  while (true) {
    if (isSigilLink(curDoc.value)) {
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
        context,
        selector,
        lastNode,
      );
      // followPointer/getAtPath have resolved all path elements
      remaining = [];
    }
    // Our return should never be a link
    //assert(!isSigilLink(curDoc.value));
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
        value: cursorObj[part] as Immutable<FabricValue>,
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

const schemaScopeForSelector = (selector?: SchemaPathSelector) =>
  schemaFollowScopeCap(selector?.schema);

/**
 * The scope cap a schema imposes on the link it permits a read to follow (see
 * ContextualFlowControl.getSchemaScopeCap for the precedence, e.g.
 * `asCell: [{ kind: "cell", scope: "session" }]` caps at session). This caps
 * *which* link scopes may be followed; it must never be copied onto the
 * followed link itself.
 */
const schemaFollowScopeCap = (schema: unknown): SchemaScope | undefined =>
  ContextualFlowControl.getSchemaScopeCap(schema as JSONSchema | undefined);

/**
 * Report a linked document that is absent from the local replica so the
 * runtime can kick its asynchronous load. The read still resolves to
 * undefined and remains a dependency; this only schedules convergence.
 */
function reportMissingLinkTarget(
  context: TraversalContext,
  link: NormalizedFullLink,
  selector: SchemaPathSelector | undefined,
  sourceSpace: MemorySpace,
): void {
  context.onMissingLinkTarget?.(
    {
      space: link.space,
      id: link.id,
      path: selector !== undefined
        ? selector.path.slice(1) as readonly string[]
        : link.path,
      scope: link.scope,
      ...(selector?.schema !== undefined || link.schema !== undefined
        ? {
          schema: (selector?.schema ?? link.schema) as
            | JSONSchema
            | undefined,
        }
        : {}),
    } as NormalizedFullLink,
    sourceSpace,
  );
}

/**
 * Get a string to use as a key for the specified address
 *
 * @param address an IMemorySpaceAddress
 */
function getTrackerKey(
  address: IMemorySpaceAddress,
): string {
  return `${address.space}/${address.scope ?? "space"}/${address.id}`;
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
 * We'll handle tracking of the docs, combining schema, and marking the
 * metadata-linked docs as read if needed.
 *
 * I can't just use resolveLink, since I need to also track all the
 * intermediate documents if we include metadata.
 *
 * @param tx - IStorageTransaction that can be used to read data
 * @param doc - IAttestation for the current document
 * @param path - Property/index path to follow
 * @param context - Shared traversal state, including pointer cycles, schema
 *   tracking, metadata traversal, and metadata cycle checks.
 * @param selector: SchemaPathSelector used to query the target doc
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
  context: TraversalContext,
  selector?: SchemaPathSelector,
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
    scope: link.scope,
    type: "application/json",
    // The link.path doesn't include the initial "value", so prepend it
    path: ["value", ...link.path as string[]],
  };
  const schemaScope = schemaScopeForSelector(selector);
  if (!canFollowScopedLink(schemaScope, link.scope)) {
    // A broader-scoped read context cannot follow a link into a narrower scope
    // (e.g. a space-scoped .map()/lift row reaching a perSession/perUser cell).
    // The rule is intentional, but the follow resolves to undefined silently —
    // a frequent cause of "my PerUser/PerSession value is undefined inside a
    // map" authoring bugs (CT-1642). Warn (not info) so it actually surfaces:
    // the traverse logger runs at "warn", which previously swallowed this.
    logger.warn("traverse", () => [
      `blocked narrower-scope link follow: a "${schemaScope}"-scoped read ` +
      `cannot follow a "${link.scope}"-scoped link, so it resolves to ` +
      `undefined. If this is inside a .map()/lift, resolve the ` +
      `narrower-scoped value at the top level and pass the value down.`,
      {
        schemaScope,
        linkScope: link.scope,
        source: doc.address,
        target,
      },
    ]);
    return [notFound(target), selector];
  }
  if (selector !== undefined) {
    // We'll need to re-root the selector for the target doc
    // Remove the portions of doc.path from selector.path, limiting schema if
    // needed.
    // Also insert the portions of target.path, so selector is relative to
    // new target doc. We do this even if the target doc is the same doc, since
    // we want the selector path to match.
    // When traversing links, we also combine in the link's schema. Memoized
    // (returning one interned selector per repeat hop) so downstream hashing
    // stays identity-cached; see narrowAndCombineSelectorForLink.
    selector = narrowAndCombineSelectorForLink(
      doc.address.path,
      selector,
      target.path,
      link.schema,
      context.cfc,
    );
  }
  // Check to see if we've already included this link with this schema context
  using t = context.tracker.include(doc.value!, selector?.schema, null, doc);
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
      // A target absent from the replica may simply never have been pulled —
      // report it for an async load. This read still resolves notFound; the
      // absent doc is a tracked read, so the reader re-runs when it arrives.
      // Cross-space targets can never be covered by the source doc's
      // per-space subscription. Same-space targets are reported too (the
      // fresh-replica read asymmetry: a rejecting-selector sync delivers
      // only the root doc, so a link can point at a doc no selector ever
      // walked); the receiver decides whether a fetch is actually needed —
      // Runtime.ensureLinkedDocLoaded kicks same-space targets only when
      // the replica has never seen the doc, and at most once, so reads of
      // genuinely absent optional values do not turn into repeated server
      // queries. The reported link carries the selector's target-rooted
      // path (minus its "value" prefix) and schema so the fetch covers the
      // shape this read needs.
      reportMissingLinkTarget(context, link, selector, doc.address.space);
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
    trackVisitedDoc(tx, target, context, selector);
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
        context,
        selector,
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
  return getAtPath(tx, targetDoc, path, context, selector, lastNode);
}

function trackVisitedDoc(
  tx: IExtendedStorageTransaction,
  target: IMemorySpaceAddress,
  context: TraversalContext,
  selector: SchemaPathSelector | undefined,
) {
  // We have a reference to a different doc, so track the dependency
  // and update our targetDoc
  if (selector !== undefined) {
    context.schemaTracker.add(
      getTrackerKey(target),
      internPathSelector(selector),
    );
  }
  // Load the metadata-linked docs recursively unless we're a retracted fact.
  if (context.includeMeta) {
    // Loading metadata requires the full doc. Ignore this read for scheduling.
    const { ok: fullDoc } = tx.read(
      { ...target, path: [] },
      { meta: ignoreReadForScheduling },
    );
    if (fullDoc) {
      loadMetaLinkedDocs(
        tx,
        {
          address: { ...fullDoc.address, space: target.space },
          value: fullDoc.value,
        },
        context,
      );
    }
  }
}

// These meta links don't have full link chains. We only follow the first link.
function loadMetaLinkedDoc(
  tx: IExtendedStorageTransaction,
  valueEntry: IMemorySpaceAttestation,
  meta: "cfc" | "result" | "pattern" | "argument" | "internal",
  schemaTracker: MapSet<string, SchemaPathSelector>,
): MetaLinkedDoc[] {
  const targetObj = valueEntry.value as Immutable<JSONObject>;
  if (!isRecord(targetObj) || !(meta in targetObj)) return [];
  const loaded = [];
  // The internal meta field contains a list of objects with links instead
  if (meta === "internal") {
    if (!Array.isArray(targetObj["internal"])) {
      logger.warn(
        "traverse",
        () => ["Invalid internal manifest in", valueEntry.address],
      );
      return [];
    }
    for (const manifestEntry of targetObj["internal"]) {
      if (!isRecord(manifestEntry)) {
        logger.warn(
          "traverse",
          () => ["Invalid internal manifest entry in", valueEntry.address],
        );
        continue;
      }
      if ("link" in manifestEntry && isSigilLink(manifestEntry.link)) {
        const item = loadMetaLinkedDocFromLink(
          tx,
          valueEntry,
          schemaTracker,
          manifestEntry.link,
        );
        if (item !== undefined) {
          loaded.push(item);
        }
      }
    }
  } else {
    const linkObj = isSigilLink(targetObj[meta])
      ? targetObj[meta] as SigilLink
      : (meta === "cfc") // cfc links are different
      ? cfcMetaToSigilLink(targetObj["cfc"])
      : undefined;
    if (linkObj === undefined) {
      // undefined is strange, but acceptable
      logger.warn(
        "traverse",
        () => ["Invalid meta link", meta, "in", valueEntry.address],
      );
      return [];
    }
    const item = loadMetaLinkedDocFromLink(
      tx,
      valueEntry,
      schemaTracker,
      linkObj,
    );
    if (item !== undefined) {
      loaded.push(item);
    }
  }
  return loaded;
}

function loadMetaLinkedDocFromLink(
  tx: IExtendedStorageTransaction,
  valueEntry: IMemorySpaceAttestation,
  schemaTracker: MapSet<string, SchemaPathSelector>,
  linkObj: SigilLink,
) {
  const link = parseLink(linkObj, valueEntry.address)!;
  const address = {
    space: link.space,
    id: link.id!,
    scope: link.scope,
    path: [],
  };
  if (address === undefined) {
    return undefined;
  }
  // This read only loads the linked metadata doc so traversal can inspect it.
  // The schema-guided traversal below records the real scheduling reads.
  const result = tx.read(address, { meta: ignoreReadForScheduling });
  if (result.error) {
    return undefined;
  }
  const docKey = getTrackerKey(address);
  schemaTracker.add(docKey, REJECTING_SELECTOR);
  return { address, value: result.ok.value, selector: REJECTING_SELECTOR };
}

function cfcMetaToSigilLink(obj: unknown): SigilLink | undefined {
  if (isRecord(obj) && "schemaHash" in obj) {
    const schemaHash = obj["schemaHash"];
    if (typeof schemaHash === "string" && schemaHash.length > 0) {
      return linkRefFrom<CellLinkRefPayload>({ id: `cid:${schemaHash}` });
    }
  }
  return undefined;
}

type MetaLinkedDoc = IMemorySpaceAttestation & {
  selector: SchemaPathSelector;
};

function traverseMetaLinkedDoc(
  tx: IExtendedStorageTransaction,
  doc: MetaLinkedDoc,
  context: TraversalContext,
) {
  if (
    doc.selector.schema === undefined ||
    ContextualFlowControl.isFalseSchema(doc.selector.schema)
  ) {
    return;
  }
  if (!isRecord(doc.value) || !("value" in doc.value)) {
    return;
  }

  const docContext = createTraversalContext(
    new CompoundCycleTracker<
      Immutable<FabricValue>,
      JSONSchema | undefined
    >(),
    context.cfc,
    context.schemaTracker,
    context.includeMeta,
    context.metaDocsVisited,
    context.onMissingLinkTarget,
  );
  const traverser = new SchemaObjectTraverser(
    tx,
    doc.selector,
    docContext,
  );
  const fullDoc = doc.value as Immutable<JSONObject>;
  traverser.traverse({
    address: {
      ...doc.address,
      path: ["value"],
    },
    value: fullDoc.value as Immutable<FabricValue>,
  });
}

// Recursively load the meta linked docs from the doc
export function loadMetaLinkedDocs(
  tx: IExtendedStorageTransaction,
  valueEntry: IMemorySpaceAttestation,
  context: TraversalContext,
) {
  const valueEntryKey = getTrackerKey(valueEntry.address);
  if (context.metaDocsVisited.has(valueEntryKey)) {
    return;
  }
  context.metaDocsVisited.add(valueEntryKey);

  const pendingDocs = [valueEntry];
  while (pendingDocs.length > 0) {
    const currentDoc = pendingDocs.shift()!;
    for (
      const meta of [
        "cfc",
        "result",
        "pattern",
        "argument",
        "internal",
      ] as const
    ) {
      const linkedDocs = loadMetaLinkedDoc(
        tx,
        currentDoc,
        meta,
        context.schemaTracker,
      );
      for (const linkedDoc of linkedDocs) {
        // Don't recurse into invalid docs or cid docs
        if (linkedDoc.address.id.startsWith("cid:")) {
          continue;
        }
        const linkedDocKey = getTrackerKey(linkedDoc.address);
        if (context.metaDocsVisited.has(linkedDocKey)) continue;
        context.metaDocsVisited.add(linkedDocKey);
        traverseMetaLinkedDoc(tx, linkedDoc, context);
        pendingDocs.push(linkedDoc);
      }
    }
  }
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

// Merge the asCell values from flagSchema into schema.
export function mergeSchemaFlags(flagSchema: JSONSchema, schema: JSONSchema) {
  const key = internSchemaPairAsKey(flagSchema, schema);
  const cached = _mergeSchemaFlagsCache.get(key);
  if (cached !== undefined) return cached;
  const result = _mergeSchemaFlagsUncached(flagSchema, schema);
  return internSet(_mergeSchemaFlagsCache, key, result);
}

function _mergeSchemaFlagsUncached(
  flagSchema: JSONSchema,
  schema: JSONSchema,
) {
  if (isRecord(flagSchema) && flagSchema.asCell !== undefined) {
    // we want to preserve asCell -- if set, this will override the value in
    // the schema
    return schemaWithProperties(schema, { asCell: flagSchema.asCell });
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
 * This operation is not generally commutative: parent and link schemas have
 * distinct precedence rules. False schemas absorb the other constraint, and
 * schemas with provably disjoint types combine to false in either order.
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
  const key = internSchemaPairAsKey(parentSchema, linkSchema);
  const cached = _combineSchemaCache.get(key);
  if (cached !== undefined) return cached;
  const result = _combineSchemaUncached(parentSchema, linkSchema);
  return internSet(_combineSchemaCache, key, result);
}

function schemaTypesAreDisjoint(
  parentType: JSONSchemaObj["type"],
  linkType: JSONSchemaObj["type"],
): boolean {
  if (parentType === undefined || linkType === undefined) return false;

  const parentTypes = Array.isArray(parentType) ? parentType : [parentType];
  const linkTypes = Array.isArray(linkType) ? linkType : [linkType];
  if (parentTypes.includes("unknown") || linkTypes.includes("unknown")) {
    return false;
  }

  return !parentTypes.some((parent) =>
    linkTypes.some((link) =>
      parent === link ||
      (parent === "number" && link === "integer") ||
      (parent === "integer" && link === "number")
    )
  );
}

function schemaTypeMatchesValueType(
  schemaType: JSONSchemaTypes,
  valueType: JSONSchemaTypes,
): boolean {
  // Integer is a subtype of number: an integer value satisfies either schema,
  // while a fractional number only satisfies a number schema.
  return schemaType === valueType ||
    (schemaType === "number" && valueType === "integer");
}

function getJsonNumberType(value: number): "integer" | "number" {
  return Number.isInteger(value) ? "integer" : "number";
}

function narrowNumberIntegerIntersection(
  parentType: JSONSchemaObj["type"],
  linkType: JSONSchemaObj["type"],
): JSONSchemaObj["type"] | undefined {
  if (parentType === undefined || linkType === undefined) return undefined;

  const parentTypes = Array.isArray(parentType) ? parentType : [parentType];
  const linkTypes = Array.isArray(linkType) ? linkType : [linkType];
  if (parentTypes.includes("unknown") || linkTypes.includes("unknown")) {
    return undefined;
  }

  let narrowedNumber = false;
  const intersection = new Set<JSONSchemaTypes>();
  for (const parent of parentTypes) {
    for (const link of linkTypes) {
      if (parent === link) {
        intersection.add(parent);
      } else if (
        (parent === "number" && link === "integer") ||
        (parent === "integer" && link === "number")
      ) {
        intersection.add("integer");
        narrowedNumber = true;
      }
    }
  }

  if (!narrowedNumber) return undefined;
  const types = [...intersection].sort();
  return types.length === 1 ? types[0] : types;
}

function _combineSchemaUncached(
  parentSchema: JSONSchema,
  linkSchema: JSONSchema,
): JSONSchema {
  if (ContextualFlowControl.isFalseSchema(parentSchema)) {
    return parentSchema;
  } else if (ContextualFlowControl.isFalseSchema(linkSchema)) {
    return linkSchema;
  } else if (ContextualFlowControl.isTrueSchema(parentSchema)) {
    return mergeSchemaFlags(parentSchema, linkSchema);
  } else if (ContextualFlowControl.isTrueSchema(linkSchema)) {
    return mergeSchemaFlags(linkSchema, parentSchema);
  } else if (isRecord(linkSchema) && isRecord(parentSchema)) {
    if (
      schemaTypesAreDisjoint(parentSchema.type, linkSchema.type)
    ) return false;
    const narrowedType = narrowNumberIntegerIntersection(
      parentSchema.type,
      linkSchema.type,
    );
    if (linkSchema.type === "object" && parentSchema.type === "object") {
      // A property required by either intersected schema remains required.
      const {
        required: parentRequired,
        $defs: parentDefs,
        ...parentSchemaRest
      } = parentSchema;
      const { required: linkRequired, $defs: linkDefs, ...linkSchemaRest } =
        linkSchema;
      const required = parentRequired || linkRequired
        ? [...new Set([...(parentRequired ?? []), ...(linkRequired ?? [])])]
        : undefined;
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
      // Conceptually, this mirrors how TypeScript maps any & T ,
      // i.e. true + a link, yields T, interestingly. but
      // { foo?: string } & { bar?: string } is allowing both foo and bar.
      // this allows polymorphism (when caller asks for it), but stops
      // schemaless queries from exploding.
      const parentAdditionalProperties = parentSchema.additionalProperties ??
        ((parentSchema.properties === undefined) || undefined);
      const linkAdditionalProperties = linkSchema.additionalProperties ??
        ((linkSchema.properties === undefined) || undefined);
      if (
        parentSchema.properties === undefined &&
        parentAdditionalProperties !== undefined &&
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
        linkAdditionalProperties !== undefined &&
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
          } else if (parentAdditionalProperties === undefined) {
            // we have parentSchema.properties, but nothing for this property
            // so just use the linkSchema's value
            mergedSchemaProperties[key] = value;
          } else {
            mergedSchemaProperties[key] = combineSchema(
              parentAdditionalProperties!,
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
          } else if (linkAdditionalProperties === undefined) {
            // we have linkSchema.properties, but nothing for this property
            // so just use the parentSchema's value
            mergedSchemaProperties[key] = value;
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
      // TODO(@ubik2): We should handle prefixItems
      const mergedDefs = { ...linkSchema.$defs, ...parentSchema.$defs };
      const mergedSchemaItems = parentSchema.items === undefined
        ? linkSchema.items
        : linkSchema.items === undefined
        ? parentSchema.items
        : combineSchema(parentSchema.items, linkSchema.items);
      return {
        ...linkSchema,
        ...parentSchema,
        type: "array",
        ...(mergedSchemaItems !== undefined && { items: mergedSchemaItems }),
        ...(Object.keys(mergedDefs).length && { $defs: mergedDefs }),
      };
    } else {
      // this isn't great, but at least grab the flags from parent schema
      // Merge $defs from the two schema, with parent taking priority
      const mergedDefs = { ...linkSchema.$defs, ...parentSchema.$defs };
      // In this case, we use the link for flags, but generally use the parent
      // since the object types may be different
      return mergeSchemaFlags(linkSchema, {
        ...parentSchema,
        ...(narrowedType !== undefined && { type: narrowedType }),
        ...(Object.keys(mergedDefs).length && { $defs: mergedDefs }),
      });
    }
  }
  return linkSchema;
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

type TraverseFailure = Readonly<{
  name: "TraverseFailure";
  code: string;
  message: string;
}>;

function createTraverseFailure(
  code: string,
  message: string,
): TraverseFailure {
  return Object.freeze({
    name: "TraverseFailure" as const,
    code,
    message,
  });
}

const TRAVERSE_FAILURES = {
  pathMismatch: createTraverseFailure("PATH_MISMATCH", "Path mismatch"),
  undefinedLink: createTraverseFailure(
    "UNDEFINED_LINK",
    "Encountered link to undefined value",
  ),
  schemaRefResolution: createTraverseFailure(
    "SCHEMA_REF_RESOLUTION",
    "Failed to resolve schema ref",
  ),
  noMatchingAnyOf: createTraverseFailure(
    "NO_MATCHING_ANY_OF",
    "No matching anyOf",
  ),
  noMatchingOneOf: createTraverseFailure(
    "NO_MATCHING_ONE_OF",
    "No matching oneOf",
  ),
  multipleMatchingOneOf: createTraverseFailure(
    "MULTIPLE_MATCHING_ONE_OF",
    "Multiple matching oneOf",
  ),
  falseAllOf: createTraverseFailure(
    "FALSE_ALL_OF",
    "Encountered false in allOf",
  ),
  falseSchema: createTraverseFailure("FALSE_SCHEMA", "Schema is false"),
  invalidType: createTraverseFailure("INVALID_TYPE", "Invalid type"),
  invalidArray: createTraverseFailure("INVALID_ARRAY", "Invalid array"),
  invalidObject: createTraverseFailure("INVALID_OBJECT", "Invalid object"),
  unexpectedDocValue: createTraverseFailure(
    "UNEXPECTED_DOC_VALUE",
    "Unexpected type for doc value",
  ),
} as const;

function fail<T>(
  error: TraverseFailure,
): TraverseResult<T> {
  return { error };
}

type TraverseResult<T> = { ok: T; error?: never } | {
  ok?: never;
  error: TraverseFailure;
};

/** Schema memo cache shared across SchemaObjectTraverser instances within a query */
export type SchemaMemo = Map<string, TraverseResult<Immutable<FabricValue>>>;

/** Create a shared memo cache to pass to multiple SchemaObjectTraverser instances */
export function createSchemaMemo(): SchemaMemo {
  return new Map();
}

export class SchemaObjectTraverser<V extends FabricValue>
  extends BaseObjectTraverser {
  private sharedSchemaMemo?: SchemaMemo;

  constructor(
    tx: IExtendedStorageTransaction,
    selector: SchemaPathSelector = DEFAULT_SELECTOR,
    context: TraversalContext = createDefaultTraversalContext(),
    objectCreator?: IObjectCreator<V>,
    sharedSchemaMemo?: SchemaMemo,
  ) {
    super(tx, selector, context, objectCreator);
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

  protected override traverseLinkedDoc(
    doc: IMemorySpaceValueAttestation,
    linkSchema: JSONSchema | undefined,
    defaultValue: FabricValue,
    itemLink: NormalizedFullLink | undefined,
  ): Immutable<FabricValue> {
    if (
      linkSchema !== undefined &&
      !ContextualFlowControl.isTrueSchema(linkSchema)
    ) {
      const { ok, error } = this.traverseWithSchema(doc, linkSchema, itemLink);
      if (error !== undefined) {
        logger.debug(
          "traverse",
          () => [
            "traverseLinkedDoc schema traversal failed, link schema:",
            linkSchema,
            error,
          ],
        );
        return null;
      }
      return ok;
    }
    return this.traverseDAG(doc, defaultValue, itemLink);
  }

  override traverse(
    doc: IMemorySpaceValueAttestation,
    link?: NormalizedFullLink,
  ): TraverseResult<Immutable<FabricValue>> {
    // No-op unless CF_TRAVERSE_CAPTURE is recording a fixture.
    recordTraverseInvocation(
      doc,
      this.selector,
      link,
      this.context,
      this.sharedSchemaMemo,
    );
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
    this.schemaTracker.add(
      getTrackerKey(doc.address),
      internPathSelector(this.selector),
    );
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
        TRAVERSE_DIAGNOSTICS
          ? `topDocs=${topDocs}`
          : "topDocs=n/a (set CF_TRAVERSE_DIAGNOSTICS=1)",
      ]);
    }
    if (error !== undefined) {
      // This helps track down mismatched schemas, but may be fine
      logger.debug("traverse", () => [
        "Call to traverse failed validation",
        doc,
        toIndentedDebugString(this.selector?.schema),
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
      return fail(TRAVERSE_FAILURES.pathMismatch);
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
          SchemaObjectTraverser.hasAsCell(nextSelector.schema)
        ) {
          // If we don't have a schema, we don't allow undefined
          // If we have a schema with asCell, we can't create a cell for this,
          // since we can't follow all the write-redirect links.
          // In the future, getAtPath could be altered to convey whether we
          // found a valid undefined node, and we can handle this better, but
          // right now there's no way for that to happen.
          return fail(TRAVERSE_FAILURES.undefinedLink);
        } else {
          return this.isValidType(nextSelector.schema, "undefined")
            ? { ok: this.traversePrimitive(nextDoc, nextSelector.schema) }
            : fail(TRAVERSE_FAILURES.undefinedLink);
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
    const docId = doc.address.id;
    if (TRAVERSE_DIAGNOSTICS) {
      // Per-visit doc/path tracking for the slow-traverse log; the string
      // building is too hot to leave on by default (see TRAVERSE_DIAGNOSTICS).
      this.docVisits.set(docId, (this.docVisits.get(docId) ?? 0) + 1);
      this.uniquePaths.add(docId + "/" + doc.address.path.join("/"));
    }
    try {
      // Memoize by doc address + schema for the query path (traverseCells=true).
      // In the query path, StandardObjectCreator ignores the link param,
      // so the result is fully determined by address + schema.
      if (this.traverseCells) {
        const memo = this.activeMemo;
        const memoKey = schemaMemoAddressKey(doc.address) + "|" +
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
      resolved = resolveSchemaRefsCanonical(schema);
      if (resolved === undefined) {
        logger.warn(
          "traverse",
          () => ["Failed to resolve schema ref", schema],
        );
        return fail(TRAVERSE_FAILURES.schemaRefResolution);
      }
    }
    if (isRecord(resolved)) {
      if (
        doc.value === undefined && resolved.default !== undefined &&
        (resolved.anyOf || resolved.oneOf || resolved.allOf)
      ) {
        return { ok: this.applyDefault(doc, resolved) };
      }
      // There are a lot of valid logical schema flags, and we only handle
      // a very limited set here, with no support for combinations.
      if (resolved.anyOf) {
        const matches: Immutable<FabricValue>[] = [];
        if (typeof resolved === "boolean" || !isInternedSchema(resolved)) {
          // Non-interned schema: identity reuse is not guaranteed (frozen
          // schemas can be freshly minted per evaluation), so the prepared
          // form would be rebuilt per node - slower than this legacy loop.
          const anyOf = resolved.anyOf;
          const restSchema = combinatorRestSchema(resolved, "anyOf");
          // Consider items without asCell or asStream first, since if we
          // aren't traversing cells, we consider them a match.
          const sortedAnyOf = [
            ...anyOf.filter((option) =>
              !SchemaObjectTraverser.hasAsCell(option)
            ),
            ...anyOf.filter(SchemaObjectTraverser.hasAsCell),
          ];
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
            const { ok: val, error } = this.traverseWithSchema(
              doc,
              mergedSchema,
              link,
            );
            if (error === undefined) {
              matches.push(val);
            }
          }
          const merged = this.objectCreator.mergeMatches(
            matches as FabricValue[],
            resolved,
          );
          if (matches.length > 0) {
            return { ok: merged };
          }
          logger.info(
            "traverse",
            () => [
              "No matching anyOf",
              doc,
              sortedAnyOf,
              this.getDebugValue(doc),
            ],
          );
          return fail(TRAVERSE_FAILURES.noMatchingAnyOf);
        }
        // Branch order, merges, and canBranchMatch's static derivations are
        // precomputed per schema identity; the inlined prefilter below is
        // semantically identical to canBranchMatch(merged, doc.value).
        const prepared = prepareAnyOf(resolved, resolved.anyOf);
        const valueIsLink = isSigilLink(doc.value);
        const actualType = getJsonType(doc.value);
        const valueIsRecord = isRecord(doc.value);
        for (const branch of prepared) {
          this.anyOfBranches++;
          if (branch.optionIsFalse) {
            continue;
          }
          let match: boolean;
          if (branch.constant !== undefined) {
            match = branch.constant;
          } else if (branch.hasAsCell || valueIsLink) {
            // Never reject asCell/asStream branches; link values reveal
            // nothing until dereferenced during traversal.
            match = true;
          } else if (
            branch.types !== undefined && actualType !== null &&
            !branch.types.some((type) =>
              schemaTypeMatchesValueType(type, actualType)
            )
          ) {
            match = false;
          } else if (branch.required !== undefined && valueIsRecord) {
            match = true;
            for (const req of branch.required) {
              if (!(req in (doc.value as Record<string, unknown>))) {
                match = false;
                break;
              }
            }
          } else {
            match = true;
          }
          if (!match) {
            this.anyOfFastRejects++;
            continue;
          }
          // TODO(@ubik2): do i need to merge the link schema?
          const { ok: val, error } = this.traverseWithSchema(
            doc,
            branch.merged,
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
          matches as FabricValue[],
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
            prepared,
            this.getDebugValue(doc),
          ],
        );
        return fail(TRAVERSE_FAILURES.noMatchingAnyOf);
      } else if (resolved.oneOf) {
        const oneOf = resolved.oneOf;
        const restSchema = combinatorRestSchema(resolved, "oneOf");
        // Consider items without asCell or asStream first, since if we aren't
        // traversing cells, we consider them a match.
        const sortedOneOf = [
          ...oneOf.filter((option) => !SchemaObjectTraverser.hasAsCell(option)),
          ...oneOf.filter(SchemaObjectTraverser.hasAsCell),
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
          return fail(TRAVERSE_FAILURES.noMatchingOneOf);
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
        return fail(TRAVERSE_FAILURES.multipleMatchingOneOf);
      } else if (resolved.allOf) {
        const matches: Immutable<FabricValue>[] = [];
        const allOf = resolved.allOf;
        const restSchema = combinatorRestSchema(resolved, "allOf");
        for (const optionSchema of allOf) {
          if (ContextualFlowControl.isFalseSchema(optionSchema)) {
            logger.debug(
              "traverse",
              () => ["Encountered false in allOf", resolved],
            );
            return fail(TRAVERSE_FAILURES.falseAllOf);
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
            matches as FabricValue[],
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
      !SchemaObjectTraverser.hasAsCell(resolved)
    ) {
      const defaultValue = isRecord(resolved) ? resolved["default"] : undefined;
      // A value of true or {} means we match anything.
      // Resolve the rest of the doc, and return
      this.tx.read(doc.address, READ_FOR_SCHEDULING); // recursively read this doc
      if (!this.traverseCells && doc.value !== undefined) {
        // When not walking cells for scheduling, create a QueryResultProxy
        // directly instead of pre-traversing the DAG. TransformObjectCreator
        // ignores the pre-built value for true schemas anyway, so traversal
        // is wasted work. The proxy reads lazily from the tx on its own.
        // We don't do this when doc.value is undefined, so we can support
        // Cell.of, which essentially makes the initial value the default
        // value. Since the proxy system doesn't interact with the default
        // value system, we need to bypass that here.
        const effectiveLink = link ?? getNormalizedLink(doc.address, true);
        const proxy = this.objectCreator.createObject(
          { ...effectiveLink, schema: true },
          doc.value,
        );
        return { ok: proxy };
      }
      return { ok: this.traverseDAG(doc, defaultValue, link) };
    } else if (
      ContextualFlowControl.isFalseSchema(resolved) &&
      !SchemaObjectTraverser.hasAsCell(resolved)
    ) {
      // This value rejects all objects - just return
      return fail(TRAVERSE_FAILURES.falseSchema);
    } else if (!isRecord(resolved)) {
      logger.warn(
        "traverse",
        () => ["Invalid schema is not an object", resolved],
      );
      throw new Error("Schema is neither boolean nor an object");
    }
    const schemaObj = resolved;
    const asCellValues = ContextualFlowControl.getAsCellValues(schemaObj);
    // Don't walk into opaque cells
    if (ContextualFlowControl.getAsCellKind(asCellValues.at(0)) === "opaque") {
      const newLink = link ?? getNormalizedLink(
        doc.address,
        schemaObj,
      );
      return { ok: this.objectCreator.createObject(newLink, doc.value) };
    }
    if (doc.value === undefined) {
      // If we have a default, annotate it and return it
      // Otherwise, return undefined
      const defaultValue = this.applyDefault(doc, resolved);
      return (defaultValue !== undefined)
        ? { ok: defaultValue }
        : this.isValidType(schemaObj, "undefined")
        ? { ok: this.traversePrimitive(doc, schemaObj) }
        : fail(TRAVERSE_FAILURES.invalidType);
    } else if (doc.value === null) {
      return isPlainTypeSchema(schemaObj, "null") ||
          this.isValidType(schemaObj, "null")
        ? { ok: this.traversePrimitive(doc, schemaObj) }
        : fail(TRAVERSE_FAILURES.invalidType);
    } else if (isString(doc.value)) {
      return isPlainTypeSchema(schemaObj, "string") ||
          this.isValidType(schemaObj, "string")
        ? { ok: this.traversePrimitive(doc, schemaObj) }
        : fail(TRAVERSE_FAILURES.invalidType);
    } else if (typeof doc.value === "number") {
      // All numbers, including `NaN` and the infinities: they are
      // first-class stored values, so they project like any other number.
      return isPlainTypeSchema(schemaObj, "number") ||
          this.isValidType(schemaObj, getJsonNumberType(doc.value))
        ? { ok: this.traversePrimitive(doc, schemaObj) }
        : fail(TRAVERSE_FAILURES.invalidType);
    } else if (isBoolean(doc.value)) {
      return isPlainTypeSchema(schemaObj, "boolean") ||
          this.isValidType(schemaObj, "boolean")
        ? { ok: this.traversePrimitive(doc, schemaObj) }
        : fail(TRAVERSE_FAILURES.invalidType);
    } else if (Array.isArray(doc.value)) {
      const valid = this.isValidType(schemaObj, "array");
      if (valid === TypeValidity.False) {
        return fail(TRAVERSE_FAILURES.invalidType);
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
        return fail(TRAVERSE_FAILURES.invalidArray);
      }
      entries.forEach((item, i) => {
        newValue[i] = item;
      });
      newValue.length = entries.length;
      return { ok: this.objectCreator.createObject(newLink, newValue) };
      // TODO(danfuzz): a `FabricInstance` is walked by `Object.entries` over
      // internal slots rather than descended by its codec contents; the same
      // gap applies to the schema-`default` fallback path
      // (`traverseDAG`/`applyDefault`), since a schema `default` can carry a
      // `FabricValue`. A correct fix descends a `FabricInstance` by codec
      // contents, not own-props.
    } else if (doc.value instanceof FabricSpecialObject) {
      // A `FabricSpecialObject` (e.g. `FabricBytes`) is an opaque host value
      // the fabric type system treats like a primitive — always frozen,
      // passing through conversion unchanged — so it materializes as a LEAF:
      // its `typeof` is "object", so this arm must precede the record branch
      // below, which would otherwise decompose it via `Object.entries` over
      // its own props (empty for e.g. `FabricBytes`, whose surface lives on
      // the prototype). Type-validate as "object" — the shape the
      // schema-generator emits for these types today — but do not consult
      // the schema's structural details: leaves are not property-walked
      // (CT-1836).
      return this.isValidType(schemaObj, "object") !== TypeValidity.False
        ? { ok: this.traversePrimitive(doc, schemaObj) }
        : fail(TRAVERSE_FAILURES.invalidType);
    } else if (isRecord(doc.value)) {
      if (isSigilLink(doc.value)) {
        this.tx.read(doc.address, READ_FOR_SCHEDULING);
        // When traversing a pointer, use the unresolved schema, so we have
        // the same values in the schema tracker.
        return this.traversePointerWithSchema(doc, schema, link);
      } else {
        const valid = this.isValidType(schemaObj, "object");
        if (valid === TypeValidity.False) {
          return fail(TRAVERSE_FAILURES.invalidType);
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
          return fail(TRAVERSE_FAILURES.invalidObject);
        }
        for (const [k, v] of Object.entries(entries)) {
          newValue[k] = v;
        }
        // TODO(@ubik2): We should be able to remove this cast when we make
        // our return types more correct (we can hold cells/functions).
        return {
          ok: this.objectCreator.createObject(
            newLink,
            newValue as FabricValue,
          ),
        };
      }
    }
    return fail(TRAVERSE_FAILURES.unexpectedDocValue);
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
    valueType: JSONSchemaTypes,
  ): TypeValidity {
    return schemaTypeValidity(schema, valueType);
  }

  /**
   * Materialize an exact type/properties/items subtree without repeatedly
   * re-deriving child schemas and re-entering the general schema dispatcher.
   * Returns undefined when link or array semantics require that general path.
   * The prepared plan is finite and rejects recursive schema graphs, so shapes
   * that need cycle tracking stay on the general path as well.
   */
  private traversePlainSchema(
    doc: IMemorySpaceValueAttestation,
    plan: PlainSchemaPlan,
    link?: NormalizedFullLink,
  ): TraverseResult<Immutable<FabricValue>> | undefined {
    const { path: _path, ...address } = doc.address;
    const reads: PlainSchemaReads = { address, paths: [] };
    const result = this.traversePlainSchemaWithReads(doc, plan, link, reads);
    this.trackPlainSchemaReads(reads);
    return result;
  }

  private trackPlainSchemaReads(
    reads: PlainSchemaReads,
  ): void {
    if (reads.paths.length === 0) return;
    if (this.tx.trackReadPaths) {
      this.tx.trackReadPaths(reads.address, reads.paths, {
        nonRecursive: true,
      });
    } else {
      for (const path of reads.paths) {
        this.tx.read(
          { ...reads.address, path },
          READ_NON_RECURSIVE_FOR_SCHEDULING,
        );
      }
    }
    reads.paths.length = 0;
  }

  private createPlainSchemaObject(
    link: NormalizedFullLink,
    value:
      | (FabricValue | undefined)[]
      | Record<string, FabricValue | undefined>
      | FabricValue
      | undefined,
  ): Immutable<FabricValue> {
    return this.objectCreator.createPlainSchemaObject?.(link, value) ??
      this.objectCreator.createObject(link, value);
  }

  private traversePlainSchemaWithReads(
    doc: IMemorySpaceValueAttestation,
    plan: PlainSchemaPlan,
    link: NormalizedFullLink | undefined,
    reads: PlainSchemaReads,
  ): TraverseResult<Immutable<FabricValue>> | undefined {
    if (isSigilLink(doc.value)) return undefined;

    if (plan.kind === "primitive") {
      return getPlainJsonType(doc.value) === plan.type
        ? { ok: doc.value }
        : fail(TRAVERSE_FAILURES.invalidType);
    }

    if (plan.kind === "array") {
      const itemPlan = plan.items;
      if (!Array.isArray(doc.value) || itemPlan.kind !== "primitive") {
        return Array.isArray(doc.value)
          ? undefined
          : fail(TRAVERSE_FAILURES.invalidType);
      }
      if (doc.value.some(isSigilLink)) return undefined;

      const newValue = new Array<Immutable<FabricValue>>(doc.value.length);
      const newLink = link ?? getNormalizedLink(doc.address, plan.schema);
      // Match traverseArrayWithSchema's structural and per-index reads.
      reads.paths.push(doc.address.path);
      let valid = true;
      doc.value.forEach((item, index) => {
        reads.paths.push(appendToPath(doc.address.path, index.toString()));
        if (getPlainJsonType(item) === itemPlan.type) {
          newValue[index] = item;
        } else if (itemPlan.type === "undefined") {
          newValue[index] = undefined;
        } else if (itemPlan.type === "null") {
          newValue[index] = null;
        } else {
          // Keep visiting later indices after a failure: those reads are part
          // of the scheduler/subscription surface even when the array result
          // is invalid.
          valid = false;
        }
      });
      return valid
        ? { ok: this.createPlainSchemaObject(newLink, newValue) }
        : fail(TRAVERSE_FAILURES.invalidArray);
    }

    if (doc.value instanceof FabricSpecialObject) return { ok: doc.value };
    if (!isRecord(doc.value)) return fail(TRAVERSE_FAILURES.invalidType);

    const newValue: Record<string, Immutable<FabricValue>> = {};
    const newLink = link ?? getNormalizedLink(doc.address, plan.schema);
    for (const propKey of Object.keys(doc.value)) {
      const propValue = doc.value[propKey];
      const childPlan = plan.properties.get(propKey);
      if (childPlan === undefined) {
        this.objectCreator.addOptionalProperty(newValue, propKey, propValue);
        continue;
      }
      const propPath = appendToPath(doc.address.path, propKey);
      reads.paths.push(propPath);
      if (childPlan.kind === "primitive" && !isSigilLink(propValue)) {
        if (getPlainJsonType(propValue) === childPlan.type) {
          newValue[propKey] = propValue;
        }
      } else {
        const propDoc = {
          address: { ...doc.address, path: propPath },
          value: propValue,
        };
        let result = this.traversePlainSchemaWithReads(
          propDoc,
          childPlan,
          undefined,
          reads,
        );
        if (result === undefined) {
          // Preserve activity ordering when a child needs the general
          // traversal, which may register its own reads before returning.
          this.trackPlainSchemaReads(reads);
          result = this.traverseWithSchema(propDoc, childPlan.schema);
        }
        if (result.error === undefined) newValue[propKey] = result.ok;
      }
    }

    return {
      ok: this.createPlainSchemaObject(
        newLink,
        newValue as FabricValue,
      ),
    };
  }

  /**
   * Fast one-hop resolution for the ordinary schema-less links emitted by
   * cell.set(arrayOfObjects). Complex paths, scopes, link schemas, redirects,
   * transaction errors, and query traversal retain followPointer().
   */
  private plainArrayItemLinkTarget(
    doc: IMemorySpaceValueAttestation,
    selector: SchemaPathSelector,
  ): IMemorySpaceValueAddress | undefined {
    if (
      this.traverseCells || selector.schema === undefined ||
      preparePlainSchemaPlan(selector.schema) === undefined ||
      !deepEqual(doc.address.path, selector.path)
    ) {
      return undefined;
    }
    return this.ordinaryArrayItemLinkTarget(doc.value, doc.address);
  }

  private ordinaryArrayItemLinkTarget(
    value: Immutable<FabricValue>,
    source: IMemorySpaceValueAddress,
  ): IMemorySpaceValueAddress | undefined {
    const link = parseLink(value, source);
    const sourceScope = source.scope ?? "space";
    if (
      link === undefined || link.schema !== undefined ||
      link.path.length !== 0 || link.space !== source.space ||
      link.scope !== sourceScope
    ) {
      return undefined;
    }

    return {
      space: link.space,
      id: link.id,
      scope: link.scope,
      type: "application/json",
      path: ["value"],
    };
  }

  private followPlainArrayItemLink(
    doc: IMemorySpaceValueAttestation,
    selector: SchemaPathSelector,
  ): [IMemorySpaceValueAttestation, SchemaPathSelector] | undefined {
    const target = this.plainArrayItemLinkTarget(doc, selector);
    if (target === undefined) return undefined;
    const { ok, error } = this.tx.read(target, READ_NON_RECURSIVE);
    if (error !== undefined) {
      if (error.name !== "NotFoundError" || error.path.length !== 0) {
        return undefined;
      }
      this.reportMissingPlainArrayItemLink(doc, selector, target);
      return [{ address: target, value: undefined }, {
        path: target.path,
        schema: selector.schema,
      }];
    }
    if (ok.value === undefined) return undefined;
    return [{ address: target, value: ok.value }, {
      path: target.path,
      schema: selector.schema,
    }];
  }

  private reportMissingPlainArrayItemLink(
    doc: IMemorySpaceValueAttestation,
    selector: SchemaPathSelector,
    target: IMemorySpaceValueAddress,
  ): void {
    const link = parseLink(doc.value, doc.address);
    if (link === undefined) return;
    reportMissingLinkTarget(
      this.context,
      link,
      { path: target.path, schema: selector.schema },
      doc.address.space,
    );
  }

  /**
   * Pre-resolve a homogeneous run of ordinary array-item links. This lets the
   * traversal record both source-index dependency passes in document-sized
   * batches. Target value reads deliberately remain in the element loop: each
   * one is immediately followed by that target's scheduling and schema reads,
   * preserving V2's last-document locality.
   */
  private preparePlainArrayItemLinks(
    doc: IMemorySpaceValueAttestation,
    docArray: readonly Immutable<FabricValue>[],
    itemSchema: JSONSchema | undefined,
  ):
    | {
      sourceAddresses: readonly IMemorySpaceValueAddress[];
      targets: readonly IMemorySpaceValueAddress[];
    }
    | undefined {
    const itemPlan = itemSchema === undefined
      ? undefined
      : preparePlainSchemaPlan(itemSchema);
    if (
      itemSchema === undefined || this.traverseCells ||
      this.tx.trackReadPaths === undefined || docArray.length < 2 ||
      itemPlan?.kind !== "object" || itemPlan.properties.size === 0
    ) {
      return undefined;
    }

    const sourceAddresses: IMemorySpaceValueAddress[] = [];
    const targets: IMemorySpaceValueAddress[] = [];
    for (let index = 0; index < docArray.length; index++) {
      if (!(index in docArray)) continue;
      const item = docArray[index];
      if (!isSigilLink(item) || isWriteRedirectLink(item)) return undefined;
      const sourceAddress: IMemorySpaceValueAddress = {
        ...doc.address,
        path: appendToPath(doc.address.path, index.toString()),
      };
      const target = this.ordinaryArrayItemLinkTarget(item, sourceAddress);
      if (target === undefined) return undefined;
      sourceAddresses.push(sourceAddress);
      targets.push(target);
    }
    if (targets.length < 2) return undefined;

    return { sourceAddresses, targets };
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
    const docArray = doc.value as Immutable<FabricValue>[];
    const arrayObj = new Array<Immutable<FabricValue>>(docArray.length);
    const directItems = plainArrayItems(schema);

    // Rendering or otherwise consuming a schema-backed array depends on its
    // direct structure, not just the indices that exist right now. Record a
    // shallow read of the array itself so appends/removes can demand lazy
    // upstream computations in pull mode.
    this.tx.read(doc.address, READ_NON_RECURSIVE_FOR_SCHEDULING);

    const preparedPlainLinks = this.preparePlainArrayItemLinks(
      doc,
      docArray,
      directItems,
    );
    if (preparedPlainLinks !== undefined) {
      const { path: _path, ...source } = doc.address;
      const sourcePaths = preparedPlainLinks.sourceAddresses.map(({ path }) =>
        path
      );
      // The old loop interleaved these two reads per index. No writes or other
      // observable work occurs between them, so recording each dependency kind
      // as one ordered run preserves the same reactivity multiset.
      this.tx.trackReadPaths!(source, sourcePaths, { nonRecursive: true });
      this.tx.trackReadPaths!(source, sourcePaths);
    }
    let preparedPlainLinkIndex = 0;

    // Evaluate EVERY element even after one fails: a failing element voids
    // the whole array below, but each element's traversal is also what kicks
    // async loads for absent link targets (fresh-replica read asymmetry).
    // Short-circuiting at the first failure would serialize those kicks —
    // one element per convergence round — and `Cell.pull()`'s round budget
    // exhausts long before a many-element array converges. Walking the rest
    // keeps convergence proportional to link DEPTH, and on the server side
    // keeps the selector walk covering (and thus delivering + watching) the
    // remaining element docs. `forEach` skips sparse holes like `every` did.
    let valid = true;
    docArray.forEach((item, index) => {
      const itemSchema = directItems ??
        schemaAtPathCanonical(this.cfc, schema, [index.toString()]);
      const batchIndex = preparedPlainLinkIndex++;
      const preparedSourceAddress = preparedPlainLinks
        ?.sourceAddresses[batchIndex];
      let curDoc: IMemorySpaceValueAttestation = {
        address: preparedSourceAddress ?? {
          ...doc.address,
          path: appendToPath(doc.address.path, index.toString()),
        },
        value: item,
      };
      let curSelector: SchemaPathSelector = {
        path: curDoc.address.path,
        schema: itemSchema,
      };
      if (preparedPlainLinks === undefined) {
        this.tx.read(curDoc.address, READ_NON_RECURSIVE_FOR_SCHEDULING);
      }
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
      if (isSigilLink(item)) {
        if (this.traverseCells) {
          const alreadyTracked = this.isLinkedDocumentCovered(
            curDoc,
            curSelector,
          );
          const link = parseLink(item, curDoc.address);
          if (alreadyTracked && link?.id !== doc.address.id) {
            this.tx.read(curDoc.address, READ_FOR_SCHEDULING);
            arrayObj[index] = null;
            return;
          }
        }
        let linkDoc: IMemorySpaceValueAttestation;
        let linkSelector: SchemaPathSelector | undefined;
        if (isWriteRedirectLink(curDoc.value)) {
          const [redirDoc, selector] = this.getDocAtPath(
            curDoc,
            [],
            curSelector,
            "writeRedirect",
          );
          curDoc = redirDoc;
          curSelector = selector!;
          // redirDoc has only followed redirects. Arrays dereference one more
          // ordinary link so returned objects refer to the linked document.
          [linkDoc, linkSelector] = this.nextLink(redirDoc, curSelector);
        } else {
          // getDocAtPath(..., "writeRedirect") immediately returns an
          // ordinary link after promoting the source read, and nextLink then
          // promotes that same read again. Do the equivalent single link hop
          // directly for the overwhelmingly common cell.set(array) shape.
          if (preparedPlainLinks === undefined) {
            this.tx.read(curDoc.address, READ_FOR_SCHEDULING);
          }
          const preparedTarget = preparedPlainLinks?.targets[batchIndex];
          const preparedResult = preparedTarget === undefined
            ? undefined
            : this.tx.read(preparedTarget, READ_NON_RECURSIVE);
          const preparedMissing = preparedResult?.error?.name ===
              "NotFoundError" && preparedResult.error.path.length === 0;
          if (
            preparedTarget !== undefined &&
            (preparedResult?.ok?.value !== undefined || preparedMissing)
          ) {
            if (preparedMissing) {
              this.reportMissingPlainArrayItemLink(
                curDoc,
                curSelector,
                preparedTarget,
              );
            }
            linkDoc = {
              address: preparedTarget,
              value: preparedResult?.ok?.value,
            };
            linkSelector = {
              path: preparedTarget.path,
              schema: curSelector.schema,
            };
          } else if (preparedTarget !== undefined) {
            [linkDoc, linkSelector] = followPointer(
              this.tx,
              curDoc,
              [],
              this.context,
              curSelector,
              "top",
            );
          } else {
            [linkDoc, linkSelector] = this.followPlainArrayItemLink(
              curDoc,
              curSelector,
            ) ??
              followPointer(
                this.tx,
                curDoc,
                [],
                this.context,
                curSelector,
                "top",
              );
          }
        }
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
        !SchemaObjectTraverser.hasAsCell(curSelector.schema)
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
        SchemaObjectTraverser.hasAsCell(curSelector.schema)
      ) {
        // For my cell link, curDoc currently points to the last
        // redirect target, but we want cell properties to be based on the
        // link value at that location, so we effectively follow one more
        // link if available.
        // If we have a value instead of a link, create a link to the element
        // We don't traverse and validate, since this is an asCell boundary.
        // If the target is not written yet, still return a cell for it instead
        // of invalidating the parent array; downstream consumers can subscribe
        // to the child cell and observe it when the target materializes.
        const isLink = isSigilLink(curDoc.value);
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
        const plan = !this.traverseCells && curSelector.schema !== undefined
          ? preparePlainSchemaPlan(curSelector.schema)
          : undefined;
        const { ok: val, error } = (plan === undefined
          ? undefined
          : this.traversePlainSchema(curDoc, plan)) ??
          this.traverseWithSelector(curDoc, curSelector);
        if (error !== undefined) {
          // If our item doesn't match our schema, we may be able to use
          // undefined or null if those are valid according to our schema.
          if (this.isValidType(curSelector.schema!, "undefined")) {
            arrayObj[index] = undefined;
          } else if (this.isValidType(curSelector.schema!, "null")) {
            arrayObj[index] = null;
          } else {
            // This array is invalid; one or more items do not match the
            // schema — the ENTIRE array reads as invalid for this caller.
            // Name the failing index + doc so the mismatch is diagnosable
            // without probe archaeology (2026-07-10 board outage: a blanked
            // array with a bare mismatch log hid WHICH element was at fault).
            logger.info(
              "traverse",
              () => [
                "Array element does not match the item schema — voiding the whole array read",
                `index=${index}`,
                curDoc.address,
              ],
            );
            valid = false;
          }
        } else {
          arrayObj[index] = val;
        }
      }
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
    const directProperties = plainObjectProperties(schema);
    for (const [propKey, propValue] of Object.entries(doc.value!)) {
      // We'll use marker schemas to detect some places where we want special
      // schema behavior
      const propSchema = directProperties?.[propKey] ??
        schemaAtPathCanonical(this.cfc, schema, [propKey], true);
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
        SchemaObjectTraverser.hasAsCell(propSchema) &&
        !isSigilLink(propValue)
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
        // When the property is asCell (and reaches here as a sigil link rather
        // than the inline-value branch above), the descent + pointer resolution
        // only RESOLVE THE REFERENCE to construct the Cell — they read the link
        // target's shape, not a value the holder consumes. Those reads must not
        // become commit-time conflict dependencies (a holder of a reference must
        // not collide with disjoint writers under the referent's container). They
        // stay in the journal for reactivity; the holder takes a real dependency
        // only when it reads THROUGH the Cell in its body. A by-value property
        // (`hasAsCell` false) is a genuine dependency and is left unmarked.
        const descend = () => {
          this.tx.read(propDoc.address, READ_NON_RECURSIVE_FOR_SCHEDULING);
          return this.traverseWithSchema(propDoc, propSchema);
        };
        const { ok: val, error } = SchemaObjectTraverser.hasAsCell(propSchema)
          ? this.tx.runWithAmbientReadMeta(excludeReadFromConflict, descend)
          : descend();
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
        if (SchemaObjectTraverser.hasAsCell(propSchema)) {
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
    const alreadyTracked = this.traverseCells &&
      this.isLinkedDocumentCovered(doc, selector);

    // In the case of an opaque cell, we want to skip any deeper reads
    // This means we don't follow any redirects
    const asCellValues = ContextualFlowControl.getAsCellValues(schema);
    if (ContextualFlowControl.getAsCellKind(asCellValues.at(0)) === "opaque") {
      const cellLink = getNextCellLink(doc, schema);
      return { ok: this.objectCreator.createObject(cellLink, undefined) };
    }

    const pointerLink = parseLink(doc.value, doc.address);
    if (
      this.traverseCells && alreadyTracked &&
      pointerLink?.id !== doc.address.id
    ) {
      return { ok: null };
    }

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
        SchemaObjectTraverser.hasAsCell(redirSelector.schema)
      ) {
        const schema = combineOptionalSchema(
          redirSelector?.schema,
          doc.value && isSigilLink(doc.value)
            ? parseLink(doc.value, doc.address)?.schema
            : undefined,
        ) ?? redirSelector?.schema;
        const asCellValues = ContextualFlowControl.getAsCellValues(
          schema,
        );
        if (
          schema !== undefined &&
          ContextualFlowControl.getAsCellKind(asCellValues.at(0)) !== undefined
        ) {
          const cellLink = getNormalizedLink(
            redirDoc.address,
            schema,
          );
          return { ok: this.objectCreator.createObject(cellLink, undefined) };
        }
        // If we don't have a schema, we don't allow undefined
        // If we have a schema with asCell, we can't create a cell for this,
        // since we can't follow all the write-redirect links.
        return fail(TRAVERSE_FAILURES.undefinedLink);
      } else {
        return this.isValidType(redirSelector.schema, "undefined")
          ? { ok: this.traversePrimitive(redirDoc, redirSelector.schema) }
          : fail(TRAVERSE_FAILURES.undefinedLink);
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
      SchemaObjectTraverser.hasAsCell(schema)
    ) {
      const combinedSchema = combineOptionalSchema(
        schema,
        redirSelector?.schema,
      )!;
      // For my cell link, redirDoc currently points to the last redirect
      // target, but we want cell properties to be based on the link value at
      // that location, so we effectively follow one more link if available.
      if (isSigilLink(redirDoc.value)) {
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
    if (SchemaObjectTraverser.hasAsCell(schema)) {
      return this.objectCreator.createObject(
        getNormalizedLink(doc.address, schema),
        doc.value,
      );
    } else {
      return doc.value;
    }
  }

  /**
   * Check whether the schema specifies asCell
   *
   * This handling gets a little blurry with anyOf or oneOf schemas, and
   * in those cases, we base the value on whether every option has the flag.
   *
   * A future improvement is to operate on pre-processed schemas, where the
   * asCell and asStream flags are factored out when possible.
   *
   * We do not resolve references in the anyOf or oneOf options, which means
   * we don't need to worry about cycles, but it also means we may miss some
   * references that should be asCell.
   *
   * @param schema
   * @returns
   */
  static hasAsCell(schema: JSONSchema | undefined): boolean {
    if (schema === undefined || typeof schema === "boolean") {
      return false;
    }
    const asCellValues = ContextualFlowControl.getAsCellValues(schema);
    if (
      asCellValues.length > 0 ||
      (Array.isArray(schema.anyOf) &&
        schema.anyOf.every((option) =>
          SchemaObjectTraverser.hasAsCell(option)
        )) ||
      (Array.isArray(schema.oneOf) &&
        schema.oneOf.every((option) => SchemaObjectTraverser.hasAsCell(option)))
    ) {
      return true;
    }
    return false;
  }

  private applyDefault(
    doc: IMemorySpaceValueAttestation,
    schema: JSONSchema,
  ): FabricValue {
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
    return toIndentedDebugString(
      this.traverseWithSelector(doc, {
        path: doc.address.path,
        schema: true,
      }),
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
  const key = internSchemaPairAsKey(outerSchema, innerSchema);
  const cached = _mergeSchemaOptionCache.get(key);
  if (cached !== undefined) return cached;
  const result = schemaWithProperties(outerSchema, innerSchema);
  return internSet(_mergeSchemaOptionCache, key, result as JSONSchema);
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
  if (SchemaObjectTraverser.hasAsCell(branch)) return true;

  // If the value is an object that could be a link/pointer, bail out entirely.
  // Links are dereferenced during traversal, so the current shape of the value
  // tells us nothing about the resolved type or properties.
  if (isSigilLink(value)) return true;

  let resolved: JSONSchema | undefined = branch;
  if ("$ref" in branch) {
    resolved = resolveSchemaRefsCanonical(branch);
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
      if (
        !schemaTypes.some((type) =>
          schemaTypeMatchesValueType(type, actualType)
        )
      ) return false;
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

/**
 * Map JS typeof to its broad JSON Schema type, or null if unknown. Every
 * number is a `"number"`, including `NaN` and the infinities: they are
 * first-class stored values in this system (the codec and content hash both
 * represent them), so the schema projection must not hide them.
 */
function getPlainJsonType(
  value: unknown,
): JSONSchemaTypes | null {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (isString(value)) return "string";
  if (typeof value === "number") return "number";
  if (isBoolean(value)) return "boolean";
  if (Array.isArray(value)) return "array";
  if (isObject(value)) return "object";
  return null;
}

/** Refine the broad JSON Schema type so integer values can be distinguished. */
function getJsonType(value: unknown): JSONSchemaTypes | null {
  return (typeof value === "number")
    ? getJsonNumberType(value)
    : getPlainJsonType(value);
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

  // Inline 1+N intern-based key: outer schema, then each branch.
  // Interning each input stabilizes its identity so downstream callers
  // hit the hash-cache fast path; `||` separates outer from branches,
  // `|` separates branches.
  const key = `${internSchemaAsTaggedHashString(outerSchema)}||` +
    branches.map(internSchemaAsTaggedHashString).join("|");
  const cached = _mergeAnyOfBranchCache.get(key);
  if (cached !== undefined) return cached;

  const result = _mergeAnyOfBranchSchemasUncached(branches, outerSchema);
  const interned = result !== null ? internSchema(result) : null;
  if (_mergeAnyOfBranchCache.size >= INTERN_CACHE_MAX) {
    _mergeAnyOfBranchCache.clear();
  }
  _mergeAnyOfBranchCache.set(key, interned);
  return interned;
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
    // Deduplicate structurally-equal property schemas across branches by
    // keying on the interned hash; interning also stabilizes these schema
    // identities for any downstream caller that re-hashes them.
    const uniqueHashes = new Map<string, JSONSchema>();
    for (const s of schemas) {
      uniqueHashes.set(internSchemaAsTaggedHashString(s), s);
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
    ...((outerSchema.asCell) &&
      { asCell: outerSchema.asCell }),
  } as JSONSchemaObj;
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

/**
 * Canonical schema/type matching (extracted from SchemaObjectTraverser so the
 * write path can share it): whether a schema can match a value of the given
 * type name, with the same $ref resolution and allOf/anyOf/oneOf handling the
 * read-side validation uses.
 */
function schemaTypeValidity(
  schema: JSONSchema,
  valueType: JSONSchemaTypes,
): TypeValidity {
  let resolved: JSONSchema | undefined = schema;
  if (isRecord(schema) && "$ref" in schema) {
    // Handle any top-level $ref in the schema
    resolved = resolveSchemaRefsCanonical(schema);
    if (resolved === undefined) {
      logger.warn(
        "traverse",
        () => ["Failed to resolve schema ref", schema],
      );
      return TypeValidity.False;
    }
  }
  if (ContextualFlowControl.isTrueSchema(resolved)) {
    return TypeValidity.True;
  } else if (ContextualFlowControl.isFalseSchema(resolved)) {
    return TypeValidity.False;
  }
  const schemaObj = resolved as JSONSchemaObj;
  // Check the top level type flag
  let typeValidity: TypeValidity.True | TypeValidity.Unknown | undefined;
  if ("type" in schemaObj) {
    if (Array.isArray(schemaObj["type"])) {
      const types = schemaObj["type"];
      // type unknown matches anything
      if (types.includes("unknown")) {
        typeValidity = TypeValidity.Unknown;
      } else if (
        !types.some((type) => schemaTypeMatchesValueType(type, valueType))
      ) {
        return TypeValidity.False;
      }
    } else if (isString(schemaObj["type"])) {
      const type = schemaObj["type"];
      // type unknown matches anything
      if (type === "unknown") {
        typeValidity = TypeValidity.Unknown;
      } else if (!schemaTypeMatchesValueType(type, valueType)) {
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
      const valid = schemaTypeValidity(
        schemaWithDefs(schemaObj, option),
        valueType,
      );
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
      const valid = schemaTypeValidity(
        schemaWithDefs(schemaObj, option),
        valueType,
      );
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
      const valid = schemaTypeValidity(
        schemaWithDefs(schemaObj, option),
        valueType,
      );
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
 * Boolean face of the canonical matcher for callers outside this module
 * (notably the write-side scope-isolation guard in data-updating.ts):
 * `Unknown` counts as accepting, since it cannot be ruled out. Judged with
 * the exact same logic the read side uses to reject, so the write-side
 * warning and the read-side behavior cannot drift apart.
 */
export function schemaAcceptsType(
  schema: JSONSchema,
  valueType: JSONSchemaTypes,
): boolean {
  return schemaTypeValidity(schema, valueType) !== TypeValidity.False;
}

function schemaWithDefs(parent: JSONSchemaObj, option: JSONSchema): JSONSchema {
  // We need to preserve any parent $defs in the branch
  if (!parent.$defs || !isRecord(option)) {
    return option;
  }
  return {
    ...option,
    $defs: parent.$defs,
  };
}
