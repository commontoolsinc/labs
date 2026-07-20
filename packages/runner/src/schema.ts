import { AnyCellWrapping } from "@commonfabric/api";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { getLogger } from "@commonfabric/utils/logger";
import { Immutable, isRecord } from "@commonfabric/utils/types";
import { storedCfcMetadataAppliesToPath } from "./cfc/metadata.ts";
import { ContextualFlowControl } from "./cfc.ts";
import { type JSONSchema } from "./builder/types.ts";
import type { JSONSchemaObj, JSONValue } from "@commonfabric/api";
import {
  cloneIfNecessary,
  type FabricValue,
  shallowMutableClone,
} from "@commonfabric/data-model/fabric-value";
import { isDeepFrozen } from "@commonfabric/data-model/deep-freeze";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import {
  isNontrivialSchema,
  schemaWithProperties,
} from "@commonfabric/data-model/schema-utils";
import { createCell, isCell } from "./cell.ts";
import { readMaybeLink, resolveLink } from "./link-resolution.ts";
import {
  type IExtendedStorageTransaction,
  toThrowable,
} from "./storage/interface.ts";
import { getTransactionForChildCells } from "./storage/extended-storage-transaction.ts";
import { type Runtime } from "./runtime.ts";
import {
  type IMemorySpaceValueAddress,
  type NormalizedFullLink,
} from "./link-utils.ts";
import {
  createQueryResultProxy,
  isCellResultForDereferencing,
} from "./query-result-proxy.ts";
import { toCell } from "./back-to-cell.ts";
import {
  canBranchMatch,
  combineSchema,
  createDefaultTraversalContext,
  IObjectCreator,
  mergeAnyOfMatches,
  mergeSchemaFlags,
  SchemaObjectTraverser,
} from "@commonfabric/runner/traverse";
import { ignoreReadForScheduling } from "./scheduler.ts";
import { internalVerifierRead } from "./storage/reactivity-log.ts";
import { toMemorySpaceAddress } from "../src/link-utils.ts";
import {
  type CfcLabelView,
  cfcLabelViewForDereference,
  cfcLabelViewForDereferenceTraces,
  cloneCfcLabelView,
  mergeCfcLabelViews,
  rebaseCfcLabelView,
} from "./cfc/label-view-state.ts";
import type { CfcAddress } from "./cfc/types.ts";
import { isCellScope } from "./scope.ts";
import {
  cfcSchemaChildRoot,
  resolveCfcSchemaRefRoot,
} from "./cfc/schema-refs.ts";

const logger = getLogger("validateAndTransform", {
  enabled: true,
  level: "debug",
});

const cfcAddressFromLink = (link: NormalizedFullLink): CfcAddress => ({
  space: link.space,
  id: link.id,
  scope: link.scope,
  path: [...link.path],
});

// Creation-only: stamp the asCell entry's declared scope onto a newly created
// cell's link. Never use this on a link that was followed/resolved during a
// read — there the link's own storage-resolved scope is authoritative and
// schema scope acts only as a follow cap (see link-resolution.ts).
const linkWithAsCellScope = (
  link: NormalizedFullLink,
  entry:
    | ReturnType<typeof ContextualFlowControl.getAsCellValues>[number]
    | undefined,
): NormalizedFullLink => {
  const scope = ContextualFlowControl.getAsCellScope(entry);
  return isCellScope(scope) ? { ...link, scope } : link;
};

// Value-independent part of asCellCompoundSchemaForValue: the merged
// candidate schemas (those that carry asCell entries) for each anyOf/oneOf
// branch. Building them spreads the base schema and resolves + combines +
// interns every branch — and that repeats on EVERY read of a cell with a
// compound schema (e.g. every vdom node under rendererVDOMSchema), which
// CPU profiles showed as the dominant hashing seam of reconciler mounts.
// Cache per deep-frozen schema identity; mutable schemas recompute per call.
// The cached candidates are interned (combineSchema interns its results), so
// downstream identity-keyed memos see stable references too.
const compoundAsCellCandidatesCache = new WeakMap<
  JSONSchemaObj,
  readonly JSONSchemaObj[]
>();

const asCellCompoundCandidates = (
  schema: JSONSchemaObj,
): readonly JSONSchemaObj[] => {
  const cacheable = isDeepFrozen(schema);
  if (cacheable) {
    const cached = compoundAsCellCandidatesCache.get(schema);
    if (cached !== undefined) return cached;
  }
  const branches = [
    ...(Array.isArray(schema.anyOf) ? schema.anyOf : []),
    ...(Array.isArray(schema.oneOf) ? schema.oneOf : []),
  ];
  const candidates: JSONSchemaObj[] = [];
  if (branches.length > 0) {
    const { anyOf: _anyOf, oneOf: _oneOf, ...baseSchema } = schema;
    for (const branch of branches) {
      const branchWithDefs = branchWithParentDefs(schema, branch);
      const resolved = resolveSchema(branchWithDefs) ?? branchWithDefs;
      const merged = combineSchema(baseSchema as JSONSchemaObj, resolved);
      if (
        isRecord(merged) &&
        ContextualFlowControl.getAsCellValues(merged).length > 0
      ) {
        candidates.push(merged as JSONSchemaObj);
      }
    }
  }
  if (cacheable) {
    compoundAsCellCandidatesCache.set(schema, candidates);
  }
  return candidates;
};

const asCellCompoundSchemaForValue = (
  schema: JSONSchemaObj,
  value: unknown,
): JSONSchemaObj | undefined => {
  if (value === undefined) {
    return undefined;
  }
  for (const merged of asCellCompoundCandidates(schema)) {
    if (matchesConcreteValue(merged, value)) {
      return merged;
    }
  }
  return undefined;
};

export type CellViewRef = {
  link: NormalizedFullLink;
  cfcLabelView?: CfcLabelView;
};

const isCellViewRef = (
  ref: NormalizedFullLink | CellViewRef,
): ref is CellViewRef => isRecord(ref) && "link" in ref;

const isPrefix = (
  prefix: readonly string[],
  path: readonly string[],
): boolean =>
  prefix.length <= path.length &&
  prefix.every((segment, index) => segment === path[index]);

const labelViewForLink = (
  baseLink: NormalizedFullLink,
  baseView: CfcLabelView | undefined,
  link: NormalizedFullLink,
): CfcLabelView | undefined => {
  if (
    baseLink.space === link.space &&
    baseLink.id === link.id &&
    isPrefix(baseLink.path, link.path)
  ) {
    return rebaseCfcLabelView(baseView, link.path.slice(baseLink.path.length));
  }
  return rebaseCfcLabelView(baseView, link.path);
};

const containsLocalRef = (
  schema: JSONSchema,
  seen: Set<JSONSchema> = new Set(),
): boolean => {
  if (!isRecord(schema) || seen.has(schema)) {
    return false;
  }
  seen.add(schema);
  if (typeof schema.$ref === "string" && schema.$ref.startsWith("#/")) {
    return true;
  }
  return Object.entries(schema).some(([key, value]) => {
    if (key === "$defs" || key === "definitions") {
      return false;
    }
    if (Array.isArray(value)) {
      return value.some((item) => containsLocalRef(item as JSONSchema, seen));
    }
    return containsLocalRef(value as JSONSchema, seen);
  });
};

const branchWithParentDefs = (
  parent: JSONSchemaObj,
  branch: JSONSchema,
): JSONSchema => {
  if (
    !isRecord(branch) ||
    branch.$defs !== undefined ||
    !isRecord(parent.$defs) ||
    !containsLocalRef(branch)
  ) {
    return branch;
  }
  return {
    ...branch,
    $defs: parent.$defs,
  } satisfies JSONSchemaObj;
};

const matchesConcreteValue = (
  schema: JSONSchema,
  value: unknown,
): boolean => {
  if (schema === false) {
    return false;
  }
  const resolved = resolveSchema(schema);
  if (resolved === undefined) {
    return true;
  }
  if (typeof resolved === "boolean") {
    return resolved;
  }
  if (!canBranchMatch(resolved, value)) {
    return false;
  }
  // TODO(danfuzz): Latent — schemas don't admit `Fabric*` values on this
  // validation path today, but will in the not-too-distant future; at that
  // point these `deepEqual(const/enum, value)` checks mishandle a
  // `FabricValue` (same-class `FabricPrimitive`s compare equal regardless of
  // value). Mark ahead of that; use a Fabric-aware equality when the path
  // becomes live.
  if (resolved.const !== undefined && !deepEqual(resolved.const, value)) {
    return false;
  }
  if (
    Array.isArray(resolved.enum) &&
    !resolved.enum.some((candidate) => deepEqual(candidate, value))
  ) {
    return false;
  }

  if (Array.isArray(resolved.anyOf)) {
    const { anyOf, ...rest } = resolved;
    return anyOf.some((branch) =>
      matchesConcreteValue(
        combineSchema(
          rest as JSONSchemaObj,
          resolveSchema(branchWithParentDefs(resolved, branch)) ??
            branchWithParentDefs(resolved, branch),
        ),
        value,
      )
    );
  }
  if (Array.isArray(resolved.oneOf)) {
    const { oneOf, ...rest } = resolved;
    return oneOf.filter((branch) =>
      matchesConcreteValue(
        combineSchema(
          rest as JSONSchemaObj,
          resolveSchema(branchWithParentDefs(resolved, branch)) ??
            branchWithParentDefs(resolved, branch),
        ),
        value,
      )
    ).length === 1;
  }

  if (isRecord(value) && isRecord(resolved.properties)) {
    return Object.entries(resolved.properties).every(([key, childSchema]) =>
      value[key] === undefined ||
      matchesConcreteValue(
        branchWithParentDefs(resolved, childSchema),
        value[key],
      )
    );
  }

  if (
    Array.isArray(value) && typeof resolved.items === "object" &&
    resolved.items !== null
  ) {
    const itemSchema = branchWithParentDefs(resolved, resolved.items);
    return value.every((item) => matchesConcreteValue(itemSchema, item));
  }

  return true;
};

/**
 * Schemas are mostly a subset of JSONSchema.
 *
 * One addition is `asCell`. When true, the `.get()` returns an instance of
 * `Cell`, i.e. a reactive reference to the value underneath. Some implications
 * this has:
 *  - The cell reflects as closely as possible the current value. So it doesn't
 *    change when the underlying reference changes. This is useful to e.g. to
 *    read the current value of "currently selected item" and keep that constant
 *    even if in the future another item is selected. NOTE:
 *    - For this to work, the underlying value should be a reference itself.
 *      Otherwise the closest parent document is used, so that e.g. reading
 *      current.name tracks changes on current.
 *    - If the value is an alias, aliases are followed first and the cell is
 *      based on the first non-alias value. This is because writes will follow
 *      aliases as well.
 *
 * `asCell` can also be an array, so it can indicate a `Cell<Cell<T>>` or
 * capture other options like opaque or stream types.
 *
 * Calling `effect` on returned cells within a higher-level `effect` works as
 * expected. Be sure to track the cancels, though. (Tracking cancels isn't
 * necessary when using the schedueler directly)
 */

/**
 * Resolve a schema to its canonical interned form, or `undefined` when the
 * input carries no usable information.
 *
 * The return value is the **canonical interned reference** for the resolved
 * schema's structural content — produced by `internSchema()`. Concrete
 * consequences of that contract:
 *
 * - For structurally-equal schemas, `resolveSchema()` returns the same
 *   reference across calls. Downstream identity-based caches
 *   (`schemaHasIfc`'s memo, `standardizedSchemaCache`, hashSchema WeakMaps,
 *   the `resolveLink`-exit canonicalization, etc.) hit O(1) on those
 *   returns without needing to rehash.
 * - The return value is **not** guaranteed to be the same reference as the
 *   caller-supplied `schema`, even when the caller's schema is already
 *   deep-frozen. A caller-frozen schema that happens to be content-equal
 *   to an already-interned instance is replaced by the canonical one.
 * - When the caller supplies a schema that **is** itself the canonical
 *   interned instance, the same reference is returned (because
 *   `internSchema()` short-circuits on WeakMap hit).
 * - `undefined` is returned for trivial inputs (`undefined`, `null`, `{}`,
 *   non-object) and for `$ref`-chains that resolve to a boolean or
 *   trivial schema.
 *
 * Callers that need a stable reference across calls should therefore rely
 * on structural canonicalization (same content yields same reference)
 * rather than caller-identity preservation. This is the same contract the
 * `resolveLink()` exit follows (see `link-resolution.ts`).
 */
export function resolveSchema(
  schema: JSONSchema | undefined,
): JSONSchema | undefined {
  // Treat undefined/null/{} or any other non-object as no schema
  // We don't use ContextualFlowControl.isTrueSchema here, since we want to
  // handle flags like default or ifc
  if (!isNontrivialSchema(schema)) {
    return undefined;
  }

  let resolvedSchema = schema;
  if (typeof schema.$ref === "string") {
    const resolved = ContextualFlowControl.resolveSchemaRefs(schema);
    if (!isRecord(resolved)) {
      // For boolean schema or the default `{}` schema, we don't have any
      // meaningful information in the schema, so just return undefined.
      return undefined;
    }
    resolvedSchema = resolved;
  }

  // Return no schema if all it said is that this was a reference or an
  // object without properties. Intern here (rather than just
  // deep-freezing) so structurally-equal schemas collapse to a single
  // canonical reference across calls — see the contract above.
  return isNontrivialSchema(resolvedSchema)
    ? internSchema(resolvedSchema)
    : undefined;
}

const selectMatchingCompoundBranch = (
  schema: JSONSchemaObj,
  value: unknown,
  kind: "anyOf" | "oneOf",
): JSONSchema | undefined => {
  const branches = schema[kind];
  if (!Array.isArray(branches) || branches.length === 0) {
    return undefined;
  }

  const { [kind]: _compound, ...rest } = schema;
  const baseSchema = rest as JSONSchemaObj;
  const matches = branches.flatMap((branch) => {
    const resolvedBranch =
      resolveSchema(branchWithParentDefs(schema, branch)) ??
        branchWithParentDefs(schema, branch);
    const merged = combineSchema(baseSchema, resolvedBranch);
    return matchesConcreteValue(merged, value) ? [merged] : [];
  });

  return matches.length === 1 ? matches[0] : undefined;
};

export function resolveSchemaForValue(
  schema: JSONSchema | undefined,
  value: unknown,
): JSONSchema | undefined {
  const resolved = resolveSchema(schema);
  if (
    resolved === undefined || typeof resolved === "boolean" ||
    !isRecord(resolved)
  ) {
    return resolved;
  }

  let narrowed: JSONSchema = resolved;
  if (Array.isArray(resolved.anyOf)) {
    narrowed = selectMatchingCompoundBranch(resolved, value, "anyOf") ??
      resolved;
  } else if (Array.isArray(resolved.oneOf)) {
    narrowed = selectMatchingCompoundBranch(resolved, value, "oneOf") ??
      resolved;
  }

  if (!isRecord(narrowed)) {
    return narrowed;
  }

  if (!isRecord(value) || !isRecord(narrowed.properties)) {
    return narrowed;
  }

  let changed = false;
  const nextProperties: Record<string, JSONSchema> = {
    ...narrowed.properties,
  };
  for (const [key, childSchema] of Object.entries(narrowed.properties)) {
    const childValue = value[key];
    const resolvedChild = resolveSchemaForValue(
      branchWithParentDefs(narrowed, childSchema),
      childValue,
    );
    if (resolvedChild !== undefined && resolvedChild !== childSchema) {
      nextProperties[key] = resolvedChild;
      changed = true;
    }
  }

  return changed
    ? {
      ...narrowed,
      properties: nextProperties,
    }
    : narrowed;
}

// Memo for `schemaHasIfc` top-level calls. Safe **only** because entries
// are populated under an `isDeepFrozen` guard below: the predicate's
// answer depends on the entire subtree's shape, so caching against a
// merely-TS-`readonly` or shallow-frozen input would be unsound — a
// future sub-schema swap would silently invalidate the cached answer.
// A future contributor must not relax the populate guard to accept
// non-deep-frozen inputs. `Object.isFrozen` is **not** sufficient; it
// is shallow-only.
const _hasIfcCache = new WeakMap<JSONSchemaObj, boolean>();

interface SchemaHasIfcContext {
  seenByRoot: WeakMap<object, WeakSet<object>>;
}

export function schemaHasIfc(
  schema: JSONSchema | undefined,
  seen: Set<JSONSchema> = new Set(),
  fullSchema: JSONSchema | undefined = schema,
): boolean {
  if (schema === undefined || typeof schema === "boolean") {
    return false;
  }
  // Top-level calls (the default entry from cell.ts / schema.ts) can
  // consult the memo. Recursive calls carry caller-provided `seen` and
  // `fullSchema`, which aren't captured in the cache key, so they must
  // bypass.
  const isTopLevel = seen.size === 0 && fullSchema === schema;
  if (isTopLevel) {
    const cached = _hasIfcCache.get(schema);
    if (cached !== undefined) return cached;
  }
  const context: SchemaHasIfcContext = { seenByRoot: new WeakMap() };
  if (seen.size > 0) {
    const initialRoot = cfcSchemaChildRoot(schema, fullSchema ?? schema);
    const rootKey = isRecord(initialRoot) ? initialRoot : schema;
    const initialSeen = new WeakSet<object>();
    for (const item of seen) {
      if (isRecord(item)) initialSeen.add(item);
    }
    context.seenByRoot.set(rootKey, initialSeen);
  }
  const result = _schemaHasIfcUncached(schema, fullSchema, context);
  // Populate only under a deep-frozen guard. See the invariant comment
  // above `_hasIfcCache`.
  if (isTopLevel && isDeepFrozen(schema)) {
    _hasIfcCache.set(schema, result);
  }
  return result;
}

function _schemaHasIfcUncached(
  schema: JSONSchemaObj,
  fullSchema: JSONSchema | undefined,
  context: SchemaHasIfcContext,
): boolean {
  const schemaRoot = cfcSchemaChildRoot(schema, fullSchema ?? schema);
  const rootKey = isRecord(schemaRoot) ? schemaRoot : schema;
  let seen = context.seenByRoot.get(rootKey);
  if (seen?.has(schema)) return false;
  if (!seen) {
    seen = new WeakSet();
    context.seenByRoot.set(rootKey, seen);
  }
  seen.add(schema);

  const resolved = typeof schema.$ref === "string"
    ? ContextualFlowControl.resolveSchemaRefs(schema, schemaRoot)
    : schema;
  if (resolved === true || resolved === false || !isRecord(resolved)) {
    return false;
  }
  const childFullSchema = cfcSchemaChildRoot(
    resolved,
    typeof schema.$ref === "string"
      ? resolveCfcSchemaRefRoot(schema, schemaRoot)
      : schemaRoot,
  );
  if (resolved.ifc !== undefined) {
    return true;
  }

  const compound = [
    ...(resolved.anyOf ?? []),
    ...(resolved.oneOf ?? []),
    ...(resolved.allOf ?? []),
  ];
  if (
    compound.some((item) =>
      isRecord(item) &&
      _schemaHasIfcUncached(item, childFullSchema, context)
    )
  ) {
    return true;
  }
  if (
    resolved.properties !== undefined &&
    Object.values(resolved.properties).some((item) =>
      isRecord(item) &&
      _schemaHasIfcUncached(item, childFullSchema, context)
    )
  ) {
    return true;
  }
  if (
    typeof resolved.additionalProperties === "object" &&
    isRecord(resolved.additionalProperties) &&
    _schemaHasIfcUncached(
      resolved.additionalProperties,
      childFullSchema,
      context,
    )
  ) {
    return true;
  }
  if (
    typeof resolved.items === "object" &&
    isRecord(resolved.items) &&
    _schemaHasIfcUncached(resolved.items, childFullSchema, context)
  ) {
    return true;
  }
  return false;
}

const _filterAsCellCache = new WeakMap<
  JSONSchemaObj,
  JSONSchema | "<undefined>"
>();

function filterAsCell(schema: JSONSchema | undefined): JSONSchema | undefined {
  if (!isNontrivialSchema(schema)) {
    return schema;
  }

  const makeRawResult = () => {
    const { asCell: _asCell, ...restSchema } = schema;
    return isNontrivialSchema(restSchema) ? restSchema : undefined;
  };

  if (isDeepFrozen(schema)) {
    // Note: We cache literal `<undefined>` when we are to return `undefined`,
    // to disambiguate with no-entry.
    const cached = _filterAsCellCache.get(schema);
    if (cached) return (cached === "<undefined>") ? undefined : cached;
    const rawResult = makeRawResult();
    if (rawResult) {
      const result = internSchema(rawResult);
      _filterAsCellCache.set(schema, result);
      return result;
    } else {
      _filterAsCellCache.set(schema, "<undefined>");
      return undefined;
    }
  } else {
    return makeRawResult();
  }
}

/**
 * Process a default value from a schema, transforming it based on the schema
 * structure to account for asCell/asStream and other schema features.
 *
 * For `required` objects and arrays assume {} and [] as default value.
 */
export function processDefaultValue(
  runtime: Runtime,
  tx: IExtendedStorageTransaction | undefined,
  link: NormalizedFullLink,
  defaultValue: any,
  synced = false,
  cfcLabelView?: CfcLabelView,
): any {
  const schema = link.schema;
  if (!schema) return defaultValue;

  let resolvedSchema = resolveSchema(schema);
  if (!isRecord(resolvedSchema)) {
    // For primitive types, return as is
    return annotateWithBackToCellSymbols(
      defaultValue,
      runtime,
      link,
      tx,
      synced,
      cfcLabelView,
    );
  }

  const asCellValues = ContextualFlowControl.getAsCellValues(resolvedSchema);
  if (asCellValues.length > 0) {
    // Remove the asCell flags from the schema
    const { asCell: _c, ...restSchema } = resolvedSchema;
    resolvedSchema = restSchema;

    if (
      ContextualFlowControl.getAsCellKind(asCellValues.at(0)) === "stream"
    ) {
      logger.warn(
        "Created asStream as a default value, but this is likely unintentional",
      );
      // This can receive events, but at first nothing will be bound to it.
      // Normally these get created by a handler call.
      return runtime.getImmutableCell(
        link.space,
        { $stream: true },
        resolvedSchema,
        tx,
        cfcLabelView,
      );
    } else {
      const asCellEntry = asCellValues.at(0);
      const asCellKind = ContextualFlowControl.getAsCellKind(asCellEntry);
      if (asCellKind === undefined) {
        return undefined;
      }
      // If schema indicates this should be some sort of a cell
      // If the cell itself has a default value, make it its own (immutable)
      // doc, to emulate the behavior of .get() returning a different underlying
      // document when the value is changed. A classic example is
      // `currentlySelected` with a default of `null`.
      if (defaultValue === undefined && resolvedSchema.default !== undefined) {
        return runtime.getImmutableCell(
          link.space,
          resolvedSchema.default,
          resolvedSchema,
          tx,
          cfcLabelView,
        );
      } else {
        // This is a creation path (no default value to box): use the schema to
        // set the new cell's initial scope from the asCell entry.
        return createCell(
          runtime,
          {
            ...linkWithAsCellScope(link, asCellEntry),
            schema: mergeDefaults(resolvedSchema, defaultValue),
          },
          getTransactionForChildCells(tx),
          synced,
          asCellKind,
          cfcLabelView,
        );
      }
    }
  }

  // Handle object type defaults
  if (
    resolvedSchema?.type === "object" && isRecord(defaultValue) &&
    !Array.isArray(defaultValue)
  ) {
    const result: Record<string, any> = {};
    const processedKeys = new Set<string>();

    // Process properties defined in both the schema and default value
    if (resolvedSchema?.properties) {
      for (const key of Object.keys(resolvedSchema.properties)) {
        const rawPropSchema = runtime.cfc.schemaAtPath(resolvedSchema, [key]);
        const propSchema =
          (isRecord(rawPropSchema) && typeof rawPropSchema.$ref === "string")
            ? ContextualFlowControl.resolveSchemaRefs(
              rawPropSchema,
              resolvedSchema,
            )
            : rawPropSchema;
        if (key in defaultValue) {
          result[key] = processDefaultValue(
            runtime,
            tx,
            { ...link, schema: propSchema, path: [...link.path, key] },
            defaultValue[key as keyof typeof defaultValue],
            synced,
            rebaseCfcLabelView(cfcLabelView, [key]),
          );
          processedKeys.add(key);
        } else if (isRecord(propSchema)) {
          const asCellValues = ContextualFlowControl.getAsCellValues(
            propSchema,
          );
          if (
            asCellValues.length > 0 &&
            ContextualFlowControl.getAsCellKind(asCellValues.at(0)) !==
              "stream"
          ) {
            // asCell are always created, it's their value that can be `undefined`
            result[key] = processDefaultValue(
              runtime,
              tx,
              { ...link, schema: propSchema, path: [...link.path, key] },
              undefined,
              synced,
              rebaseCfcLabelView(cfcLabelView, [key]),
            );
          } else if (propSchema.default !== undefined) {
            result[key] = processDefaultValue(
              runtime,
              tx,
              { ...link, schema: propSchema, path: [...link.path, key] },
              propSchema.default,
              synced,
              rebaseCfcLabelView(cfcLabelView, [key]),
            );
          } else if (
            resolvedSchema?.required?.includes(key) &&
            (propSchema.type === "object" || propSchema.type === "array")
          ) {
            result[key] = processDefaultValue(
              runtime,
              tx,
              { ...link, schema: propSchema, path: [...link.path, key] },
              propSchema.type === "object" ? {} : [],
              synced,
              rebaseCfcLabelView(cfcLabelView, [key]),
            );
          }
        }
      }
    }

    // Handle additional properties in the default value with additionalProperties schema
    if (resolvedSchema.additionalProperties) {
      const additionalPropertiesSchema =
        typeof resolvedSchema.additionalProperties === "object"
          ? resolvedSchema.additionalProperties
          : undefined;

      for (const key in defaultValue) {
        if (!processedKeys.has(key)) {
          processedKeys.add(key);
          result[key] = processDefaultValue(
            runtime,
            tx,
            {
              ...link,
              schema: additionalPropertiesSchema,
              path: [...link.path, key],
            },
            defaultValue[key as keyof typeof defaultValue],
            synced,
            rebaseCfcLabelView(cfcLabelView, [key]),
          );
        }
      }
    }

    return annotateWithBackToCellSymbols(
      result,
      runtime,
      link,
      tx,
      synced,
      cfcLabelView,
    );
  }

  // Handle array type defaults
  if (
    resolvedSchema.type === "array" && Array.isArray(defaultValue) &&
    resolvedSchema.items
  ) {
    // TODO(@ubik2): Need to handle prefixItems
    // Handle boolean items values
    let itemSchema: JSONSchema;
    if (resolvedSchema.items === true) {
      // items: true means allow any item type
      itemSchema = {};
    } else if ((resolvedSchema.items as any) === false) {
      // items: false means no additional items allowed (empty arrays only)
      // For default value processing, we'll treat this as an error
      throw new Error(
        "Array schema error: items: false conflicts with non-empty default\n" +
          "help: either allow items with valid schema, or use empty array default",
      );
    } else {
      // items is a JSONSchema object
      itemSchema = resolvedSchema.items as JSONSchema;
    }

    const result = defaultValue.map((item, i) =>
      processDefaultValue(
        runtime,
        tx,
        {
          ...link,
          schema: itemSchema,
          path: [...link.path, String(i)],
        },
        item,
        synced,
        rebaseCfcLabelView(cfcLabelView, [String(i)]),
      )
    );
    return annotateWithBackToCellSymbols(
      result,
      runtime,
      link,
      tx,
      synced,
      cfcLabelView,
    );
  }

  // For primitive types, return as is
  return annotateWithBackToCellSymbols(
    defaultValue,
    runtime,
    link,
    tx,
    synced,
    cfcLabelView,
  );
}

/** @internal Exported for testing only. */
export function mergeDefaults(
  schema: JSONSchema | undefined,
  defaultValue: Readonly<FabricValue>,
): JSONSchema {
  const base = isNontrivialSchema(schema) ? schema : {};

  // TODO(seefeld): What's the right thing to do for arrays?
  const mergedDefault = base.type === "object" && isRecord(base.default) &&
      isRecord(defaultValue)
    ? { ...base.default, ...defaultValue } as JSONValue
    : defaultValue as JSONValue;

  return schemaWithProperties(base, { default: mergedDefault });
}

/**
 * This adds appropriate properties to a given `value` to give it an associated
 * cell, if possible. This only takes any action if `value` is an object type
 * and isn't itself a cell-related thing.
 *
 * If this function decides to add properties but `value` is either frozen (or
 * generally non-extensible) or already bound into some (other) context, then it
 * is first shallow-cloned. It is up to callers to ensure that mutable and
 * unbound `value`s are indeed appropriate to be mutated.
 */
function annotateWithBackToCellSymbols(
  value: any,
  runtime: Runtime,
  link: NormalizedFullLink,
  tx: IExtendedStorageTransaction | undefined,
  synced = false,
  cfcLabelView?: CfcLabelView,
) {
  if (!isRecord(value) || isCell(value)) {
    // We only possibly annotate objects or arrays that _aren't_ cells.
    return value;
  }

  const extensible = Object.isExtensible(value);
  if (!extensible || isCellResultForDereferencing(value)) {
    // We have to clone `value` to get a mutable top before attaching the
    // back-to-cell symbol. See function header comment for details.
    // `shallowMutableClone` deep-freezes the bound children as
    // inexpensive defense-in-depth; in practice the only trigger here is a
    // non-extensible (hence deep-frozen) value,
    // so the children are already deep-frozen and pass through by identity.
    value = shallowMutableClone(value as FabricValue);
  }

  // Non-enumerable, so that {...obj} won't copy these symbols
  Object.defineProperty(value, toCell, {
    // Use getTransactionForChildCells so that if this was called from sample(),
    // the resulting cell is still reactive
    value: () =>
      createCell(
        runtime,
        link,
        getTransactionForChildCells(tx),
        synced,
        undefined,
        cfcLabelView,
      ),
    enumerable: false,
  });

  Object.freeze(value);
  return value;
}

export interface ValidateAndTransformOptions {
  /** When true, also read into each Cell created for asCell fields to capture dependencies */
  traverseCells?: boolean;
  /** When true, cells created during traversal are marked as already synced */
  synced?: boolean;
}

/**
 * Status-bearing counterpart to {@link validateAndTransform}.
 *
 * `undefined` is a valid schema result, so callers which need to distinguish
 * that value from traversal failure must use this result rather than inspect
 * the transformed value.
 */
export type ValidateAndTransformResult =
  | { ok: any }
  | {
    error: unknown;
    unavailableReason?: "syncing" | "error";
    unavailableError?: Error;
  };

export function validateAndTransform(
  runtime: Runtime,
  tx: IExtendedStorageTransaction | undefined,
  sourceRef: NormalizedFullLink | CellViewRef,
  _seen?: Array<[string, any]>,
  options?: ValidateAndTransformOptions,
): any {
  const result = validateAndTransformResult(
    runtime,
    tx,
    sourceRef,
    _seen,
    options,
  );
  return "ok" in result ? result.ok : undefined;
}

export function validateAndTransformResult(
  runtime: Runtime,
  tx: IExtendedStorageTransaction | undefined,
  sourceRef: NormalizedFullLink | CellViewRef,
  _seen?: Array<[string, any]>,
  options?: ValidateAndTransformOptions,
): ValidateAndTransformResult {
  // If the transaction is no longer open, read through the runtime's ambient
  // read path instead. Open transactions still take precedence so reads can see
  // their own uncommitted state.
  tx = runtime.readTx(tx);

  // Reconstruct doc, path, schema from link and runtime
  let link = isCellViewRef(sourceRef) ? sourceRef.link : sourceRef;
  const schema = link.schema;
  const resolvedSchema = resolveSchema(schema);
  let cfcLabelView = cloneCfcLabelView(
    isCellViewRef(sourceRef) ? sourceRef.cfcLabelView : undefined,
  );

  // For opaque cells, create the cell directly from the current link.
  // We intentionally avoid traversing redirect chains or reading through the
  // transaction, since opaque cells should preserve identity without materializing
  // the pointed-to value.
  const asCellValues = ContextualFlowControl.getAsCellValues(resolvedSchema);
  if (ContextualFlowControl.getAsCellKind(asCellValues.at(0)) === "opaque") {
    return {
      ok: new TransformObjectCreator(
        runtime,
        tx!,
        options?.synced ?? false,
        link,
        cfcLabelView,
      ).createObject(
        { ...link, schema: resolvedSchema },
        undefined,
      ),
    };
  }

  // Follow aliases, etc. to last element on path + just aliases on that last one
  // When we generate cells below, we want them to be based off this value, as that
  // is what a setter would change when they update a value or reference.
  const writeRedirectTraceStart = tx.getCfcState().dereferenceTraces.length;
  const resolvedLink = resolveLink(runtime, tx, link, "writeRedirect");
  cfcLabelView = mergeCfcLabelViews([
    cfcLabelView,
    cfcLabelViewForDereferenceTraces(
      tx,
      tx.getCfcState().dereferenceTraces.slice(writeRedirectTraceStart),
    ),
  ]);

  const resolvedLinkSchema = resolveSchema(resolvedLink.schema);
  const effectiveSchema = resolvedSchema !== undefined
    ? resolvedLinkSchema !== undefined
      ? combineSchema(resolvedSchema, resolvedLinkSchema)
      : resolvedSchema
    : resolvedLinkSchema;
  const filteredSchema = filterAsCell(effectiveSchema);
  if (
    schemaHasIfc(effectiveSchema) ||
    storedCfcMetadataAppliesToPath(tx, resolvedLink)
  ) {
    tx.markCfcRelevant(`schema-ifc-read:${link.id}`);
  }

  // Unlike the original, we have kept the asCell markers in the schema
  link = {
    ...resolvedLink,
    ...(effectiveSchema !== undefined && { schema: effectiveSchema }),
  };
  const objectCreator = new TransformObjectCreator(
    runtime,
    tx!,
    options?.synced ?? false,
    link,
    cfcLabelView,
  );

  // If we don't have a schema, and we aren't asCell/asStream, use a proxy
  if (
    (
      effectiveSchema === undefined ||
      !SchemaObjectTraverser.hasAsCell(effectiveSchema)
    ) &&
    filteredSchema === undefined
  ) {
    return {
      ok: createQueryResultProxy(runtime, tx, link, 0, false, cfcLabelView),
    };
  }

  // Now resolve further links until we get the actual value.
  // We'll use this for the value, and potentially merge the schema
  // This gets me the result of following all the links, so I can get the value
  const valueResolutionSource = link;
  const valueTraceStart = tx.getCfcState().dereferenceTraces.length;
  const resolvedValueLink = resolveLink(runtime, tx, link);
  cfcLabelView = mergeCfcLabelViews([
    cfcLabelView,
    cfcLabelViewForDereferenceTraces(
      tx,
      tx.getCfcState().dereferenceTraces.slice(valueTraceStart),
    ),
  ]);
  objectCreator.setBase(resolvedValueLink, cfcLabelView);

  // If our link is asCell/asStream, and we don't have any path portions, we
  // can just create the cell and mostly skip reading the value and traversal.
  if (SchemaObjectTraverser.hasAsCell(effectiveSchema)) {
    // We check for a link value, since we will follow links one step in get
    // We've already followed all the writeRedirect links above.
    const next = readMaybeLink(tx, link);
    if (next !== undefined) {
      cfcLabelView = mergeCfcLabelViews([
        cfcLabelView,
        cfcLabelViewForDereference(
          tx,
          cfcAddressFromLink(link),
          cfcAddressFromLink(next),
        ),
      ]);
      // We leave the asCell/asStream in the schema, so that createObject
      // knows to create a cell
      const mergedSchema = (next.schema !== undefined)
        ? combineSchema(effectiveSchema!, next.schema)
        : effectiveSchema!;
      link = { ...next, schema: mergedSchema };
    }
    // If our ref has a schema, merge our schema flags into that schema
    // This will overwrite any schema that we got from the first non-redirect
    // link, but this one should be more accurate
    // Otherwise, we won't return a cell like we are supposed to.
    if (resolvedValueLink.schema !== undefined) {
      const mergedSchemaFlags = mergeSchemaFlags(
        effectiveSchema!,
        resolvedValueLink.schema,
      );
      link.schema = SchemaObjectTraverser.hasAsCell(mergedSchemaFlags)
        ? mergedSchemaFlags
        : effectiveSchema!;
    }
    objectCreator.setBase(link, cfcLabelView);
    return { ok: objectCreator.createObject(link, undefined) };
  }

  // Link paths don't include value, but doc address should
  const address: IMemorySpaceValueAddress = toMemorySpaceAddress(
    resolvedValueLink,
  );
  // Get the full value without telling the scheduler. The traverse method will
  // notify the scheduler for shallow reads as they occur.
  const valueRead = tx.read(address, {
    meta: { ...ignoreReadForScheduling, ...internalVerifierRead },
  });
  if (
    valueRead.error?.name === "NotFoundError" &&
    valueRead.error.path.length === 0 &&
    (
      resolvedValueLink.space !== valueResolutionSource.space ||
      resolvedValueLink.id !== valueResolutionSource.id ||
      resolvedValueLink.scope !== valueResolutionSource.scope ||
      resolvedValueLink.path.length !== valueResolutionSource.path.length ||
      resolvedValueLink.path.some(
        (part, index) => part !== valueResolutionSource.path[index],
      )
    )
  ) {
    const loadStatus = runtime.ensureLinkedDocLoaded(resolvedValueLink);
    // A followed link can target replica coverage that is not established yet
    // even within the same space after a dynamic retarget. Once the selector
    // sync settles, an absent target falls through as a schema mismatch.
    if (loadStatus === "pending") {
      return { error: valueRead.error, unavailableReason: "syncing" };
    }
    if (loadStatus === "error") {
      return {
        error: valueRead.error,
        unavailableReason: "error",
        unavailableError: runtime.linkedDocLoadError(resolvedValueLink) ??
          new Error("Linked document synchronization failed"),
      };
    }
  }
  if (
    valueRead.error !== undefined &&
    valueRead.error.name !== "NotFoundError" &&
    valueRead.error.name !== "TypeMismatchError"
  ) {
    throw toThrowable(valueRead.error);
  }
  const value = valueRead.ok?.value;
  const doc = { address, value: value };
  const valueSelectedSchema = isRecord(effectiveSchema)
    ? asCellCompoundSchemaForValue(effectiveSchema, value)
    : undefined;
  // If we have a ref with a schema, use that; otherwise, use the link's schema
  const selector = {
    path: doc.address.path,
    schema: valueSelectedSchema ?? resolvedValueLink.schema ?? link.schema!,
  };
  // TODO(@ubik2): these constructor parameters are complex enough that we should
  // use an options struct
  let linkedDocUnavailable:
    | { unavailableReason: "syncing" }
    | { unavailableReason: "error"; unavailableError: Error }
    | undefined;
  const traverser = new SchemaObjectTraverser<any>(
    tx!,
    selector,
    createDefaultTraversalContext(
      options?.traverseCells ?? false,
      undefined,
      undefined,
      // Absent linked targets establish selector coverage asynchronously.
      (missing, sourceSpace) => {
        const loadStatus = runtime.ensureLinkedDocLoaded(missing, sourceSpace);
        if (loadStatus === "error") {
          linkedDocUnavailable = {
            unavailableReason: "error",
            unavailableError: runtime.linkedDocLoadError(missing) ??
              new Error("Linked document synchronization failed"),
          };
        } else if (
          loadStatus === "pending" &&
          linkedDocUnavailable?.unavailableReason !== "error"
        ) {
          linkedDocUnavailable = { unavailableReason: "syncing" };
        }
      },
    ),
    objectCreator,
  );
  const result = traverser.traverse(doc, link);
  return "error" in result && linkedDocUnavailable !== undefined
    ? { ...result, ...linkedDocUnavailable }
    : result;
}

/**
 * Memo for `TransformObjectCreator.mergeMatches`' combined anyOf/allOf cell
 * schema, keyed per deep-frozen compound schema identity × the cell match's
 * (tiny) `asCell` values. `mergeMatches` runs once per matched anyOf cell on
 * the traverse path and the combined schema is deterministic from these two
 * inputs; without the memo every call rebuilds the (large) combined schema
 * and pays a full content hash to intern it onto the cell link. Mutable
 * compound schemas are never cached (in-place edits must be observed).
 * Module-level so the memo survives across traverser instances.
 */
const combinedCellSchemaCache = new WeakMap<
  JSONSchemaObj,
  Map<string, JSONSchema>
>();

class TransformObjectCreator
  implements IObjectCreator<AnyCellWrapping<FabricValue>> {
  constructor(
    private runtime: Runtime,
    private tx: IExtendedStorageTransaction,
    private synced: boolean,
    private baseLink: NormalizedFullLink,
    private cfcLabelView: CfcLabelView | undefined,
  ) {
  }

  setBase(
    baseLink: NormalizedFullLink,
    cfcLabelView: CfcLabelView | undefined,
  ): void {
    this.baseLink = baseLink;
    this.cfcLabelView = cloneCfcLabelView(cfcLabelView);
  }

  private labelViewFor(link: NormalizedFullLink): CfcLabelView | undefined {
    return labelViewForLink(this.baseLink, this.cfcLabelView, link);
  }

  /**
   * @param matches
   * @param schema An allOf or anyOf schema
   * @returns
   */
  mergeMatches<T>(
    matches: T[],
    schema: JSONSchemaObj,
  ): T | Record<string, T> | undefined {
    // These value objects should be merged. While this isn't JSONSchema
    // spec, when we have an anyOf with branches where name is set in one
    // schema, but the address is ignored, and a second option where
    // address is set, and name is ignored, we want to include both.
    if (matches.length > 1) {
      // If more than one match, but we have a cell, return that
      // If we tried to combine the objects, the result would not be a cell
      // anymore.
      const cellMatch = matches.find((v) => isCell(v));
      if (cellMatch !== undefined) {
        // At least one match is a cell. If they are all cells, we should be
        // able to combine them. If some are not, we could alter our schema on
        // the cell to include the anyOf. Since that's already a cell, we want
        // to remove the first "cell" entry from the asCell array.
        // I'm not going to fully support legacy streams here, since this is
        // already a super edge case.
        if (schema.asCell !== undefined) {
          // Use the asCell from the anyOf/allOf schema
          // This code isn't typically reached, since a cell with an asCell
          // schema will have just removed one level from asCell and returned
          // that instead. However, I include it here for completeness.
          const unwrappedSchema = unwrapAsCellSchema(schema);
          return cellMatch.asSchema(unwrappedSchema) as any;
        } else {
          // at least one of the entries should have had an asCell or we
          // wouldn't have a cell. We will use the asCell used for creating
          // this cell, but change the rest of the schema to be the logical
          // combination schema.
          const asCellValues = ContextualFlowControl.getAsCellValues(
            cellMatch.schema,
          );
          const cacheKey = isDeepFrozen(schema)
            ? JSON.stringify(asCellValues)
            : undefined;
          if (cacheKey !== undefined) {
            const cached = combinedCellSchemaCache.get(schema)?.get(cacheKey);
            if (cached !== undefined) return cellMatch.asSchema(cached) as any;
          }
          const allOfItems = (schema.allOf ?? []).map(removeAsCellFromSchema);
          const anyOfItems = (schema.anyOf ?? []).map(removeAsCellFromSchema);
          // Intern here so the memo holds the canonical instance and the
          // `asSchema` interning below is an identity cache hit.
          const combinedSchema = internSchema({
            ...schema,
            ...(allOfItems.length > 0) && { allOf: allOfItems },
            ...(anyOfItems.length > 0) && { anyOf: anyOfItems },
            ...(asCellValues.length > 0) && { asCell: asCellValues },
          });
          if (cacheKey !== undefined) {
            let byKey = combinedCellSchemaCache.get(schema);
            if (byKey === undefined) {
              byKey = new Map();
              combinedCellSchemaCache.set(schema, byKey);
            }
            byKey.set(cacheKey, combinedSchema);
          }
          return cellMatch.asSchema(combinedSchema) as any;
        }
      }
    }
    return mergeAnyOfMatches(matches);
  }

  // This controls the behavior when properties is specified, but
  // additonalProperties is not.
  addOptionalProperty(
    _obj: Record<string, Immutable<FabricValue>>,
    _key: string,
    _value: FabricValue,
  ) {
    // We want to exclude properties when we have a properties map provided
    // in the schema, but it doesn't include our property, and we don't have
    // additionalProperties set. So we don't do `obj[key] = value`;
  }
  applyDefault<T>(
    link: NormalizedFullLink,
    value: T | undefined,
  ): T | undefined {
    return processDefaultValue(
      this.runtime,
      this.tx,
      link,
      value,
      this.synced,
      this.labelViewFor(link),
    );
  }

  /**
   * Plain-schema traversal has already ruled out asCell and default keywords,
   * so only attach the ordinary back-to-cell annotation here. Keeping this
   * beside createObject() makes the skipped semantics explicit and leaves the
   * generic path unchanged for every richer schema.
   */
  createPlainSchemaObject(
    link: NormalizedFullLink,
    value: AnyCellWrapping<FabricValue> | undefined,
  ): AnyCellWrapping<FabricValue> {
    return annotateWithBackToCellSymbols(
      value,
      this.runtime,
      link,
      this.tx,
      this.synced,
      this.labelViewFor(link),
    );
  }

  // This is an early pass to see if we should just create a proxy or cell
  // If not, we will actually resolve our links to get to our values.
  createObject(
    link: NormalizedFullLink,
    value: AnyCellWrapping<FabricValue> | undefined,
  ): AnyCellWrapping<FabricValue> {
    // If we have a schema with an asCell or asStream (or if our anyOf values
    // do), we should create a cell here.
    // If we don't have a schema, or a true schema, we should create a query result proxy.
    // If we have a schema without asCell or asStream, we should annotate the
    // object so we can get back to the cell if needed.
    if (link.schema === undefined || link.schema === true) {
      return createQueryResultProxy(
        this.runtime,
        this.tx,
        link,
        0,
        false,
        this.labelViewFor(link),
      );
    } else if (isRecord(link.schema)) {
      const schema = asCellCompoundSchemaForValue(link.schema, value) ??
        link.schema;
      const asCellValues = ContextualFlowControl.getAsCellValues(schema);
      if (asCellValues.length > 0) {
        // We'll use the first asCell for the outermost, and pass the rest
        // in with the schema for the created cell.
        const asCellEntry = asCellValues[0];
        const cellKind = ContextualFlowControl.getAsCellKind(asCellEntry);
        if (cellKind === undefined) {
          return undefined;
        }
        // TODO(@ubik2): deal with anyOf/oneOf with asCell/asStream
        // This is a read/materialization path: keep the link's own
        // storage-resolved scope. The asCell entry scope is honored as a
        // follow cap during link resolution, never copied onto the link here
        // (doing so would re-address the value to a different scoped instance).
        return createCell(
          this.runtime,
          {
            ...link,
            schema: unwrapAsCellSchema(schema as JSONSchemaObj),
          },
          getTransactionForChildCells(this.tx),
          this.synced,
          cellKind,
          this.labelViewFor(link),
        ) as AnyCellWrapping<FabricValue>;
      }
      // If it's not a cell/stream, but the schema is true-ish, use a
      // QueryResultProxy
      if (ContextualFlowControl.isTrueSchema(schema)) {
        return createQueryResultProxy(
          this.runtime,
          this.tx,
          link,
          0,
          false,
          this.labelViewFor(link),
        );
      }
      // link.schema is not true, and not asCell/asStream
      // If we're undefined, check for a default and apply that
      if (schema.default !== undefined && value === undefined) {
        // processDefaultValue already annotates with back to cell
        return processDefaultValue(
          this.runtime,
          this.tx,
          link,
          schema.default,
          this.synced,
          this.labelViewFor(link),
        );
      }
      // If we're an object, we may be missing some properties that have a
      // default.
      if (
        isRecord(value) && !Array.isArray(value) &&
        schema.properties !== undefined
      ) {
        // Ensure value is mutable before injecting default properties.
        // cloneIfNecessary with { deep: false, frozen: false, force: false }
        // is a no-op for unfrozen objects and shallow-clones frozen ones.
        value = cloneIfNecessary(value as FabricValue, {
          deep: false,
          frozen: false,
          force: false,
        }) as typeof value;
        const propertyEntries = Object.entries(schema.properties) as [
          string,
          JSONSchema,
        ][];
        for (const [propName, propSchema] of propertyEntries) {
          if (isRecord(propSchema) && propSchema.default !== undefined) {
            const valueObj = value as Record<string, any>;
            if (valueObj[propName] === undefined) {
              valueObj[propName] = processDefaultValue(
                this.runtime,
                this.tx,
                {
                  ...link,
                  path: [...link.path, propName],
                  schema: propSchema,
                },
                undefined,
                this.synced,
                rebaseCfcLabelView(this.labelViewFor(link), [propName]),
              );
            }
          }
        }
      }
      // TODO(@ubik2): What if we're an array? Is it possible to have undefined
      // elements in our array?
    }
    return annotateWithBackToCellSymbols(
      value,
      this.runtime,
      link,
      this.tx,
      this.synced,
      this.labelViewFor(link),
    );
  }
}

/**
 * This assumes that there will not be a conflict in definitions between the
 * eventSchema and the stateSchema.
 */
// TODO(@ubik2): We also need to re-write any relative refs
export function generateHandlerSchema(
  eventSchema?: JSONSchema,
  stateSchema?: JSONSchema,
): JSONSchema | undefined {
  if (eventSchema === undefined && stateSchema === undefined) {
    return undefined;
  }
  const mergedDefs: Record<string, JSONSchema> = {};
  const mergedDefinitions: Record<string, JSONSchema> = {};
  if (isRecord(eventSchema)) {
    // extract $defs and definitions and remove them from eventSchema
    const { $defs, definitions, ...rest } = eventSchema;
    eventSchema = rest;
    Object.assign(mergedDefs, $defs);
    Object.assign(mergedDefinitions, definitions);
  }
  if (isRecord(stateSchema)) {
    // extract $defs and definitions and remove them from stateSchema
    const { $defs, definitions, ...rest } = stateSchema;
    stateSchema = rest;
    Object.assign(mergedDefs, $defs);
    Object.assign(mergedDefinitions, definitions);
  }
  return internSchema({
    type: "object",
    properties: {
      "$event": eventSchema ?? true,
      "$ctx": stateSchema ?? true,
    },
    required: ["$ctx"],
    ...(Object.keys(mergedDefs).length && { $defs: mergedDefs }),
    ...(Object.keys(mergedDefinitions).length &&
      { definitions: mergedDefinitions }),
  });
}

// unwrapAsCellSchema results per deep-frozen schema identity. The unwrapped
// schema rides on every created child cell's link, where downstream identity
// caches (link-resolution interning, schemaAtPath, value hashing) key on it —
// a fresh spread per cell creation re-hashed the whole schema each time.
const unwrappedAsCellSchemaCache = new WeakMap<JSONSchemaObj, JSONSchemaObj>();

function unwrapAsCellSchema(schema: JSONSchemaObj): JSONSchemaObj {
  const cacheable = isDeepFrozen(schema);
  if (cacheable) {
    const cached = unwrappedAsCellSchemaCache.get(schema);
    if (cached !== undefined) {
      return cached;
    }
  }
  const { asCell: _c, ...restSchema } = schema;
  const asCellValues = ContextualFlowControl.getAsCellValues(schema);
  // Intern so the result is the canonical frozen instance: child cell links
  // then carry an identity-stable schema across repeat materializations.
  const result = internSchema({
    ...restSchema,
    ...(asCellValues.length > 1 && { asCell: asCellValues.slice(1) }),
  });
  if (cacheable) {
    unwrappedAsCellSchemaCache.set(schema, result);
  }
  return result;
}

function removeAsCellFromSchema(schema: JSONSchema): JSONSchema {
  if (isRecord(schema)) {
    const { asCell: _c, ...restSchema } = schema;
    return restSchema;
  }
  return schema;
}
