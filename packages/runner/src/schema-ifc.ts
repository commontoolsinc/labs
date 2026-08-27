/**
 * Whether a schema tree carries flow-control marking (`ifc`) anywhere.
 *
 * Lives apart from `schema.ts` so the traversal can consult it at link
 * hops: `schema.ts` imports the traversal, and the read entry point and
 * the walk both gate cfc relevance on this predicate.
 */

import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";
import { isDeepFrozen } from "@commonfabric/data-model/deep-freeze";
import { isObjectOrArray } from "@commonfabric/utils/types";

import { ContextualFlowControl } from "./cfc.ts";
import {
  cfcSchemaChildRoot,
  resolveCfcSchemaRefRoot,
} from "./cfc/schema-refs.ts";
import {
  externalResolutionMissCount,
  onSchemaRegistryClear,
} from "./schema-registry.ts";
import { forEachSubschema } from "./schema-walk.ts";

// Memo for `schemaHasIfc` top-level calls. Safe **only** because entries
// are populated under an `isDeepFrozen` guard below: the predicate's
// answer depends on the entire subtree's shape, so caching against a
// merely-TS-`readonly` or shallow-frozen input would be unsound — a
// future sub-schema swap would silently invalidate the cached answer.
// A future contributor must not relax the populate guard to accept
// non-deep-frozen inputs. `Object.isFrozen` is **not** sufficient; it
// is shallow-only.
let _hasIfcCache = new WeakMap<JSONSchemaObj, boolean>();
// A verdict computed over registry content must not outlive the lease epoch
// that made the content available; the clear swaps the cache.
onSchemaRegistryClear(() => {
  _hasIfcCache = new WeakMap();
});

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
    const rootKey = isObjectOrArray(initialRoot) ? initialRoot : schema;
    const initialSeen = new WeakSet<object>();
    for (const item of seen) {
      if (isObjectOrArray(item)) initialSeen.add(item);
    }
    context.seenByRoot.set(rootKey, initialSeen);
  }
  const missesBefore = externalResolutionMissCount();
  const result = _schemaHasIfcUncached(schema, fullSchema, context);
  // Populate only under a deep-frozen guard (see the invariant comment
  // above `_hasIfcCache`), and only when no `cid:` resolution missed while
  // computing — a verdict computed over an absent schema document must not
  // outlive the document's arrival.
  if (
    isTopLevel && isDeepFrozen(schema) &&
    externalResolutionMissCount() === missesBefore
  ) {
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
  const rootKey = isObjectOrArray(schemaRoot) ? schemaRoot : schema;
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
  if (resolved === true || resolved === false || !isObjectOrArray(resolved)) {
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

  // Descend every structural subschema via the shared vocabulary. Previously
  // this hand-listed only anyOf/oneOf/allOf/properties/additionalProperties/
  // items and silently skipped prefixItems, patternProperties, contains,
  // if/then/else, not, propertyNames, dependentSchemas, and contentSchema — so
  // an `ifc` in a tuple element or pattern property went undetected. `$defs`
  // bodies are reached through `$ref` resolution above, not walked directly.
  return forEachSubschema(
    resolved,
    (child) =>
      isObjectOrArray(child) &&
      _schemaHasIfcUncached(child, childFullSchema, context),
  );
}

/**
 * The shared "actual link crossing" seam: marks `tx` cfc-relevant when the
 * link being crossed carries flow-control marking in its stored schema.
 * Reader precedence keeps a shaped reader's combined schema free of the
 * link's `ifc`, so the marking lives at the crossing rather than on the
 * combination's output. Call AFTER any external schema-document
 * registration for the schema (`loadExternalSchemaDocs` in traverse.ts),
 * so a cold `cid:` closure is resolvable when the walk consults it; a
 * closure still absent reads as unlabeled this pass, stays uncached (the
 * resolution-miss guard), and marks on the re-triggered pass that follows
 * the documents' arrival. The predicate is memoized; unlabeled links (the
 * common case) cost one cached lookup.
 */
export function markIfcBearingLinkCrossing(
  tx: { markCfcRelevant(reason?: string): void },
  linkSchema: JSONSchema | undefined,
  linkId: string,
): void {
  if (linkSchema !== undefined && schemaHasIfc(linkSchema)) {
    tx.markCfcRelevant(`schema-ifc-hop:${linkId}`);
  }
}
