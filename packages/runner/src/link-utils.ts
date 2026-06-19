import { toCompactDebugString } from "@commonfabric/data-model/value-debug";
import { isRecord } from "@commonfabric/utils/types";
import { isNontrivialSchema } from "@commonfabric/data-model/schema-utils";
import {
  type AnyCell,
  type DerivedInternalCellDescriptor,
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
import { type LinkV1Inner, type SigilLink, type URI } from "./sigil-types.ts";
import { cellRefFrom, cellRefInner } from "@commonfabric/data-model/cell-rep";
import { getJSONFromDataURI, toURI } from "./uri-utils.ts";
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
  } & SanitizeSchemaForLinksOptions = {},
): SigilLink {
  // Create the base structure
  const sigil: SigilLink = cellRefFrom<LinkV1Inner>({
    path: link.path.map((p) => p.toString()),
  });

  const reference = cellRefInner(sigil);

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
    // If they didn't opt-out of keepStreams, set it to true
    const extendedOptions = {
      ...options,
      keepStreams: options.keepStreams ?? true,
    };
    const schema = sanitizeSchemaForLinks(link.schema, extendedOptions);
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
  if (isCellLink(value)) {
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
            keepAsCell: true,
          });
          return findAndInlineDataURILinks(newSigilLink);
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
      const inlined = findAndInlineDataURILinks(current);
      if (next) {
        next[index] = inlined;
      } else if (inlined !== current) {
        next = value.slice();
        next[index] = inlined;
      }
    }
    return next ?? value;
  } else if (isRecord(value)) {
    let next: Record<string, unknown> | undefined;
    for (const [key, entry] of Object.entries(value)) {
      const inlined = findAndInlineDataURILinks(entry);
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

// Helper to create data URIs for testing
export function createDataCellURI(
  data: any,
  base?: Cell | NormalizedLink,
): URI {
  const baseLink = isCell(base) ? base.getAsNormalizedFullLink() : base;

  function traverseAndAddBaseIdToRelativeLinks(
    value: any,
    seen: Set<any>,
  ): any {
    if (!isRecord(value)) return value;
    if (seen.has(value)) {
      throw new Error(`Cycle detected when creating data URI`);
    }
    seen.add(value);
    try {
      if (isPrimitiveCellLink(value)) {
        const link = parseLink(value, baseLink);
        return createSigilLinkFromParsedLink(link, {
          includeSchema: true,
          keepAsCell: true,
        });
      } else if (Array.isArray(value)) {
        return value.map((item) =>
          traverseAndAddBaseIdToRelativeLinks(item, seen)
        );
      } else { // isObject
        return Object.fromEntries(
          Object.entries(value).map((
            [key, value],
          ) => [key, traverseAndAddBaseIdToRelativeLinks(value, seen)]),
        );
      }
    } finally {
      seen.delete(value);
    }
  }
  const json = JSON.stringify({
    value: traverseAndAddBaseIdToRelativeLinks(data, new Set()),
  });
  // Use encodeURIComponent for UTF-8 safe encoding (matches runtime.ts pattern)
  return `data:application/json,${encodeURIComponent(json)}` as URI;
}

export type SanitizeSchemaForLinksOptions = {
  // Keep the entire asCell entry, which preserves cell, opaque, and stream
  keepAsCell?: boolean;
  // Only keep the asCell property if it's a stream
  keepStreams?: boolean;
};

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
  options?: SanitizeSchemaForLinksOptions,
): JSONSchema;
export function sanitizeSchemaForLinks(
  schema: JSONSchema | undefined,
  options?: SanitizeSchemaForLinksOptions,
): JSONSchema | undefined;
export function sanitizeSchemaForLinks(
  schema: JSONSchema | undefined,
  options?: SanitizeSchemaForLinksOptions,
): JSONSchema | undefined {
  if (schema === undefined || typeof schema === "boolean") {
    return schema;
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
    options: options ?? {},
  };

  const result = recursiveStripAsCellFromSchema(
    schema,
    context,
    0,
  );

  // If we generated any $defs, add them to the root schema
  if (Object.keys(context.defs).length > 0) {
    // Merge with any existing $defs
    const existingDefs = result?.$defs || {};
    return {
      ...result,
      $defs: { ...existingDefs, ...context.defs },
    };
  }

  return result;
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
  // Options
  options: SanitizeSchemaForLinksOptions;
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
  if (context.options.keepAsCell) {
    result = { ...schema };
  } else {
    const { asCell: _c, ...restSchema } = schema;
    const asCellValues = ContextualFlowControl.getAsCellValues(schema);
    // If we're keeping streams and the outermost is a stream, keep it
    if (
      context.options.keepStreams &&
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
  if (context.options.keepStreams !== true) {
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
  if (context.options.keepAsCell || !isRecord(schema)) return false;

  const asCellValues = ContextualFlowControl.getAsCellValues(schema);
  const hasStreamMarker = asCellValues.some((entry) =>
    ContextualFlowControl.getAsCellKind(entry) === "stream"
  );
  if (!hasStreamMarker) return false;

  return !(
    context.options.keepStreams &&
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
    id: toURI(createRef({}, {
      parent,
      type: "internal",
      cause: descriptor.partialCause,
    })),
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
