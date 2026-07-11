import { toCompactDebugString } from "@commonfabric/data-model/value-debug";
import { isRecord } from "@commonfabric/utils/types";
import { isNontrivialSchema } from "@commonfabric/data-model/schema-utils";
import { deepFreeze, isDeepFrozen } from "@commonfabric/data-model/deep-freeze";
import { FabricSpecialObject } from "@commonfabric/data-model/fabric-value";
import { isAdmittedFabricFactory } from "@commonfabric/data-model/fabric-factory";
import {
  type AnyCell,
  type DerivedInternalCellDescriptor,
  isPattern,
  type JSONSchema,
  type JSONValue,
} from "./builder/types.ts";
import {
  type Cell,
  isAnyCell,
  isCell,
  type MemorySpace,
  type Stream,
} from "./cell.ts";
import {
  type CellLinkRefPayload,
  type SigilLink,
  type URI,
} from "./sigil-types.ts";
import { linkRefFrom, linkRefPayload } from "@commonfabric/data-model/cell-rep";
import {
  encodeFabricValueDataURI,
  getJSONFromDataURI,
  toURI,
} from "./uri-utils.ts";
import { arrayEqual } from "./path-utils.ts";
import {
  CellResultInternals,
  getCellOrThrow,
  isCellResultForDereferencing,
} from "./query-result-proxy.ts";
import { ContextualFlowControl } from "./cfc.ts";
import { resolveLink } from "./link-resolution.ts";
import {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
} from "./storage/interface.ts";
import type { Runtime } from "./runtime.ts";
import {
  isLegacyAlias,
  isNormalizedFullLink,
  isNormalizedLink,
  isPrimitiveCellLink,
  NormalizedFullLink,
  NormalizedLink,
  parseLinkPrimitive,
  PrimitiveCellLink,
} from "./link-types.ts";
import { MetaLinkField } from "@commonfabric/api";
import { ignoreReadForScheduling } from "./scheduler.ts";
import { createRef } from "./create-ref.ts";
import {
  createFactoryTraversalContext,
  mapFactoryForTraversal,
} from "./builder/factory-traversal.ts";

export * from "./link-types.ts";

/**
 * A type reflecting all possible link formats, including cells themselves.
 */
export type CellLink =
  | Cell<any>
  | Stream<any>
  | CellResultInternals
  | PrimitiveCellLink;

/**
 * Check if value is any kind of link or linkable entity
 */
export function isCellLink(
  value: any,
): value is CellLink {
  return (
    isCellResultForDereferencing(value) ||
    isPrimitiveCellLink(value) ||
    isCell(value)
  );
}

/**
 * Parse any link-like value to normalized format
 *
 * Overloads just help make fields non-optional that can be guaranteed to exist
 * in various combinations.
 */
export function parseLink(
  value: AnyCell<any>,
): NormalizedFullLink;
export function parseLink(
  value: CellLink,
  base: AnyCell<any> | NormalizedFullLink | IMemorySpaceAddress,
): NormalizedFullLink;
export function parseLink(
  value: CellLink,
  base?: AnyCell<any> | NormalizedLink | IMemorySpaceAddress,
): NormalizedLink;
export function parseLink(
  value: any,
  base: AnyCell<any> | NormalizedFullLink | IMemorySpaceAddress,
): NormalizedFullLink | undefined;
export function parseLink(
  value: any,
  base?: AnyCell<any> | NormalizedLink | IMemorySpaceAddress,
): NormalizedLink | undefined;
export function parseLink(
  value: any,
  base?: AnyCell<any> | NormalizedLink | IMemorySpaceAddress,
): NormalizedLink | undefined {
  // Has to be first, since below we check for "/" in value and we don't want to
  // see userland "/".
  if (isCellResultForDereferencing(value)) value = getCellOrThrow(value);

  if (isCell(value)) return value.getAsNormalizedFullLink();

  if (isPrimitiveCellLink(value)) {
    if (!base) {
      return parseLinkPrimitive(value);
    } else if (isAnyCell(base)) {
      return parseLinkPrimitive(value, base.getAsNormalizedFullLink());
    } else if (isNormalizedLink(base)) {
      return parseLinkPrimitive(value, base);
    }
    throw new Error(`Unexpected link base: ${base}`);
  }
  return undefined;
}

/**
 * Parse any link-like value to normalized format, throwing on failure
 */
export function parseLinkOrThrow(
  value: any,
  baseCell?: Cell,
): NormalizedLink {
  const result = parseLink(value, baseCell);
  if (!result) {
    throw new Error(
      `Cannot parse value as link: ${toCompactDebugString(value)}`,
    );
  }
  return result;
}

/**
 * Compare two link values for equality, supporting all link formats
 */
export function areLinksSame(
  value1: any,
  value2: any,
  base?: Cell | NormalizedLink,
  resolveBeforeComparing?: boolean,
  txForResolving?: IExtendedStorageTransaction,
  runtime?: Runtime,
): boolean {
  if (value1 === undefined && value2 === undefined) return false;

  // If both are the same object, they're equal
  if (value1 === value2) return true;

  // If either is null/undefined, they're only equal if both are
  if (!value1 || !value2) return value1 === value2;

  // Try parsing both as links
  let link1 = parseLink(value1, base);
  let link2 = parseLink(value2, base);

  // If one parses and the other doesn't, they're not equal
  if (!link1 || !link2) return false;

  if (resolveBeforeComparing) {
    const tx = txForResolving;
    if (!tx) throw new Error("Provide tx to resolve before comparing");
    if (!runtime) {
      throw new Error("Provide runtime to resolve before comparing");
    }
    link1 = isNormalizedFullLink(link1)
      ? resolveLink(runtime, tx, link1)
      : link1;
    link2 = isNormalizedFullLink(link2)
      ? resolveLink(runtime, tx, link2)
      : link2;
  }

  // Compare normalized links
  return areNormalizedLinksSame(link1, link2);
}

export function areMaybeLinkAndNormalizedLinkSame(
  link: any,
  normalizedLink: NormalizedLink,
  base?: Cell | NormalizedLink,
): boolean {
  const normalizedLink2 = parseLink(link, base);
  if (!normalizedLink2) return false;
  return areNormalizedLinksSame(normalizedLink, normalizedLink2);
}

/**
 * Compare two normalized links for equality
 */
export function areNormalizedLinksSame(
  link1: NormalizedLink,
  link2: NormalizedLink,
): boolean {
  return link1.id === link2.id && link1.space === link2.space &&
    (link1.scope ?? "space") === (link2.scope ?? "space") &&
    arrayEqual(link1.path, link2.path);
}

/**
 * Creates a sigil reference (link or alias) with shared logic
 */
export function createSigilLinkFromParsedLink(
  link: NormalizedLink,
  options: {
    base?: Cell<any> | NormalizedFullLink;
    baseSpace?: MemorySpace;
    includeSchema?: boolean;
    overwrite?: "redirect" | "this"; // default is "this"
    // Which asCell entries to preserve in the included schema. When omitted,
    // streams are kept (see below) and all other asCell entries are stripped.
    keepAsCell?: KeepAsCell;
  } = {},
): SigilLink {
  // Create the base structure
  const sigil: SigilLink = linkRefFrom<CellLinkRefPayload>({
    path: link.path.map((p) => p.toString()),
  });

  const reference = linkRefPayload(sigil);

  // Handle base cell for relative references
  if (options.base) {
    const baseLink = isCell(options.base)
      ? options.base.getAsNormalizedFullLink()
      : options.base;

    // Only include id if it's different from base
    if (link.id !== baseLink.id) reference.id = toURI(link.id);

    // Only include space if it's different from base
    if (link.space && link.space !== baseLink.space) {
      reference.space = link.space;
    }
    if (link.scope && link.scope !== baseLink.scope) {
      reference.scope = link.scope;
    }
  } else {
    reference.id = link.id;

    // Handle baseSpace option - only include space if different from baseSpace
    if (link.space !== options.baseSpace) reference.space = link.space;
    if (link.scope) reference.scope = link.scope;
  }

  // Include schema if requested. Empty `{}` and JSON Schema `true` are
  // permissive and should not turn links into schema-bearing links.
  if (options.includeSchema && link.schema !== undefined) {
    // Default to keeping streams unless a broader mode was requested.
    const schema = sanitizeSchemaForLinks(
      link.schema,
      options.keepAsCell ?? KeepAsCell.OnlyStream,
    );
    if (isNontrivialSchema(schema)) reference.schema = schema;
  }

  // Option overrides link value
  if (options.overwrite) {
    if (options.overwrite === "redirect") reference.overwrite = "redirect";
    // else: "this" is the default
  } else if (link.overwrite === "redirect") {
    reference.overwrite = "redirect";
  }

  return sigil;
}

  /**
 * Find any data: URI links and inline them.
 *
 * @param value - The value to find and inline data: URI links in.
 * @returns The value with any data: URI links inlined.
 */
export function findAndInlineDataURILinks(value: any): any {
  return findAndInlineDataURILinksInner(
    value,
    createFactoryTraversalContext(),
  );
}

function findAndInlineDataURILinksInner(
  value: any,
  factoryContext: ReturnType<typeof createFactoryTraversalContext>,
): any {
  if (isAdmittedFabricFactory(value)) {
    return mapFactoryForTraversal(
      value,
      (nested) => findAndInlineDataURILinksInner(nested, factoryContext),
      factoryContext,
    );
  } else if (typeof value === "function") {
    throw new TypeError("Arbitrary functions are not valid Fabric values");
  } else if (isCellLink(value)) {
    const dataLink = parseLink(value)!;

    if (dataLink.id?.startsWith("data:")) {
      let dataValue: any = getJSONFromDataURI(dataLink.id);
      const path = [...dataLink.path];

      // This is a storage item, so we have to look into the "value" field for
      // the actual data.
      if (!isRecord(dataValue)) return undefined;
      dataValue = dataValue["value"];

      // If there is a link on the way to `path`, follow it, appending remaining
      // path to the target link.
      while (dataValue !== undefined) {
        if (isPrimitiveCellLink(dataValue)) {
          // Parse the link found in the data URI
          // Do NOT pass parsedLink as base to avoid inheriting the data: URI id
          const newLink = parseLink(dataValue);
          let schema = newLink.schema;
          if (schema !== undefined && path.length > 0) {
            const cfc = new ContextualFlowControl();
            schema = cfc.getSchemaAtPath(schema, path);
          }
          // Create new link by merging dataLink with remaining path
          const newSigilLink = createSigilLinkFromParsedLink({
            // Start with values from the original data link
            ...dataLink,

            // overwrite with values from the new link
            ...newLink,

            // extend path with remaining segments
            path: [...newLink.path, ...path],

            // use resolved schema if we have one
            ...(schema !== undefined && { schema }),
          }, {
            includeSchema: true,
            keepAsCell: KeepAsCell.All,
          });
          return findAndInlineDataURILinksInner(newSigilLink, factoryContext);
        }
        if (path.length > 0) {
          dataValue = dataValue[path.shift()!];
        } else {
          break;
        }
      }

      return dataValue;
    } else {
      return value;
    }
  } else if (Array.isArray(value)) {
    let next: any[] | undefined;
    for (let index = 0; index < value.length; index++) {
      if (!(index in value)) continue;
      const current = value[index];
      const inlined = findAndInlineDataURILinksInner(current, factoryContext);
      if (next) {
        next[index] = inlined;
      } else if (inlined !== current) {
        next = value.slice();
        next[index] = inlined;
      }
    }
    return next ?? value;
  } else if (value instanceof FabricSpecialObject) {
    return value;
  } else if (isRecord(value)) {
    let next: Record<string, unknown> | undefined;
    for (const [key, entry] of Object.entries(value)) {
      const inlined = findAndInlineDataURILinksInner(entry, factoryContext);
      if (next) {
        next[key] = inlined;
      } else if (inlined !== entry) {
        next = { ...value };
        next[key] = inlined;
      }
    }
    return next ?? value;
  } else {
    return value;
  }
}

export interface CreateDataCellURIOptions {
  /**
   * Runner-owned proof that the factory's complete artifact closure is
   * available in the containing document's exact source space.
   */
  readonly assertFactoryAvailable?: (factory: unknown) => void;
}

/** Create the canonical inline Fabric document used by durable cell links. */
export function createDataCellURI(
  data: any,
  base?: Cell | NormalizedLink,
  options: CreateDataCellURIOptions = {},
): URI {
  const baseLink = isCell(base) ? base.getAsNormalizedFullLink() : base;
  const factoryContext = createFactoryTraversalContext();
  const checkedFactories = new WeakSet<object>();

  function traverseAndAddBaseIdToRelativeLinks(
    value: any,
    seen: Set<object>,
    insideLegacyPatternGraph = false,
  ): any {
    if (isAdmittedFabricFactory(value)) {
      if (!checkedFactories.has(value)) {
        if (!options.assertFactoryAvailable) {
          throw new Error(
            "Cannot create durable data URI containing Factory@1 without artifact-space availability proof",
          );
        }
        options.assertFactoryAvailable(value);
        checkedFactories.add(value);
      }
      return mapFactoryForTraversal(
        value,
        (nested) => traverseAndAddBaseIdToRelativeLinks(nested, seen),
        factoryContext,
      );
    }
    if (value instanceof FabricSpecialObject) return value;
    if (!isRecord(value)) return value;
    if (seen.has(value)) {
      throw new Error(`Cycle detected when creating data URI`);
    }
    seen.add(value);
    try {
      // A structural legacy Pattern carries unresolved `$alias` bindings as
      // executable graph metadata. They are not links relative to the inline
      // document that happens to transport the graph; resolving them here
      // would erase the pseudo-cell (`argument` / `result`) and later make the
      // tool pattern point back into its containing inputs cell. Preserve them
      // until Runner binds the pattern for its own invocation.
      if (insideLegacyPatternGraph && isLegacyAlias(value)) {
        return value;
      }
      if (isPrimitiveCellLink(value)) {
        const link = parseLink(value, baseLink);
        return createSigilLinkFromParsedLink(link, {
          includeSchema: true,
          keepAsCell: KeepAsCell.All,
        });
      } else if (Array.isArray(value)) {
        return value.map((item) =>
          traverseAndAddBaseIdToRelativeLinks(
            item,
            seen,
            insideLegacyPatternGraph,
          )
        );
      } else { // isObject
        const childIsInsideLegacyPattern = insideLegacyPatternGraph ||
          isPattern(value);
        return Object.fromEntries(
          Object.entries(value).map((
            [key, value],
          ) => [
            key,
            traverseAndAddBaseIdToRelativeLinks(
              value,
              seen,
              childIsInsideLegacyPattern,
            ),
          ]),
        );
      }
    } finally {
      seen.delete(value);
    }
  }
  return encodeFabricValueDataURI({
    value: traverseAndAddBaseIdToRelativeLinks(data, new Set()),
  });
}

/**
 * Controls which `asCell` schema entries survive {@link sanitizeSchemaForLinks}.
 */
export enum KeepAsCell {
  // Strip all asCell entries (cell, opaque, and stream).
  None = "None",
  // Keep the asCell entry only when it's a stream.
  OnlyStream = "OnlyStream",
  // Keep the entire asCell entry (preserves cell, opaque, and stream).
  All = "All",
}

// Identity-keyed memo for `sanitizeSchemaForLinks` (see the function body).
// Values are always deep-frozen OBJECT schemas: boolean/undefined inputs take
// the early return and never reach the memo, and outputs are frozen before
// caching (their sub-trees are shared across callers).
const _sanitizeCache = new WeakMap<
  object,
  Map<KeepAsCell, JSONSchema & object>
>();

/**
 * Traverse schema and remove all asCell flags.
 * Also handles circular references by using JSON Schema $ref.
 *
 * When circular references are detected, they are extracted to a $defs
 * section and replaced with $ref pointers. This ensures the output can
 * be safely serialized with JSON.stringify without exponential growth
 * or circular reference errors.
 */
export function sanitizeSchemaForLinks(
  schema: JSONSchema,
  keepAsCell?: KeepAsCell,
): JSONSchema;
export function sanitizeSchemaForLinks(
  schema: JSONSchema | undefined,
  keepAsCell?: KeepAsCell,
): JSONSchema | undefined;
export function sanitizeSchemaForLinks(
  schema: JSONSchema | undefined,
  keepAsCell: KeepAsCell = KeepAsCell.None,
): JSONSchema | undefined {
  if (schema === undefined || typeof schema === "boolean") {
    return schema;
  }

  // Memoize by input identity: sanitize is a pure function of
  // `(schema, keepAsCell)`, and at pattern-build time the same interned/frozen
  // schema is sanitized repeatedly — measured ~46% of calls repeat a frozen
  // input, carrying ~half of the total strip time. Only deep-frozen inputs are
  // memoized (a mutable input's identity could go stale), matching the
  // identity-keyed-memo guard `traverse.ts` uses; `isDeepFrozen` is O(1) for the
  // already-frozen/cached inputs we hit here. The cache holds the canonical strip
  // result, DEEP-FROZEN for share-safety (see the store site below); every call
  // returns a fresh SHALLOW CLONE of it. The clone matters:
  // the reactive graph keys on the sanitized schema's top-level object identity
  // (returning a shared object changes recomputation), so each call needs its own
  // top — while still reusing the (expensive) stripped sub-tree from the cache.
  const memoizable = isDeepFrozen(schema);
  if (memoizable) {
    const hit = _sanitizeCache.get(schema)?.get(keepAsCell);
    if (hit !== undefined) return { ...hit };
  }

  // Collect existing $defs names to avoid collisions
  const existingDefNames = new Set<string>();
  if ("$defs" in schema) {
    const existingDefs = schema.$defs;
    if (existingDefs && typeof existingDefs === "object") {
      for (const name of Object.keys(existingDefs)) {
        existingDefNames.add(name);
      }
    }
  }

  // Context for tracking circular references and generating $defs
  const context: SanitizeContext = {
    seen: new Map(),
    inProgress: new Set(),
    defs: {},
    defCounter: 0,
    reservedNames: existingDefNames,
    keepAsCell,
  };

  const stripped = recursiveStripAsCellFromSchema(schema, context, 0);

  // If we generated any $defs, add them to the root schema (merging existing).
  const output = Object.keys(context.defs).length > 0
    ? {
      ...stripped,
      $defs: { ...(stripped?.$defs || {}), ...context.defs },
    }
    : stripped;

  if (memoizable) {
    let byMode = _sanitizeCache.get(schema);
    if (byMode === undefined) {
      byMode = new Map();
      _sanitizeCache.set(schema, byMode);
    }
    // Deep-freeze the cached result: every memo hit hands out a fresh top that
    // SHARES this sub-tree across callers, so a consumer mutating a nested node
    // would otherwise silently poison every later same-schema build — frozen,
    // such a mutation throws loudly instead. Freezing only touches objects this
    // call built: the strip rebuilds every node, and its depth-capped bail
    // returns sub-trees of the input, which is deep-frozen on this path.
    const frozen = deepFreeze(output) as JSONSchema & object;
    byMode.set(keepAsCell, frozen);
    return { ...frozen };
  }

  return output;
}

interface SanitizeContext {
  // Maps original schema objects to their processed results
  seen: Map<any, any>;
  // Tracks schemas currently being processed (for cycle detection)
  inProgress: Set<any>;
  // Accumulated $defs for circular schemas
  defs: Record<string, any>;
  // Counter for generating unique def names
  defCounter: number;
  // Reserved def names (from existing $defs in input schema)
  reservedNames: Set<string>;
  // Which asCell entries to preserve while stripping.
  keepAsCell: KeepAsCell;
}

function cloneSchemaMetadata(
  value: unknown,
  seen: Map<object, unknown> = new Map(),
): unknown {
  if (value === null || typeof value !== "object") return value;
  const cached = seen.get(value);
  if (cached !== undefined) return cached;
  const clone: unknown[] | Record<PropertyKey, unknown> = Array.isArray(value)
    ? []
    : {};
  seen.set(value, clone);
  for (const key of Reflect.ownKeys(value)) {
    (clone as Record<PropertyKey, unknown>)[key] = cloneSchemaMetadata(
      (value as Record<PropertyKey, unknown>)[key],
      seen,
    );
  }
  return clone;
}

/**
 * Recursively strips asCell flags from a JSON schema.
 * This also ensures there are no circular references in the output schema
 * by using $ref and $defs.
 *
 * @param schema
 * @param context
 * @param depth
 * @returns
 */
function recursiveStripAsCellFromSchema(
  schema: any,
  context: SanitizeContext,
  depth: number,
): any {
  // Handle null/undefined/boolean schemas
  if (
    schema === null ||
    typeof schema !== "object" ||
    typeof schema === "boolean"
  ) {
    return schema;
  }

  // Prevent infinite recursion from proxy objects or very deep schemas
  // JSON Schema shouldn't need more than ~50 levels of nesting in practice
  if (depth > 100) return schema;

  // If we've already fully processed this schema, return the result
  if (context.seen.has(schema) && !context.inProgress.has(schema)) {
    return context.seen.get(schema);
  }

  // Cycle detection: if we're currently processing this schema, we have a cycle
  if (context.inProgress.has(schema)) {
    // Generate a unique name for this circular schema, avoiding collisions
    let defName: string;
    do {
      defName = `CircularSchema_${context.defCounter++}`;
    } while (context.reservedNames.has(defName) || defName in context.defs);

    // Create a $ref to the definition we'll create
    const ref = { $ref: `#/$defs/${defName}` };

    // Store the ref as the result for this schema
    // The actual definition will be added when we finish processing
    context.seen.set(schema, ref);

    return ref;
  }

  // Mark as in-progress
  context.inProgress.add(schema);

  let result;
  // Shallow copy — only top-level keys are deleted/replaced; children are
  // handled by recursive calls that create their own copies.
  if (context.keepAsCell === KeepAsCell.All) {
    result = { ...schema };
  } else {
    const { asCell: _c, ...restSchema } = schema;
    const asCellValues = ContextualFlowControl.getAsCellValues(schema);
    // If we're keeping streams and the outermost is a stream, keep it
    if (
      context.keepAsCell === KeepAsCell.OnlyStream &&
      ContextualFlowControl.getAsCellKind(asCellValues.at(0)) === "stream"
    ) {
      result = { asCell: asCellValues, ...restSchema };
    } else {
      result = restSchema;
    }
    // Do NOT promote the stripped asCell entry's scope onto the resulting
    // schema's top-level `scope`. The scope of an asCell value belongs to the
    // link to its target (which carries its own scope) and acts as a follow cap;
    // promoting it here makes it look like an authored container scope, which is
    // then stamped onto the *container* link on reads, addressing the wrong
    // scoped instance (the read lands on an empty narrower instance). See
    // CT-1623.
  }

  // Recursively process all object properties
  for (const [key, value] of Object.entries(result)) {
    // Skip $ref - it's just a string pointer, not a schema to process
    if (key === "$ref") continue;

    // `asFactory` carries an exact public call contract. Its nested schemas are
    // metadata about a different invocation boundary, so stripping their cell
    // wrappers would silently change the factory type. Copy the extension as a
    // unit while allowing the enclosing link schema to be sanitized normally.
    if (key === "asFactory") {
      result[key] = cloneSchemaMetadata(value);
      continue;
    }

    if (value && typeof value === "object") {
      if (key === "$defs") {
        // Process each definition in $defs (they contain schemas that may have asCell/asStream)
        const processedDefs: Record<string, any> = {};
        for (
          const [defName, defSchema] of Object.entries(
            value as Record<string, any>,
          )
        ) {
          if (defSchema && typeof defSchema === "object") {
            processedDefs[defName] = recursiveStripAsCellFromSchema(
              defSchema,
              context,
              depth + 1,
            );
          } else {
            processedDefs[defName] = defSchema;
          }
        }
        result[key] = processedDefs;
      } else if (Array.isArray(value)) {
        // Handle arrays
        result[key] = value.map((item) =>
          typeof item === "object" && item !== null
            ? recursiveStripAsCellFromSchema(
              item,
              context,
              depth + 1,
            )
            : item
        );
      } else {
        // Handle objects
        result[key] = recursiveStripAsCellFromSchema(
          value,
          context,
          depth + 1,
        );
      }
    }
  }

  // Stream properties will be removed if didn't keep streams, so we need to
  // remove them from required if present.
  if (context.keepAsCell === KeepAsCell.None) {
    removeStrippedStreamPropertiesFromRequired(schema, result, context);
  }

  // Check if this schema was marked as circular while processing
  const existingRef = context.seen.get(schema);
  if (existingRef && existingRef.$ref) {
    // This schema is part of a cycle - add it to $defs
    const defName = existingRef.$ref.replace("#/$defs/", "");
    context.defs[defName] = result;
  }

  // Mark as done and store result
  context.inProgress.delete(schema);
  context.seen.set(schema, result);

  return result;
}

function schemaLosesStreamCellMarker(
  schema: unknown,
  context: SanitizeContext,
): boolean {
  if (context.keepAsCell === KeepAsCell.All || !isRecord(schema)) {
    return false;
  }

  const asCellValues = ContextualFlowControl.getAsCellValues(schema);
  const hasStreamMarker = asCellValues.some((entry) =>
    ContextualFlowControl.getAsCellKind(entry) === "stream"
  );
  if (!hasStreamMarker) return false;

  return !(
    context.keepAsCell === KeepAsCell.OnlyStream &&
    ContextualFlowControl.getAsCellKind(asCellValues.at(0)) === "stream"
  );
}

function removeStrippedStreamPropertiesFromRequired(
  originalSchema: unknown,
  result: unknown,
  context: SanitizeContext,
): void {
  if (!isRecord(originalSchema) || !isRecord(result)) return;
  const properties = originalSchema.properties;
  if (!isRecord(properties)) return;
  if (!Array.isArray(result.required)) return;

  const required = result.required.filter((property) =>
    typeof property !== "string" ||
    !schemaLosesStreamCellMarker(
      properties[property],
      context,
    )
  );

  if (required.length === 0) {
    delete result.required;
  } else {
    result.required = required;
  }
}

/** Get or create a cell using the resultCell as the cause. */
export function getMetaCell(
  resultCell: AnyCell<unknown>,
  type: "internal" | "argument",
  tx: IExtendedStorageTransaction,
  schema?: JSONSchema,
): Cell {
  const metaCause = { type, parent: resultCell };
  const resultCellLink = resultCell.getAsNormalizedFullLink();
  const metaLink = {
    space: resultCellLink.space,
    id: toURI(createRef({}, metaCause)),
    path: [],
    ...(resultCellLink.scope !== undefined && { scope: resultCellLink.scope }),
    ...(schema !== undefined && { schema }),
  };
  return resultCell.runtime.getCellFromLink(metaLink, undefined, tx);
}

export function getDerivedInternalCellLink(
  resultCell: AnyCell<unknown>,
  descriptor: DerivedInternalCellDescriptor,
): NormalizedFullLink {
  const resultCellLink = resultCell.getAsNormalizedFullLink();
  const parent = resultCell.entityId ?? resultCell;
  return {
    space: resultCellLink.space,
    // The kind's ONLY representation is the URI scheme applied here by
    // toURI; the hash preimage is kind-free, so this mint site is the single
    // place a computed identity is established.
    id: toURI(
      createRef(
        {},
        {
          parent,
          type: "internal",
          cause: descriptor.partialCause,
        },
      ),
      descriptor.kind,
    ),
    path: [],
    scope: descriptor.scope ?? resultCellLink.scope,
    ...(descriptor.schema !== undefined && { schema: descriptor.schema }),
  };
}

export function getStableInternalPathSegment(
  cause: unknown,
): PropertyKey | undefined {
  if (
    typeof cause === "string" ||
    typeof cause === "number" ||
    typeof cause === "symbol"
  ) {
    return cause;
  }

  if (cause !== undefined) {
    if (isRecord(cause) && "stream" in cause) {
      return `stream:${formatStableCauseSegment(cause.stream as JSONValue)}`;
    }
    return formatStableCauseSegment(cause as JSONValue);
  }

  return undefined;
}

function formatStableCauseSegment(cause: JSONValue): string {
  if (typeof cause === "string") return cause;
  if (
    typeof cause === "number" ||
    typeof cause === "boolean" ||
    cause === null
  ) {
    return String(cause);
  }

  try {
    return JSON.stringify(cause) ?? String(cause);
  } catch {
    return String(cause);
  }
}

export function getDerivedInternalCell(
  resultCell: Cell,
  descriptor: DerivedInternalCellDescriptor,
  tx?: IExtendedStorageTransaction,
): Cell {
  return resultCell.runtime.getCellFromLink(
    getDerivedInternalCellLink(resultCell, descriptor),
    descriptor.schema,
    tx,
  );
}

const META_READ_OPTIONS = {
  meta: ignoreReadForScheduling,
} as const;

/**
 * Our internal and argument cells are linked to by the result cell.
 * This gets those links from the meta fields, and returns a link if present.
 *
 * By default, the meta reads are ignored for scheduling, and the schema
 * will be frozen.
 */
export function getMetaLink(
  resultCell: Cell<unknown>,
  field: MetaLinkField,
  options: unknown = META_READ_OPTIONS,
): NormalizedFullLink | undefined {
  const linkObj = resultCell.getMetaRaw(field, options);
  if (linkObj === undefined) return undefined;
  const link = parseLink(linkObj, resultCell);
  return link;
}
