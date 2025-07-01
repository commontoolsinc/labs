import { isObject, isRecord } from "@commontools/utils/types";
import { type JSONSchema } from "./builder/types.ts";
import { type DocImpl, isDoc } from "./doc.ts";
import { type Cell, isCell, type MemorySpace } from "./cell.ts";
import {
  type JSONCellLink,
  type LegacyAlias,
  type LegacyDocCellLink as LegacyDocCellLink,
  LINK_V1_TAG,
  type SigilLink,
  type SigilValue,
  type SigilWriteRedirectLink,
  type URI,
} from "./sigil-types.ts";
import { toURI } from "./uri-utils.ts";
import { arrayEqual } from "./path-utils.ts";
import {
  getCellLinkOrThrow,
  isQueryResultForDereferencing,
  QueryResultInternals,
} from "./query-result-proxy.ts";

/**
 * Normalized link structure returned by parsers
 */
export type NormalizedLink = {
  id?: URI; // URI format with "of:" prefix
  path: string[];
  space?: MemorySpace;
  schema?: JSONSchema;
  rootSchema?: JSONSchema;
  overwrite?: "redirect"; // "this" gets normalized away to undefined
};

/**
 * Normalized link with required id and space (when base Cell is provided)
 */
export type NormalizedFullLink = {
  id: URI; // URI format with "of:" prefix
  path: string[];
  space: MemorySpace;
  schema?: JSONSchema;
  rootSchema?: JSONSchema;
  overwrite?: "redirect"; // "this" gets normalized away to undefined
};

/**
 * A type reflecting all possible link formats, including cells themselves.
 */
export type CellLink =
  | Cell<any>
  | SigilLink
  | QueryResultInternals
  | DocImpl<any> // @deprecated
  | LegacyDocCellLink // @deprecated
  | JSONCellLink // @deprecated
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
): value is LegacyDocCellLink | JSONCellLink {
  return isLegacyDocCellLink(value) || isJSONCellLink(value);
}

/**
 * Check if value is a legacy cell link.
 *
 * @deprecated Switch to isLink instead.
 *
 * @param {any} value - The value to check.
 * @returns {boolean}
 */
export function isLegacyDocCellLink(value: any): value is LegacyDocCellLink {
  return (
    isRecord(value) && isDoc(value.cell) && Array.isArray(value.path)
  );
}

/**
 * Check if value is a JSON cell link (storage format).
 *
 * @deprecated Switch to isLink instead.
 *
 * @param {any} value - The value to check.
 * @returns {boolean}
 */
export function isJSONCellLink(value: any): value is JSONCellLink {
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
 * @deprecated Switch to isLink instead.
 *
 * @param {any} value - The value to check.
 * @returns {boolean}
 */
export function isAnyCellLink(
  value: any,
): value is LegacyDocCellLink | SigilLink | JSONCellLink | LegacyAlias {
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
    isDoc(value) ||
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
  value:
    | Cell<any>
    | DocImpl<any>,
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
  base?: Cell | NormalizedLink,
): NormalizedLink | undefined;
export function parseLink(
  value: any,
  base?: Cell | NormalizedLink,
): NormalizedLink | undefined {
  // Has to be first, since below we check for "/" in value and we don't want to
  // see userland "/".
  if (isQueryResultForDereferencing(value)) value = getCellLinkOrThrow(value);

  if (isCell(value)) {
    return {
      id: toURI(value.getDoc().entityId),
      path: value.path.map((p) => p.toString()),
      space: value.space,
      schema: value.schema,
      rootSchema: value.rootSchema,
    };
  }

  if (isDoc(value)) {
    // Extract from DocImpl
    return {
      id: toURI(value.entityId),
      path: [],
      space: value.space,
    };
  }

  // Handle new sigil format
  if (isSigilLink(value)) {
    const link = value["/"][LINK_V1_TAG];

    // Resolve relative references
    let id = link.id;
    const path = link.path || [];
    const resolvedSpace = link.space || base?.space;

    // If no id provided, use base cell's document
    if (!id && base) {
      id = isCell(base) ? toURI(base.getDoc().entityId) : base.id;
    }

    return {
      id: id,
      path: path.map((p) => p.toString()),
      space: resolvedSpace,
      schema: link.schema,
      rootSchema: link.rootSchema,
      overwrite: link.overwrite === "redirect" ? "redirect" : undefined,
    };
  }

  // Handle legacy CellLink format (runtime format with DocImpl)
  if (isLegacyDocCellLink(value)) {
    return {
      id: toURI(value.cell.entityId),
      path: value.path.map((p) => p.toString()),
      space: value.cell.space,
      schema: value.schema,
      rootSchema: value.rootSchema,
    };
  }

  // Handle JSON CellLink format (storage format with { "/": string })
  if (isJSONCellLink(value)) {
    return {
      id: toURI(value.cell["/"]),
      path: value.path.map((p) => p.toString()),
      space: base?.space, // Space must come from context for JSON links
    };
  }

  if (isRecord(value) && "/" in value) {
    return {
      id: toURI(value["/"]),
      path: [],
      space: base?.space, // Space must come from context for JSON links
    };
  }

  // Handle legacy alias format
  if (isLegacyAlias(value)) {
    const alias = value.$alias;
    let id: URI | undefined;
    let resolvedSpace = base?.space;

    // If cell is provided, convert to URI
    if (alias.cell) {
      if (isDoc(alias.cell)) {
        id = toURI(alias.cell.entityId);
        resolvedSpace = alias.cell.space;
      } else if (isRecord(alias.cell) && "/" in alias.cell) {
        id = toURI(alias.cell);
      }
    }

    // If no cell provided, use base cell's document
    if (!id && base) {
      id = isCell(base) ? toURI(base.getDoc().entityId) : base.id;
    }

    return {
      id: id,
      path: Array.isArray(alias.path)
        ? alias.path.map((p) => p.toString())
        : [],
      space: resolvedSpace,
      schema: alias.schema as JSONSchema | undefined,
      rootSchema: alias.rootSchema as JSONSchema | undefined,
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
 * Parse a link to a legacy CellLink format
 *
 * @deprecated Switch to parseLink instead.
 *
 * @param value - The value to parse
 * @param baseCell - The base cell to use for resolving relative references
 * @returns The parsed cell link, or undefined if the value cannot be parsed
 */
export function parseToLegacyCellLink(
  value: CellLink,
  baseCell?: Cell,
): LegacyDocCellLink;
export function parseToLegacyCellLink(
  value: any,
  baseCell?: Cell,
): LegacyDocCellLink | undefined;
export function parseToLegacyCellLink(
  value: any,
  baseCell?: Cell,
): LegacyDocCellLink | undefined {
  const partial = parseToLegacyCellLinkWithMaybeACell(value, baseCell);
  if (!partial) return undefined;
  if (!isDoc(partial.cell)) throw new Error("No id or base cell provided");
  return partial as LegacyDocCellLink;
}

/**
 * Parse a link to a legacy Alias format
 *
 * @deprecated Switch to parseLink instead.
 *
 * @param value - The value to parse
 * @param baseCell - The base cell to use for resolving relative references
 * @returns The parsed alias, or undefined if the value cannot be parsed
 */
export function parseToLegacyAlias(
  value: CellLink,
): LegacyAlias;
export function parseToLegacyAlias(value: any): LegacyAlias | undefined;
export function parseToLegacyAlias(value: any): LegacyAlias | undefined {
  const partial = parseToLegacyCellLinkWithMaybeACell(value);
  if (!partial) return undefined;
  return { $alias: partial } as LegacyAlias;
}

function parseToLegacyCellLinkWithMaybeACell(
  value: any,
  baseCell?: Cell,
): Partial<LegacyDocCellLink> | undefined {
  // Has to be first, since below we check for "/" in value and we don't want to
  // see userland "/".
  if (isQueryResultForDereferencing(value)) value = getCellLinkOrThrow(value);

  // parseLink "forgets" the legacy docs, so we for now parse it here as well.
  // This is in case no baseCell was provided.
  const doc = isDoc(value)
    ? value
    : isCell(value)
    ? value.getDoc()
    : (isRecord(value) && isDoc((value as any).cell))
    ? (value as any).cell
    : (isRecord(value) && (value as any).$alias &&
        isDoc((value as any).$alias.cell))
    ? (value as any).$alias.cell
    : undefined;

  const link = parseLink(value, baseCell);
  if (!link) return undefined;

  const cellValue = doc ??
    (link.id && baseCell
      ? baseCell.getDoc().runtime!.documentMap.getDocByEntityId(
        link.space ?? baseCell!.space!,
        link.id!,
        true,
      )
      : undefined);

  return {
    cell: cellValue,
    path: link.path ?? [],
    space: link.space,
    schema: link.schema,
    rootSchema: link.rootSchema,
  } satisfies Partial<LegacyDocCellLink>;
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
  return (
    link1.id === link2.id &&
    link1.space === link2.space &&
    arrayEqual(link1.path, link2.path)
  );
}

export function createSigilLinkFromParsedLink(
  link: NormalizedLink,
  base?: Cell | NormalizedLink,
): SigilLink {
  const sigilLink: SigilLink = {
    "/": {
      [LINK_V1_TAG]: {
        path: link.path,
        schema: link.schema,
        rootSchema: link.rootSchema,
      },
    },
  };

  // Only add space if different from base
  if (link.space !== base?.space) {
    sigilLink["/"][LINK_V1_TAG].space = link.space;
  }

  // Only add id if different from base
  const baseId = base
    ? (isCell(base) ? toURI(base.getDoc().entityId) : base.id)
    : undefined;
  if (link.id !== baseId) {
    sigilLink["/"][LINK_V1_TAG].id = link.id;
  }

  // Only add overwrite if it's a redirect
  if (link.overwrite === "redirect") {
    sigilLink["/"][LINK_V1_TAG].overwrite = link.overwrite;
  }

  return sigilLink;
}
