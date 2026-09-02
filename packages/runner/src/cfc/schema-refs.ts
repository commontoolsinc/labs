import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";
import { isDeepFrozen, toCompactDebugString } from "@commonfabric/data-model";
import { internSchema } from "@commonfabric/data-model-schema";
import { getLogger } from "@commonfabric/utils/logger";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";
import { utf8Compare } from "@commonfabric/utils/utf8";

import { decodeJsonPointer, encodeJsonPointer } from "../link-types.ts";
import {
  forEachSubschema,
  isSubschema,
  mapSubschemas,
  type SchemaWalkOptions,
} from "../schema-walk.ts";

// `$ref` discovery / rewriting must be COMPLETE over every subschema keyword,
// including the ones we never emit: a ref this walk misses is a schema doc that
// fails to replicate (fail-open). So opt into the unused-keyword tier
// everywhere in this module. (`$defs` bodies stay dormant — reached through the
// definition-scope logic, not this flag.)
const ALL_SUBSCHEMAS: SchemaWalkOptions = { includeUnused: true };
import {
  embeddedSchemas,
  isEmbeddedCfcSchemaRef,
} from "../embedded-schemas.ts";
import {
  type ExternalSchemaRef,
  isExternalSchemaRef,
  parseExternalSchemaRef,
} from "../schema-decompose.ts";
import {
  externalResolutionMissCount,
  isSchemaDocumentClosureComplete,
  lookupSchemaDocument,
  noteExternalResolutionMiss,
  onSchemaRegistryClear,
} from "../schema-registry.ts";

export { isEmbeddedCfcSchemaRef };

const logger = getLogger("cfc");

type SchemaDefinitions = NonNullable<JSONSchemaObj["$defs"]>;

type SchemaRefSummary = {
  /** All refs below this fragment, excluding dormant `$defs` bodies. */
  all: ReadonlySet<string>;

  /** Local definition names resolved by this fragment's definition scope. */
  localDefinitions: ReadonlySet<string>;
};

type DefinitionIndex = {
  dependencies: Map<string, ReadonlySet<string>>;
  subsets: Map<string, SchemaDefinitions>;
};

const EMPTY_REFS: ReadonlySet<string> = new Set<string>();
const EMPTY_REF_SUMMARY: SchemaRefSummary = {
  all: EMPTY_REFS,
  localDefinitions: EMPTY_REFS,
};

// Memos for the pure schema-ref walks below, keyed by schema object identity.
// A walk populates summaries bottom-up for every visited fragment, so a root
// scan also prepares its child fragments for later schemaAtPath() lookups.
// Only deep-frozen schemas are cached: mutable schemas could be edited in place
// after caching. Definition dependency graphs and canonical subsets are keyed
// separately by the active `$defs` object, since the same fragment may be used
// with different local definition scopes.
const schemaRefSummaryCache = new WeakMap<object, SchemaRefSummary>();
const definitionIndexCache = new WeakMap<object, DefinitionIndex>();
const prunedRootSchemaCache = new WeakMap<object, JSONSchema>();
const prunedScopedSchemaCache = new WeakMap<object, JSONSchema>();
const EMPTY_DEFINITIONS: SchemaDefinitions = Object.freeze({});

// Caching resolveCfcSchemaRef also makes its result identity-STABLE per
// (fullSchema, ref), which lets downstream identity-keyed hash/traverse caches
// hit instead of seeing a fresh spread per resolution.
const resolvedRefCache = new WeakMap<
  object,
  Map<string, JSONSchema | undefined>
>();

const isRootDefsSchemaPointer = (pathToDef: readonly string[]): boolean =>
  pathToDef.length === 3 && pathToDef[0] === "#" && pathToDef[1] === "$defs" &&
  pathToDef[2].length > 0;

export const cfcSchemaToObject = (schema?: JSONSchema): JSONSchemaObj =>
  (schema === true || schema === undefined)
    ? {}
    : schema === false
    ? { not: true }
    : schema;

/**
 * Return the local-ref root for a schema child. In CFC schemas a subtree that
 * declares its own `$defs` starts a new `#/...` scope; otherwise local refs
 * continue to resolve against the inherited document root. Ref resolution may
 * attach the inherited `$defs` object to a standalone resolved view; sharing
 * that exact definitions object does not create another scope.
 */
export const cfcSchemaChildRoot = (
  schema: JSONSchema,
  inheritedRoot: JSONSchema,
): JSONSchema =>
  isObjectOrArray(schema) && isObjectOrArray(schema.$defs) &&
    !(isObjectOrArray(inheritedRoot) && schema.$defs === inheritedRoot.$defs)
    ? schema
    : inheritedRoot;

export const cfcSchemaIsInternalKey = (key: string): boolean =>
  key === "ifc" || key === "asCell" || key === "asStream" ||
  key === "scope";

export const cfcSchemaIsTrue = (schema: JSONSchema): boolean => {
  if (schema === true) {
    return true;
  }
  return isObjectOrArray(schema) &&
    Object.keys(schema).every((key) =>
      cfcSchemaIsInternalKey(key) || key === "default" || key === "$defs"
    );
};

export const cfcSchemaIsFalse = (schema: JSONSchema): boolean =>
  schema === false ||
  (isObjectOrArray(schema) && Object.hasOwn(schema, "not") &&
    cfcSchemaIsTrue(schema["not"]!));

const localDefinitionName = (schemaRef: string): string | undefined => {
  if (!schemaRef.startsWith("#")) return undefined;
  const path = decodeJsonPointer(schemaRef);
  return isRootDefsSchemaPointer(path) ? path[2] : undefined;
};

const encodedLocalDefinitionRef = (name: string): string =>
  encodeJsonPointer(["#", "$defs", name]);

const localDefinitionNamesInScope = (
  schema: JSONSchemaObj,
  definitions: SchemaDefinitions,
): Set<string> => {
  const names = new Set(Object.keys(definitions));
  const collect = (fragment: JSONSchema): void => {
    if (!isObjectOrArray(fragment)) return;
    if (typeof fragment.$ref === "string") {
      const name = localDefinitionName(fragment.$ref);
      if (name !== undefined) names.add(name);
    }
    forEachSubschema(fragment, (child) => {
      if (
        isObjectOrArray(child) && isObjectOrArray(child.$defs) &&
        child.$defs !== definitions
      ) return;
      collect(child);
    }, ALL_SUBSCHEMAS);
  };
  collect(schema);
  for (const definition of Object.values(definitions)) {
    if (
      isObjectOrArray(definition) && isObjectOrArray(definition.$defs) &&
      definition.$defs !== definitions
    ) continue;
    collect(definition);
  }
  return names;
};

/**
 * Namespace one flattened schema scope so its local refs cannot bind to names
 * owned by another scope. Children with their own `$defs` remain independent.
 */
const namespaceLocalDefinitionScope = (
  schema: JSONSchemaObj,
  definitions: SchemaDefinitions,
  reservedNames: ReadonlySet<string>,
): JSONSchemaObj => {
  const names = localDefinitionNamesInScope(schema, definitions);

  const usedNames = new Set([...reservedNames, ...names]);
  const renamed = new Map<string, string>();
  let suffix = 0;
  for (const name of [...names].toSorted(utf8Compare)) {
    let candidate: string;
    do candidate = `__cfc_ref_site_${suffix++}_${name}`; while (
      usedNames.has(candidate)
    );
    usedNames.add(candidate);
    renamed.set(name, candidate);
  }

  const rewrite = (fragment: JSONSchema): JSONSchema => {
    if (!isObjectOrArray(fragment)) return fragment;
    let result = fragment;
    if (typeof fragment.$ref === "string") {
      const name = localDefinitionName(fragment.$ref);
      const nextName = name === undefined ? undefined : renamed.get(name);
      if (nextName !== undefined) {
        result = { ...result, $ref: encodedLocalDefinitionRef(nextName) };
      }
    }
    return mapSubschemas(
      result,
      (child) =>
        isObjectOrArray(child) && isObjectOrArray(child.$defs) &&
          child.$defs !== definitions
          ? child
          : rewrite(child),
      ALL_SUBSCHEMAS,
    );
  };

  const rewritten = rewrite(schema) as JSONSchemaObj;
  const rewrittenDefinitions = Object.fromEntries(
    Object.entries(definitions).map(([name, definition]) => [
      renamed.get(name)!,
      isObjectOrArray(definition) && isObjectOrArray(definition.$defs) &&
        definition.$defs !== definitions
        ? definition
        : rewrite(definition),
    ]),
  );
  return { ...rewritten, $defs: rewrittenDefinitions };
};

const addRefs = (target: Set<string>, source: ReadonlySet<string>): void => {
  for (const ref of source) target.add(ref);
};

const summarizeCfcSchemaRefs = (schema: JSONSchema): SchemaRefSummary => {
  if (!isObjectOrArray(schema)) return EMPTY_REF_SUMMARY;
  const cached = schemaRefSummaryCache.get(schema);
  if (cached !== undefined) return cached;

  const all = new Set<string>();
  const localDefinitions = new Set<string>();
  if (schema.$ref !== undefined) {
    all.add(schema.$ref);
    const name = localDefinitionName(schema.$ref);
    if (name !== undefined) localDefinitions.add(name);
  }
  forEachSubschema(schema, (child) => {
    const childSummary = summarizeCfcSchemaRefs(child);
    addRefs(all, childSummary.all);
    // A child carrying its own `$defs` starts a new local-ref scope. Its refs
    // still count for the public findRefs() walk, but must not retain names in
    // the parent's definition map.
    if (!(isObjectOrArray(child) && child.$defs !== undefined)) {
      addRefs(localDefinitions, childSummary.localDefinitions);
    }
  }, ALL_SUBSCHEMAS);

  const summary: SchemaRefSummary = {
    all: all.size === 0 ? EMPTY_REFS : all,
    localDefinitions: localDefinitions.size === 0
      ? EMPTY_REFS
      : localDefinitions,
  };
  if (isDeepFrozen(schema)) schemaRefSummaryCache.set(schema, summary);
  return summary;
};

export const findCfcSchemaRefs = (
  schema: JSONSchema,
  refSet: Set<string> = new Set<string>(),
): void => {
  addRefs(refSet, summarizeCfcSchemaRefs(schema).all);
};

const definitionIndexFor = (
  definitions: SchemaDefinitions,
): { index: DefinitionIndex; cacheable: boolean } => {
  const cacheable = isDeepFrozen(definitions);
  if (!cacheable) {
    return {
      index: { dependencies: new Map(), subsets: new Map() },
      cacheable,
    };
  }
  let index = definitionIndexCache.get(definitions);
  if (index === undefined) {
    index = { dependencies: new Map(), subsets: new Map() };
    definitionIndexCache.set(definitions, index);
  }
  return { index, cacheable };
};

const definitionDependencies = (
  name: string,
  definitions: SchemaDefinitions,
  index: DefinitionIndex,
): ReadonlySet<string> => {
  const cached = index.dependencies.get(name);
  if (cached !== undefined) return cached;
  const definition = definitions[name];
  // resolveCfcSchemaRef() attaches the containing definition map to a reached
  // definition body. Nested children with their own `$defs` remain scope
  // boundaries (captured by `summary.localDefinitions`), but refs local to the
  // definition body itself therefore depend on this containing map.
  const dependencies = definition === undefined
    ? EMPTY_REFS
    : summarizeCfcSchemaRefs(definition).localDefinitions;
  index.dependencies.set(name, dependencies);
  return dependencies;
};

const definitionSetKey = (names: readonly string[]): string => {
  let key = "";
  for (const name of names) key += `${name.length}:${name}`;
  return key;
};

/**
 * Return the minimal active `$defs` map needed by `schema`'s local refs.
 *
 * Definition bodies are scanned lazily and only when reachable. Frozen schema
 * fragments populate reusable ref summaries bottom-up, while frozen definition
 * maps reuse dependency closures and canonical subset objects across callers.
 */
export const selectReferencedCfcSchemaDefs = (
  schema: JSONSchema,
  inheritedDefinitions?: SchemaDefinitions,
): SchemaDefinitions | undefined => {
  if (!isObjectOrArray(schema)) return undefined;
  const definitions = isObjectOrArray(schema.$defs)
    ? schema.$defs
    : inheritedDefinitions;
  if (definitions === undefined) return undefined;

  const initial = summarizeCfcSchemaRefs(schema).localDefinitions;
  if (initial.size === 0) return undefined;

  const { index, cacheable } = definitionIndexFor(definitions);
  const needed = new Set<string>();
  const pending = [...initial];
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (needed.has(name) || !Object.hasOwn(definitions, name)) continue;
    needed.add(name);
    for (
      const dependency of definitionDependencies(
        name,
        definitions,
        index,
      )
    ) {
      if (!needed.has(dependency)) pending.push(dependency);
    }
  }
  if (needed.size === 0) return undefined;

  const names = [...needed].toSorted(utf8Compare);
  const key = definitionSetKey(names);
  if (cacheable) {
    const cached = index.subsets.get(key);
    if (cached !== undefined) return cached;
  }

  const subset = Object.fromEntries(
    names.map((name) => [name, definitions[name]]),
  ) as Record<string, JSONSchema>;
  if (!cacheable) return subset;

  // Intern once so every derived schema sharing this closure also shares one
  // frozen, deterministically ordered `$defs` object.
  const holder = internSchema({ $defs: subset });
  const canonical = (holder as JSONSchemaObj).$defs!;
  index.subsets.set(key, canonical);
  return canonical;
};

const pruneCfcSchemaDefinitionsInternal = (
  schema: JSONSchema,
  preserveScopeBoundary: boolean,
): JSONSchema => {
  // A boolean schema, and anything a schema cannot be, has no definitions to
  // prune and is returned as it arrived.
  if (!isObjectOrArray(schema)) return schema;
  const cacheable = isDeepFrozen(schema);
  const cache = preserveScopeBoundary
    ? prunedScopedSchemaCache
    : prunedRootSchemaCache;
  if (cacheable) {
    const cached = cache.get(schema);
    if (cached !== undefined) return cached;
  }

  let result = mapSubschemas(
    schema,
    (child) => pruneCfcSchemaDefinitionsInternal(child, true),
    ALL_SUBSCHEMAS,
  );
  // Only a `$defs` that is a definition map is pruned, the same test
  // `cfcSchemaChildRoot` uses to decide whether one opens a definition scope.
  if (isObjectOrArray(schema.$defs)) {
    const selected = selectReferencedCfcSchemaDefs(schema);
    let definitions = selected ??
      (preserveScopeBoundary ? EMPTY_DEFINITIONS : undefined);
    if (selected !== undefined) {
      let entries: [string, JSONSchema][] | undefined;
      const selectedEntries = Object.entries(selected);
      for (let index = 0; index < selectedEntries.length; index++) {
        const [name, definition] = selectedEntries[index];
        const pruned = pruneCfcSchemaDefinitionsInternal(definition, true);
        if (pruned !== definition) {
          entries ??= selectedEntries;
          entries[index] = [name, pruned];
        }
      }
      if (entries !== undefined) definitions = Object.fromEntries(entries);
    }
    if (definitions !== schema.$defs) {
      const next = { ...result } as Record<string, unknown>;
      delete next.$defs;
      if (definitions !== undefined) next.$defs = definitions;
      result = next as JSONSchemaObj;
    }
  }
  const pruned = cacheable && result !== schema ? internSchema(result) : result;
  if (cacheable) cache.set(schema, pruned);
  return pruned;
};

/** Remove definitions that cannot be reached from this schema document. */
export const pruneCfcSchemaDefinitions = (schema: JSONSchema): JSONSchema =>
  pruneCfcSchemaDefinitionsInternal(schema, false);

// Member views of cyclic-group documents, per document per member name. A
// fragment ref resolves to the member with the group's `$defs` attached (so
// its internal refs keep a scope), and that view is minted once so downstream
// identity-keyed caches see one object rather than a fresh spread per
// resolution. Documents are interned before entering the registry, so keying
// weakly on the document is stable.
let memberViewCache = new WeakMap<
  JSONSchemaObj,
  Map<string, JSONSchema | undefined>
>();
// Both caches memoize resolution SUCCESSES that embed registry content, so
// a registry clear (last lease out) swaps them for empty ones — a success
// cached in one lease epoch must not keep resolving in the next.
onSchemaRegistryClear(() => {
  memberViewCache = new WeakMap();
  resolvedRefsCache = new WeakMap();
});

/**
 * Resolve an external `cid:` ref through the schema-document registry.
 * Returns `undefined` on a miss — an unregistered document may still
 * arrive, which is exactly why the arrival-curable misses bump the
 * external-resolution miss counter: derived caches memoize only across a
 * derivation the counter did not move in.
 */
const resolveExternalCfcSchemaRef = (
  parsed: ExternalSchemaRef,
): JSONSchema | undefined => {
  const document = lookupSchemaDocument(parsed.taggedHash);
  if (document === undefined) {
    noteExternalResolutionMiss();
    logger.debug("cfc", () => [
      "Schema document not (yet) registered: ",
      parsed.taggedHash,
    ]);
    return undefined;
  }
  // An incomplete closure is a miss, exactly like an unregistered root:
  // resolving the root while a child is absent would let derived caches
  // (IFC scans, standardized forms) memoize a result computed over a hole,
  // keyed by the root's stable identity — and the child's later arrival
  // would never invalidate them. Completeness is monotonic, so this gate
  // opens by itself once the closure lands.
  if (!isSchemaDocumentClosureComplete(parsed.taggedHash)) {
    noteExternalResolutionMiss();
    logger.debug("cfc", () => [
      "Schema document closure not (yet) complete: ",
      parsed.taggedHash,
    ]);
    return undefined;
  }
  if (parsed.defName === undefined) return document;
  // A definition map is a non-array record; an array here would resolve
  // indices as member names.
  if (!isObjectNotArray(document) || !isObjectNotArray(document.$defs)) {
    logger.warn("cfc", () => [
      "Fragment ref into a schema document without `$defs`: ",
      parsed.taggedHash,
    ]);
    return undefined;
  }
  let views = memberViewCache.get(document);
  if (views === undefined) {
    views = new Map();
    memberViewCache.set(document, views);
  }
  if (views.has(parsed.defName)) return views.get(parsed.defName);
  const member = Object.hasOwn(document.$defs, parsed.defName)
    ? document.$defs[parsed.defName]
    : undefined;
  let view: JSONSchema | undefined;
  if (member === undefined || !isSubschema(member)) {
    logger.warn("cfc", () => [
      "Fragment ref names no member of its schema document: ",
      `${parsed.taggedHash}#/$defs/${parsed.defName}`,
    ]);
    view = undefined;
  } else if (isObjectOrArray(member) && member.$defs === undefined) {
    // Same rule as resolveCfcSchemaRefUncached: only local refs need the
    // group's definition scope attached.
    view = summarizeCfcSchemaRefs(member).localDefinitions.size > 0
      ? internSchema({ ...member, $defs: document.$defs })
      : member;
  } else {
    view = member;
  }
  views.set(parsed.defName, view);
  return view;
};

export const resolveCfcSchemaRef = (
  fullSchema: JSONSchema,
  schemaRef: string,
): JSONSchema | undefined => {
  if (Object.hasOwn(embeddedSchemas, schemaRef)) {
    return embeddedSchemas[schemaRef];
  }
  // External refs resolve through the registry and bypass the per-root cache
  // entirely: a hit is already one probe, and a MISS must never be memoized —
  // the document can arrive after the first failed lookup.
  const external = parseExternalSchemaRef(schemaRef);
  if (external !== undefined) return resolveExternalCfcSchemaRef(external);
  const cacheable = isObjectOrArray(fullSchema) && isDeepFrozen(fullSchema);
  if (cacheable) {
    const byRef = resolvedRefCache.get(fullSchema);
    if (byRef !== undefined && byRef.has(schemaRef)) {
      return byRef.get(schemaRef);
    }
  }
  const result = resolveCfcSchemaRefUncached(fullSchema, schemaRef);
  if (cacheable) {
    let byRef = resolvedRefCache.get(fullSchema as object);
    if (byRef === undefined) {
      byRef = new Map();
      resolvedRefCache.set(fullSchema as object, byRef);
    }
    byRef.set(schemaRef, result);
  }
  return result;
};

/** Return the owning schema root after following a ref chain. */
export const resolveCfcSchemaRefRoot = (
  schema: JSONSchema,
  fullSchema: JSONSchema,
): JSONSchema => {
  let current = schema;
  let root = fullSchema;
  const seenRefs = new Map<JSONSchema, Set<string>>();
  while (isObjectOrArray(current) && typeof current.$ref === "string") {
    const ref = current.$ref;
    let refsForRoot = seenRefs.get(root);
    if (refsForRoot?.has(ref)) break;
    if (!refsForRoot) {
      refsForRoot = new Set();
      seenRefs.set(root, refsForRoot);
    }
    refsForRoot.add(ref);
    const next = resolveCfcSchemaRef(root, ref);
    if (next === undefined) break;
    // An embedded or external target is its own document: local refs inside
    // it must bind to its scope, never to the referrer's.
    const inheritedRoot =
      isEmbeddedCfcSchemaRef(ref) || isExternalSchemaRef(ref) ? next : root;
    root = cfcSchemaChildRoot(next, inheritedRoot);
    current = next;
  }
  return root;
};

const resolveCfcSchemaRefUncached = (
  fullSchema: JSONSchema,
  schemaRef: string,
): JSONSchema | undefined => {
  if (!schemaRef.startsWith("#")) {
    logger.warn("cfc", () => ["Unsupported $ref in schema: ", schemaRef]);
    return undefined;
  }
  const pathToDef = decodeJsonPointer(schemaRef);
  if (pathToDef[0] !== "#") {
    logger.warn(
      "cfc",
      () => ["Unsupported anchor $ref in schema: ", schemaRef],
    );
    return undefined;
  }
  if (!isRootDefsSchemaPointer(pathToDef)) {
    logger.warn("cfc", () => [
      "Unsupported local $ref in schema (only #/$defs/<name> is supported): ",
      schemaRef,
    ]);
    return undefined;
  }
  let schemaCursor: unknown = fullSchema;
  for (let i = 1; i < pathToDef.length; i++) {
    if (
      !isObjectOrArray(schemaCursor) ||
      !Object.hasOwn(schemaCursor, pathToDef[i])
    ) {
      logger.warn("cfc", () => [
        "Unresolved $ref in schema: ",
        schemaRef,
        fullSchema,
      ]);
      return undefined;
    }
    schemaCursor = schemaCursor[pathToDef[i]];
  }
  if (!isSubschema(schemaCursor)) {
    // A definition holding something a schema cannot be resolves no better than
    // a name the document does not carry.
    logger.warn("cfc", () => [
      "Non-schema target for $ref in schema: ",
      schemaRef,
      fullSchema,
    ]);
    return undefined;
  }
  if (isObjectOrArray(schemaCursor)) {
    // Only LOCAL refs need the containing document's definition scope;
    // embedded and external refs resolve against their own documents, so a
    // target carrying only those stays as it is.
    const { localDefinitions } = summarizeCfcSchemaRefs(schemaCursor);
    if (localDefinitions.size > 0 && schemaCursor.$defs === undefined) {
      schemaCursor = {
        ...schemaCursor,
        ...(isObjectOrArray(fullSchema) && fullSchema.$defs &&
          { $defs: fullSchema.$defs }),
      };
    }
  }
  return schemaCursor as JSONSchema;
};

// resolveCfcSchemaRefs results per (frozen schemaObj, frozen fullSchema)
// identity pair. The loop body builds a fresh `{...resolved, ...rest, $defs}`
// spread whenever a $ref schema carries extra keys (e.g. `{$ref, $defs}` —
// the rendererVDOMSchema read path), and that fresh object then re-paid a
// full content hash at downstream interning on every read. A sentinel marks
// `undefined` results so failed resolutions are memoized too.
const RESOLVED_UNDEFINED = Symbol("resolved-undefined");
let resolvedRefsCache = new WeakMap<
  object,
  WeakMap<object, JSONSchema | typeof RESOLVED_UNDEFINED>
>();

export const resolveCfcSchemaRefs = (
  schemaObj: JSONSchemaObj,
  fullSchema: JSONSchema = schemaObj,
): JSONSchema | undefined => {
  const cacheable = isDeepFrozen(schemaObj) &&
    (fullSchema === schemaObj ||
      (isObjectOrArray(fullSchema) && isDeepFrozen(fullSchema)));
  let byFull: WeakMap<object, JSONSchema | typeof RESOLVED_UNDEFINED>;
  if (cacheable) {
    const fullKey = fullSchema as object;
    let existing = resolvedRefsCache.get(schemaObj);
    if (existing === undefined) {
      existing = new WeakMap();
      resolvedRefsCache.set(schemaObj, existing);
    }
    byFull = existing;
    const cached = byFull.get(fullKey);
    if (cached !== undefined) {
      return cached === RESOLVED_UNDEFINED ? undefined : cached;
    }
    // Intern the result so the cached instance is canonical and frozen —
    // downstream identity-keyed caches then hit, and sharing it across callers
    // is safe. Primitive and `undefined` results intern to themselves.
    const missesBefore = externalResolutionMissCount();
    const raw = resolveCfcSchemaRefsUncached(schemaObj, fullSchema);
    const result = internSchema(raw);
    if (externalResolutionMissCount() !== missesBefore) {
      // A `cid:` resolution missed during this walk; the document can
      // arrive later, so nothing from this run may be pinned.
      return result;
    }
    byFull.set(fullKey, result === undefined ? RESOLVED_UNDEFINED : result);
    return result;
  }
  return resolveCfcSchemaRefsUncached(schemaObj, fullSchema);
};

const resolveCfcSchemaRefsUncached = (
  schemaObj: JSONSchemaObj,
  fullSchema: JSONSchema = schemaObj,
): JSONSchema | undefined => {
  const seenRefs = new Map<JSONSchema, Set<string>>();
  const pendingSiblings: {
    schema: JSONSchemaObj;
    root: JSONSchema;
  }[] = [];
  const mergePendingSiblings = (
    initial: JSONSchema,
    initialRoot: JSONSchema,
  ): JSONSchema => {
    let resolved = initial;
    let resolvedRoot = initialRoot;
    while (pendingSiblings.length > 0) {
      const { schema: siblings, root: siblingRoot } = pendingSiblings.pop()!;
      if (isObjectOrArray(resolved)) {
        const resolvedDefinitions = resolved.$defs ??
          (isObjectOrArray(resolvedRoot) ? resolvedRoot.$defs : undefined);
        let scopedSiblings = siblings;
        let siblingDefinitions = isObjectOrArray(siblingRoot)
          ? siblingRoot.$defs
          : undefined;
        if (siblingRoot !== resolvedRoot) {
          // `$ref` targets and ref-site siblings own different local-definition
          // scopes. Namespace even an empty ref-site definition map: its
          // unresolved local refs must not begin resolving against target defs
          // merely because the two scopes are flattened into one object.
          const targetDefinitions = isObjectOrArray(resolvedDefinitions)
            ? resolvedDefinitions
            : {};
          const refSiteDefinitions = isObjectOrArray(siblingDefinitions)
            ? siblingDefinitions
            : {};
          scopedSiblings = namespaceLocalDefinitionScope(
            siblings,
            refSiteDefinitions,
            localDefinitionNamesInScope(resolved, targetDefinitions),
          );
          siblingDefinitions = scopedSiblings.$defs;
        }
        // A flattened resolved view has one `$defs` slot even though refs in
        // the target and in its ref-site siblings originate in different
        // document scopes. Ref-site names are namespaced above, leaving the
        // target's existing names authoritative.
        const definitions = isObjectOrArray(resolvedDefinitions) &&
            isObjectOrArray(siblingDefinitions) &&
            resolvedDefinitions !== siblingDefinitions
          ? { ...siblingDefinitions, ...resolvedDefinitions }
          : resolvedDefinitions ?? siblingDefinitions;
        resolved = {
          ...resolved,
          ...scopedSiblings,
          ...(definitions !== undefined && { $defs: definitions }),
        } as JSONSchemaObj;
      } else {
        resolved = {
          ...cfcSchemaToObject(resolved),
          ...siblings,
        } as JSONSchemaObj;
      }
      resolvedRoot = cfcSchemaChildRoot(resolved, resolvedRoot);
    }
    return resolved;
  };
  while (true) {
    const { $ref, ...rest } = schemaObj;
    if ($ref === undefined) {
      return mergePendingSiblings(schemaObj, fullSchema);
    }
    let refsForRoot = seenRefs.get(fullSchema);
    if (refsForRoot?.has($ref)) {
      return undefined;
    }
    if (!refsForRoot) {
      refsForRoot = new Set();
      seenRefs.set(fullSchema, refsForRoot);
    }
    refsForRoot.add($ref);
    const resolved = resolveCfcSchemaRef(fullSchema, $ref);
    if (resolved === undefined) {
      return undefined;
    }
    // As in resolveCfcSchemaRefRoot: an embedded or external target owns its
    // definition scope.
    const inheritedRoot =
      Object.hasOwn(embeddedSchemas, $ref) || isExternalSchemaRef($ref)
        ? resolved
        : fullSchema;
    const resolvedRoot = cfcSchemaChildRoot(resolved, inheritedRoot);
    if (Object.keys(rest).length > 0) {
      // Delay ref-site siblings until the referenced target's own ref chain is
      // resolved in its local definition scope. Unwinding then establishes
      // the ref-site `$defs` scope without rebinding an intermediate target.
      const siblings = rest as JSONSchemaObj;
      pendingSiblings.push({
        schema: siblings,
        root: cfcSchemaChildRoot(siblings, fullSchema),
      });
    }
    if (typeof resolved === "boolean") {
      return mergePendingSiblings(resolved, resolvedRoot);
    }
    schemaObj = resolved;
    fullSchema = resolvedRoot;
  }
};

export const resolveCfcSchemaRefsOrThrow = (
  schemaObj: JSONSchemaObj,
  fullSchema: JSONSchema = schemaObj,
): JSONSchema => {
  if (!isObjectOrArray(fullSchema)) {
    throw new Error("Found $ref without fullSchema object");
  }
  const resolved = resolveCfcSchemaRefs(schemaObj, fullSchema);
  if (resolved === undefined) {
    const ref = Object.hasOwn(schemaObj, "$ref")
      ? schemaObj.$ref
      : toCompactDebugString(
        schemaObj,
      );
    throw new Error(
      `Failed to resolve $ref: ${ref}. ` +
        (typeof ref === "string" && ref.startsWith("http")
          ? `External $ref URLs must be registered in embeddedSchemas (packages/runner/src/embedded-schemas.ts). ` +
            `If you added a new native type to NATIVE_TYPE_SCHEMAS in ` +
            `packages/schema-generator/src/formatters/native-type-formatter.ts, ` +
            `add its schema to embeddedSchemas as well.`
          : `Schema: ${toCompactDebugString(schemaObj)}`),
    );
  }
  return resolved;
};
