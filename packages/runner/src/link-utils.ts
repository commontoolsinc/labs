import { isObject, isRecord } from "@commontools/utils/types";
import { type AnyCell, type JSONSchema } from "./builder/types.ts";
import {
  type Cell,
  isAnyCell,
  isCell,
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
import { getJSONFromDataURI, toURI } from "./uri-utils.ts";
import { arrayEqual } from "./path-utils.ts";
import {
  CellResultInternals,
  getCellOrThrow,
  isCellResultForDereferencing,
} from "./query-result-proxy.ts";
import type {
  IMemorySpaceAddress,
  MemoryAddressPathComponent,
} from "./storage/interface.ts";
import { ContextualFlowControl } from "./cfc.ts";
import { resolveLink } from "./link-resolution.ts";
import { IExtendedStorageTransaction } from "./storage/interface.ts";

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
  | CellResultInternals
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
  return isJSONCellLink(value) || isSigilLink(value) || isLegacyAlias(value);
}

/**
 * Check if value is any kind of link or linkable entity
 */
export function isLink(
  value: any,
): value is CellLink {
  return (
    isCellResultForDereferencing(value) ||
    isAnyCellLink(value) ||
    isCell(value) ||
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
  value: AnyCell<any>,
): NormalizedFullLink;
export function parseLink(
  value: CellLink,
  base: AnyCell<any> | NormalizedFullLink,
): NormalizedFullLink;
export function parseLink(
  value: CellLink,
  base?: AnyCell<any> | NormalizedLink,
): NormalizedLink;
export function parseLink(
  value: any,
  base: AnyCell<any> | NormalizedFullLink,
): NormalizedFullLink | undefined;
export function parseLink(
  value: any,
  base?: AnyCell<any> | NormalizedLink,
): NormalizedLink | undefined;
export function parseLink(
  value: any,
  base?: AnyCell<any> | NormalizedLink,
): NormalizedLink | undefined {
  // Has to be first, since below we check for "/" in value and we don't want to
  // see userland "/".
  if (isCellResultForDereferencing(value)) value = getCellOrThrow(value);

  if (isCell(value)) return value.getAsNormalizedFullLink();

  // Handle new sigil format
  if (isSigilLink(value)) {
    const link = value["/"][LINK_V1_TAG];

    // Resolve relative references
    let id = link.id;
    const path = link.path || [];
    const resolvedSpace = link.space || base?.space;

    // If no id provided, use base cell's document
    if (!id && base) {
      id = isAnyCell(base) ? toURI(base.entityId) : base.id;
    }

    return {
      ...(id && { id }),
      path: path.map((p) => p.toString()),
      ...(resolvedSpace && { space: resolvedSpace }),
      type: "application/json",
      ...(link.schema && { schema: link.schema }),
      ...(link.rootSchema && { rootSchema: link.rootSchema }),
      ...(link.overwrite === "redirect" && { overwrite: "redirect" }),
    };
  }

  // Handle JSON CellLink format (storage format with { "/": string })
  if (isJSONCellLink(value)) {
    return {
      id: toURI(value.cell["/"]),
      path: value.path.map((p) => p.toString()),
      ...(base?.space && { space: base.space }),
      type: "application/json",
    };
  }

  if (isRecord(value) && "/" in value) {
    return {
      id: toURI(value["/"]),
      path: [],
      ...(base?.space && { space: base.space }), // Space must come from context for JSON links
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
      id = isAnyCell(base) ? toURI(base.entityId) : base.id;
    }

    return {
      ...(id && { id }),
      path: Array.isArray(alias.path)
        ? alias.path.map((p) => p.toString())
        : [],
      ...(base?.space && { space: base.space }),
      type: "application/json",
      ...(alias.schema && { schema: alias.schema }),
      ...(alias.rootSchema && { rootSchema: alias.rootSchema }),
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
  resolveBeforeComparing?: boolean,
  txForResolving?: IExtendedStorageTransaction,
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
    link1 = isNormalizedFullLink(link1) ? resolveLink(tx, link1) : link1;
    link2 = isNormalizedFullLink(link2) ? resolveLink(tx, link2) : link2;
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
 * Find any data: URI links and inline them.
 *
 * @param value - The value to find and inline data: URI links in.
 * @returns The value with any data: URI links inlined.
 */
export function findAndInlineDataURILinks(value: any): any {
  if (isLink(value)) {
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
        if (isAnyCellLink(dataValue)) {
          // Parse the link found in the data URI
          // Do NOT pass parsedLink as base to avoid inheriting the data: URI id
          const newLink = parseLink(dataValue);
          let schema = newLink.schema;
          if (schema !== undefined && path.length > 0) {
            const cfc = new ContextualFlowControl();
            schema = cfc.getSchemaAtPath(schema, path, newLink.rootSchema);
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
      if (isAnyCellLink(value)) {
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
