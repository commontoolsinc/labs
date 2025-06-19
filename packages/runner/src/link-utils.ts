import { isRecord } from "@commontools/utils/types";
import { type JSONSchema } from "./builder/types.ts";
import { isDoc } from "./doc.ts";
import {
  type Cell,
  type CellLink,
  EMBED_V1_TAG,
  isAnyCellLink,
  isCell,
  isCellLink,
  isJSONCellLink,
  isSigilEmbed,
  isSigilValue,
  type JSONCellLink,
  type LegacyAlias,
  type MemorySpace,
  type SigilEmbed,
  type SigilWritethroughEmbed,
} from "./cell.ts";
import { toURI } from "./uri-utils.ts";
import { arrayEqual } from "./type-utils.ts";
import {
  getCellLinkOrThrow,
  isQueryResultForDereferencing,
} from "./query-result-proxy.ts";
import { type IRuntime } from "./runtime.ts";

/**
 * Normalized link structure returned by parsers
 */
export type NormalizedLink = {
  id: string; // URI format with "of:" prefix
  path: string[];
  space?: MemorySpace;
  schema?: JSONSchema;
  rootSchema?: JSONSchema;
  replace?: "destination";
};

/**
 * Check if value is any kind of link or linkable entity
 */
export function isLink(value: any): boolean {
  return (
    isAnyCellLink(value) ||
    isCell(value) ||
    isDoc(value) ||
    isWritethroughEmbed(value) ||
    (isRecord(value) && "/" in value) // EntityId format
  );
}

/**
 * Check if value is an alias in any format (old $alias or new sigil)
 */
export function isWritethroughEmbed(
  value: any,
): value is LegacyAlias | SigilWritethroughEmbed {
  // Check legacy $alias format
  if (isLegacyAlias(value)) {
    return true;
  }

  // Check new sigil format (embed@1 with replace field)
  if (
    isSigilValue(value) && EMBED_V1_TAG in value["/"] &&
    isRecord(value["/"][EMBED_V1_TAG])
  ) {
    const embed = value["/"][EMBED_V1_TAG];
    return (typeof embed.id === "string" || Array.isArray(embed.path)) &&
      embed.replace === "destination";
  }

  return false;
}

export function isLegacyAlias(value: any): value is LegacyAlias {
  return isRecord(value) && "$alias" in value && isRecord(value.$alias) &&
    Array.isArray(value.$alias.path);
}

/**
 * Parse any link-like value to normalized format
 */
export function parseLink(
  value: any,
  base?: Cell | NormalizedLink,
): NormalizedLink | undefined {
  if (isQueryResultForDereferencing(value)) value = getCellLinkOrThrow(value);

  if (isCell(value)) {
    // Extract from Cell using its entityId and internal path
    const entityId = value.entityId;
    if (!entityId) return undefined;
    return {
      id: toURI(entityId),
      path: [], // Cells represent the root of their document
      space: value.getDoc().space,
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
  if (isSigilEmbed(value)) {
    const sigilLink = value as SigilEmbed;
    const link = sigilLink["/"][EMBED_V1_TAG];

    // Resolve relative references
    let id = link.id;
    const path = link.path || [];
    const resolvedSpace = link.space || base?.space;

    // If no id provided, use base cell's document
    if (!id && base) id = isCell(base) ? toURI(base.entityId) : base.id;

    if (!id) {
      throw new Error(
        "Cannot resolve cell link: neither id nor base provided",
      );
    }

    return {
      id,
      path: path.map((p) => p.toString()),
      space: resolvedSpace,
      schema: link.schema,
      rootSchema: link.rootSchema,
      replace: link.replace,
    };
  }

  // Handle legacy CellLink format (runtime format with DocImpl)
  if (isCellLink(value)) {
    const cellLink = value as CellLink;
    return {
      id: toURI(cellLink.cell.entityId),
      path: cellLink.path.map((p) => p.toString()),
      space: cellLink.cell.space,
      schema: cellLink.schema,
      rootSchema: cellLink.rootSchema,
    };
  }

  // Handle JSON CellLink format (storage format with { "/": string })
  if (isJSONCellLink(value)) {
    const jsonLink = value as JSONCellLink;
    return {
      id: toURI(jsonLink.cell["/"]),
      path: jsonLink.path.map((p) => p.toString()),
      space: base?.space, // Space must come from context for JSON links
    };
  }

  // Handle legacy alias format
  if (
    isRecord(value) &&
    "$alias" in value &&
    isRecord(value.$alias) &&
    Array.isArray(value.$alias.path)
  ) {
    const alias = value.$alias as LegacyAlias["$alias"];
    let id: string | undefined;
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
    if (!id && base) id = isCell(base) ? toURI(base.entityId) : base.id;

    if (!id) {
      throw new Error(
        "Cannot resolve alias: neither id nor base provided",
      );
    }

    return {
      id,
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
 */
export function parseToLegacyCellLink(
  value: any,
  baseCell?: Cell,
): CellLink | undefined {
  if (!value) return undefined;

  // parseLink "forgets" the legacy docs, so we for now parse it here as well.
  // This is in case no baseCell was provided.
  const doc = isDoc(value)
    ? value
    : (isRecord(value) && isDoc((value as any).cell))
    ? (value as any).cell
    : (isRecord(value) && (value as any).$alias &&
        isDoc((value as any).$alias.cell))
    ? (value as any).$alias.cell
    : undefined;

  const link = parseLink(value, baseCell);
  if (!link) return undefined;

  if (!doc && !baseCell) {
    throw new Error("No base cell, but link only had id");
  }

  return {
    cell: doc ?? baseCell!.getDoc().runtime!.documentMap.getDocByEntityId(
      link.space ?? baseCell!.space!,
      link.id,
      true,
    )!,
    path: link.path,
    space: link.space,
    schema: link.schema,
    rootSchema: link.rootSchema,
  } satisfies CellLink;
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
