import { isObject, isRecord } from "@commontools/utils/types";
import { type JSONSchema } from "./builder/types.ts";
import {
  type Cell,
  isCell,
  isStream,
  type MemorySpace,
  type Stream,
} from "./cell.ts";
import {
  type LegacyAlias,
  type LegacyJSONCellLink,
  LINK_V1_TAG,
  type SigilLink,
  type SigilValue,
  type SigilWriteRedirectLink,
  type URI,
} from "./sigil-types.ts";
import { toURI } from "./uri-utils.ts";
import { arrayEqual } from "./path-utils.ts";
import {
  getCellOrThrow,
  isQueryResultForDereferencing,
  QueryResultInternals,
} from "./query-result-proxy.ts";
import type {
  IMemorySpaceAddress,
  MemoryAddressPathComponent,
} from "./storage/interface.ts";

/**
 * Normalized link structure returned by parsers
 */
export type NormalizedLink = {
  id?: URI; // URI format with "of:" prefix
  path: readonly MemoryAddressPathComponent[];
  space?: MemorySpace;
  type?: string; // Default is "application/json"
  schema?: JSONSchema;
  rootSchema?: JSONSchema;
  overwrite?: "redirect"; // "this" gets normalized away to undefined
};

/**
 * Full normalized link that from a complete link, i.e. with required id, space
 * and type. Gets created by parseLink if a base is provided.
 *
 * Any such link can be used as a memory address.
 */
export type NormalizedFullLink = NormalizedLink & IMemorySpaceAddress;

/**
 * A type reflecting all possible link formats, including cells themselves.
 */
export type CellLink =
  | Cell<any>
  | Stream<any>
  | SigilLink
  | QueryResultInternals
  | LegacyJSONCellLink // @deprecated
  | LegacyAlias // @deprecated
  | { "/": string }; // @deprecated

/**
 * Check if value is a sigil value with any type
 *
 * Any object that is strictly `{ "/": Record<string, any> }`, no other props
 */
export function isSigilValue(value: any): value is SigilValue<any> {
  return isRecord(value) &&
    "/" in value &&
    Object.keys(value).length === 1 &&
    isObject(value["/"]);
}

/**
 * Check if value is a legacy cell link.
 *
 * @deprecated Switch to isLink instead.
 *
 * @param {any} value - The value to check.
 * @returns {boolean}
 */
export function isLegacyCellLink(
  value: any,
): value is LegacyJSONCellLink {
  return isJSONCellLink(value);
}

/**
 * Check if value is a JSON cell link (storage format).
 *
 * @deprecated Switch to isLink instead.
 *
 * @param {any} value - The value to check.
 * @returns {boolean}
 */
export function isJSONCellLink(value: any): value is LegacyJSONCellLink {
  return (
    isRecord(value) &&
    isRecord(value.cell) &&
    typeof value.cell["/"] === "string" &&
    Array.isArray(value.path)
  );
}

/**
 * Check if value is a sigil link.
 */
export function isSigilLink(value: any): value is SigilLink {
  return (isSigilValue(value) && LINK_V1_TAG in value["/"]);
}

/**
 * Check if value is a sigil alias (link with overwrite field).
 */
export function isSigilWriteRedirectLink(
  value: any,
): value is SigilWriteRedirectLink {
  return isSigilLink(value) &&
    value["/"][LINK_V1_TAG].overwrite === "redirect";
}

/**
 * Check if value is any kind of cell link format.
 *
 * @param {any} value - The value to check.
 * @returns {boolean}
 */
export function isAnyCellLink(
  value: any,
): value is SigilLink | LegacyJSONCellLink | LegacyAlias {
  return isLegacyCellLink(value) || isJSONCellLink(value) ||
    isSigilLink(value) ||
    isLegacyAlias(value);
}

/**
 * Check if value is any kind of link or linkable entity
 */
export function isLink(
  value: any,
): value is CellLink {
  return (
    isQueryResultForDereferencing(value) ||
    isAnyCellLink(value) ||
    isCell(value) ||
    isStream(value) ||
    (isRecord(value) && "/" in value && typeof value["/"] === "string") // EntityId format
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
 * Check if value is an alias in any format (old $alias or new sigil)
 */
export function isWriteRedirectLink(
  value: any,
): value is LegacyAlias | SigilWriteRedirectLink {
  // Check legacy $alias format
  if (isLegacyAlias(value)) {
    return true;
  }

  // Check new sigil format (link@1 with overwrite field)
  if (isSigilLink(value)) {
    return value["/"][LINK_V1_TAG].overwrite === "redirect";
  }

  return false;
}

/**
 * Check if value is a legacy alias.
 *
 * @deprecated Switch to isWriteRedirectLink instead.
 *
 * @param {any} value - The value to check.
 * @returns {boolean}
 */
export function isLegacyAlias(value: any): value is LegacyAlias {
  return isRecord(value) && "$alias" in value && isRecord(value.$alias) &&
    Array.isArray(value.$alias.path);
}

/**
 * Parse any link-like value to normalized format
 *
 * Overloads just help make fields non-optional that can be guaranteed to exist
 * in various combinations.
 */
export function parseLink(
  value: Cell<any> | Stream<any>,
  base?: Cell | NormalizedLink,
): NormalizedFullLink;
export function parseLink(
  value: CellLink,
  base: Cell | NormalizedFullLink,
): NormalizedFullLink;
export function parseLink(
  value: CellLink,
  base?: Cell | NormalizedLink,
): NormalizedLink;
export function parseLink(
  value: any,
  base: Cell | NormalizedFullLink,
): NormalizedFullLink | undefined;
export function parseLink(
  value: any,
  base?: Cell | NormalizedLink,
): NormalizedLink | undefined;
export function parseLink(
  value: any,
  base?: Cell | NormalizedLink,
): NormalizedLink | undefined {
  // Has to be first, since below we check for "/" in value and we don't want to
  // see userland "/".
  if (isQueryResultForDereferencing(value)) value = getCellOrThrow(value);

  if (isCell(value) || isStream(value)) return value.getAsNormalizedFullLink();

  // Handle new sigil format
  if (isSigilLink(value)) {
    const link = value["/"][LINK_V1_TAG];

    // Resolve relative references
    let id = link.id;
    const path = link.path || [];
    const resolvedSpace = link.space || base?.space;

    // If no id provided, use base cell's document
    if (!id && base) {
      id = isCell(base) ? toURI(base.entityId) : base.id;
    }

    return {
      id: id,
      path: path.map((p) => p.toString()),
      space: resolvedSpace,
      type: "application/json",
      schema: link.schema,
      rootSchema: link.rootSchema,
      overwrite: link.overwrite === "redirect" ? "redirect" : undefined,
    };
  }

  // Handle JSON CellLink format (storage format with { "/": string })
  if (isJSONCellLink(value)) {
    return {
      id: toURI(value.cell["/"]),
      path: value.path.map((p) => p.toString()),
      space: base?.space, // Space must come from context for JSON links
      type: "application/json",
    };
  }

  if (isRecord(value) && "/" in value) {
    return {
      id: toURI(value["/"]),
      path: [],
      space: base?.space, // Space must come from context for JSON links
      type: "application/json",
    };
  }

  // Handle legacy alias format
  if (isLegacyAlias(value)) {
    const alias = value.$alias;
    let id: URI | undefined;

    // If cell is provided, convert to URI
    if (alias.cell) {
      if (isRecord(alias.cell) && "/" in alias.cell) {
        id = toURI(alias.cell);
      }
    }

    // If no cell provided, use base cell's document
    if (!id && base) {
      id = isCell(base) ? toURI(base.entityId) : base.id;
    }

    return {
      id: id,
      path: Array.isArray(alias.path)
        ? alias.path.map((p) => p.toString())
        : [],
      space: base?.space,
      type: "application/json",
      schema: alias.schema as JSONSchema | undefined,
      rootSchema: alias.rootSchema as JSONSchema | undefined,
      overwrite: "redirect",
    };
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
): boolean {
  // If both are the same object, they're equal
  if (value1 === value2) return true;

  // If either is null/undefined, they're only equal if both are
  if (!value1 || !value2) return value1 === value2;

  // Try parsing both as links
  const link1 = parseLink(value1, base);
  const link2 = parseLink(value2, base);

  // If one parses and the other doesn't, they're not equal
  if (!link1 || !link2) return false;

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
  if (options.includeSchema && link.schema) {
    reference.schema = sanitizeSchemaForLinks(link.schema);
    reference.rootSchema = sanitizeSchemaForLinks(link.rootSchema);
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
 * Traverse schema and remove all asCell and asStream flags.
 */
export function sanitizeSchemaForLinks(
  schema: JSONSchema,
  options?: { keepStreams?: boolean },
): JSONSchema;
export function sanitizeSchemaForLinks(
  schema: JSONSchema | undefined,
  options?: { keepStreams?: boolean },
): JSONSchema | undefined;
export function sanitizeSchemaForLinks(
  schema: JSONSchema | undefined,
  options: { keepStreams?: boolean } = {},
): JSONSchema | undefined {
  return recursiveStripAsCellAndStreamFromSchema(schema, options);
}

function recursiveStripAsCellAndStreamFromSchema(
  schema: any,
  options: { keepStreams?: boolean },
): any {
  // Handle null/undefined/boolean schemas
  if (
    schema === null || typeof schema !== "object" || typeof schema === "boolean"
  ) {
    return schema;
  }

  // Create a copy to avoid mutating the original
  const result = { ...schema };

  // Remove asCell and asStream flags from this level
  delete (result as any).asCell;
  if (!options.keepStreams) delete (result as any).asStream;

  // Recursively process all object properties
  for (const [key, value] of Object.entries(result)) {
    if (value && typeof value === "object") {
      if (Array.isArray(value)) {
        // Handle arrays
        (result as any)[key] = value.map((item) =>
          typeof item === "object" && item !== null
            ? recursiveStripAsCellAndStreamFromSchema(item, options)
            : item
        );
      } else {
        // Handle objects
        (result as any)[key] = recursiveStripAsCellAndStreamFromSchema(
          value,
          options,
        );
      }
    }
  }

  return result;
}
