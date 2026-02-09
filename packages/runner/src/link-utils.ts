import { isRecord } from "@commontools/utils/types";
import { type AnyCell, type JSONSchema } from "./builder/types.ts";
import {
  type Cell,
  isAnyCell,
  isCell,
  type MemorySpace,
  type Stream,
} from "./cell.ts";
import { LINK_V1_TAG, type SigilLink, type URI } from "./sigil-types.ts";
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
  isNormalizedLink,
  isPrimitiveCellLink,
  NormalizedFullLink,
  NormalizedLink,
  parseLinkPrimitive,
  PrimitiveCellLink,
} from "./link-types.ts";

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
 * Check if value is a normalized link.
 *
 * Beware: Unlike all the other types that `isLink` is checking for, this could
 * appear in regular data and not actually be meant as a link. So only use this
 * if you know for sure that the value is a link.
 */
export function isNormalizedFullLink(value: any): value is NormalizedFullLink {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.space === "string" &&
    typeof value.type === "string" &&
    Array.isArray(value.path)
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
    throw new Error(`Cannot parse value as link: ${JSON.stringify(value)}`);
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
    arrayEqual(link1.path, link2.path) &&
    (link1.type ?? "application/json") === (link2.type ?? "application/json");
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
    keepStreams?: boolean;
    keepAsCell?: boolean;
  } = {},
): SigilLink {
  // Create the base structure
  const sigil: SigilLink = {
    "/": {
      [LINK_V1_TAG]: {
        path: link.path.map((p) => p.toString()),
      },
    },
  };

  const reference = sigil["/"][LINK_V1_TAG];

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
  } else {
    reference.id = link.id;

    // Handle baseSpace option - only include space if different from baseSpace
    if (link.space !== options.baseSpace) reference.space = link.space;
  }

  // Include schema if requested
  if (options.includeSchema && link.schema !== undefined) {
    reference.schema = sanitizeSchemaForLinks(link.schema, options);
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
            keepStreams: true,
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
    return value.map(findAndInlineDataURILinks);
  } else if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map((
        [key, value],
      ) => [key, findAndInlineDataURILinks(value)]),
    );
  } else {
    return value;
  }
}

// Helper to create data URIs for testing
export function createDataCellURI(
  data: any,
  base?: Cell | NormalizedLink,
): URI {
  const baseId = isCell(base) ? base.getAsNormalizedFullLink().id : base?.id;

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
        const link = parseLink(value);
        if (!link.id) {
          return createSigilLinkFromParsedLink({ ...link, id: baseId });
        } else {
          return value;
        }
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

/**
 * Traverse schema and remove all asCell and asStream flags.
 * Also handles circular references by using JSON Schema $ref.
 *
 * When circular references are detected, they are extracted to a $defs
 * section and replaced with $ref pointers. This ensures the output can
 * be safely serialized with JSON.stringify without exponential growth
 * or circular reference errors.
 */
export function sanitizeSchemaForLinks(
  schema: JSONSchema,
  options?: { keepAsCell?: boolean; keepStreams?: boolean },
): JSONSchema;
export function sanitizeSchemaForLinks(
  schema: JSONSchema | undefined,
  options?: { keepAsCell?: boolean; keepStreams?: boolean },
): JSONSchema | undefined;
export function sanitizeSchemaForLinks(
  schema: JSONSchema | undefined,
  options?: { keepAsCell?: boolean; keepStreams?: boolean },
): JSONSchema | undefined {
  if (
    schema === null ||
    schema === undefined ||
    typeof schema === "boolean"
  ) {
    return schema;
  }

  // Collect existing $defs names to avoid collisions
  const existingDefNames = new Set<string>();
  if (typeof schema === "object" && schema !== null && "$defs" in schema) {
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

  const result = recursiveStripAsCellAndStreamFromSchema(schema, context, 0);

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
  options: { keepStreams?: boolean; keepAsCell?: boolean };
}

function recursiveStripAsCellAndStreamFromSchema(
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

  // Create a copy to avoid mutating the original
  const result: any = { ...schema };

  // Remove asCell and asStream flags from this level
  if (!context.options.keepAsCell) delete result.asCell;
  if (!context.options.keepStreams) delete result.asStream;

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
            processedDefs[defName] = recursiveStripAsCellAndStreamFromSchema(
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
            ? recursiveStripAsCellAndStreamFromSchema(item, context, depth + 1)
            : item
        );
      } else {
        // Handle objects
        result[key] = recursiveStripAsCellAndStreamFromSchema(
          value,
          context,
          depth + 1,
        );
      }
    }
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
