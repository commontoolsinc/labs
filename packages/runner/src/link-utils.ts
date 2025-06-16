import { isRecord } from "@commontools/utils/types";
import { type DID } from "@commontools/identity";
import { type JSONSchema } from "./builder/types.ts";
import { isDoc } from "./doc.ts";
import {
  type CellLink,
  isAnyCellLink,
  isCell,
  isCellLink,
  isJSONCellLink,
  isSigilLink,
  isSigilValue,
  type JSONCellLink,
  type SigilAlias,
  type SigilLink,
} from "./cell.ts";
import { toURI } from "./uri-utils.ts";

/**
 * Normalized link structure returned by parsers
 */
export type NormalizedLink = {
  id: string; // URI format with "of:" prefix
  path: string[];
  space?: DID;
  schema?: JSONSchema;
};

/**
 * Check if value is any kind of link or linkable entity
 */
export function isLink(value: any): boolean {
  return (
    isAnyCellLink(value) ||
    isCell(value) ||
    isDoc(value) ||
    isAlias(value) ||
    (isRecord(value) && "/" in value) // EntityId format
  );
}

/**
 * Check if value is an alias in any format (old $alias or new sigil)
 */
export function isAlias(value: any): boolean {
  // Check legacy $alias format
  if (
    isRecord(value) &&
    "$alias" in value &&
    isRecord(value.$alias) &&
    Array.isArray(value.$alias.path)
  ) {
    return true;
  }

  // Check new sigil alias format
  if (
    isSigilValue(value) &&
    "alias-v0.1" in value["@"] &&
    isRecord(value["@"]["alias-v0.1"])
  ) {
    const alias = value["@"]["alias-v0.1"];
    // Either id or path must be present
    return typeof alias.id === "string" || Array.isArray(alias.path);
  }

  return false;
}

/**
 * Parse any link-like value to normalized format
 */
export function parseLink(
  value: any,
  baseCell?: CellLink,
  space?: DID,
): NormalizedLink | undefined {
  if (isCell(value)) {
    // Extract from Cell using its entityId and internal path
    const entityId = value.entityId;
    if (!entityId) return undefined;
    return {
      id: toURI(entityId),
      path: [], // Cells represent the root of their document
      space: value.getDoc().space,
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

  if (isRecord(value) && "/" in value) {
    // Handle direct EntityId format
    return {
      id: toURI(value),
      path: [],
      space: space,
    };
  }

  // Try parsing as cell link
  const cellLink = parseCellLink(value, baseCell, space);
  if (cellLink) return cellLink;

  // Try parsing as alias
  const alias = parseAlias(value, baseCell, space);
  if (alias) return alias;

  return undefined;
}

/**
 * Parse any link-like value to normalized format, throwing on failure
 */
export function parseLinkOrThrow(
  value: any,
  baseCell?: CellLink,
  space?: DID,
): NormalizedLink {
  const result = parseLink(value, baseCell, space);
  if (!result) {
    throw new Error(`Cannot parse value as link: ${JSON.stringify(value)}`);
  }
  return result;
}

/**
 * Parse cell link in any format to normalized structure
 */
export function parseCellLink(
  value: any,
  baseCell?: CellLink,
  space?: DID,
): NormalizedLink | undefined {
  if (!isAnyCellLink(value)) return undefined;

  // Handle legacy CellLink format (runtime format with DocImpl)
  if (isCellLink(value)) {
    const cellLink = value as CellLink;
    return {
      id: toURI(cellLink.cell.entityId),
      path: cellLink.path.map((p) => p.toString()),
      space: cellLink.space || cellLink.cell.space,
      schema: cellLink.schema,
    };
  }

  // Handle JSON CellLink format (storage format with { "/": string })
  if (isJSONCellLink(value)) {
    const jsonLink = value as JSONCellLink;
    return {
      id: toURI(jsonLink.cell["/"]),
      path: jsonLink.path.map((p) => p.toString()),
      space: space, // Space must come from context for JSON links
    };
  }

  // Handle new sigil format
  if (isSigilLink(value)) {
    const sigilLink = value as SigilLink;
    const link = sigilLink["@"]["link-v0.1"];

    // Resolve relative references
    let id = link.id;
    const path = link.path || [];
    let resolvedSpace = link.space || space;

    // If no id provided, use base cell's document
    if (!id && baseCell) {
      id = toURI(baseCell.cell.entityId);
      resolvedSpace = resolvedSpace || baseCell.space || baseCell.cell.space;
    }

    if (!id) {
      throw new Error(
        "Cannot resolve cell link: no id provided and no base cell",
      );
    }

    return {
      id,
      path: path.map((p) => p.toString()),
      space: resolvedSpace,
    };
  }

  return undefined;
}

/**
 * Parse cell link in any format to normalized structure, throwing on failure
 */
export function parseCellLinkOrThrow(
  value: any,
  baseCell?: CellLink,
  space?: DID,
): NormalizedLink {
  const result = parseCellLink(value, baseCell, space);
  if (!result) {
    throw new Error(
      `Cannot parse value as cell link: ${JSON.stringify(value)}`,
    );
  }
  return result;
}

/**
 * Parse alias in any format to normalized structure
 */
function parseAlias(
  value: any,
  baseCell?: CellLink,
  space?: DID,
): NormalizedLink | undefined {
  if (!isAlias(value)) return undefined;

  // Handle legacy $alias format
  if (
    isRecord(value) &&
    "$alias" in value &&
    isRecord(value.$alias) &&
    Array.isArray(value.$alias.path)
  ) {
    const alias = value.$alias as any; // Use any for legacy format
    let id: string | undefined;
    let resolvedSpace = space;

    // If cell is provided, convert to URI
    if (alias.cell) {
      if (isDoc(alias.cell)) {
        id = toURI(alias.cell.entityId);
        resolvedSpace = resolvedSpace || alias.cell.space;
      } else if (isRecord(alias.cell) && "/" in alias.cell) {
        id = toURI(alias.cell);
      }
    }

    // If no cell provided, use base cell's document
    if (!id && baseCell) {
      id = toURI(baseCell.cell.entityId);
      resolvedSpace = resolvedSpace || baseCell.space || baseCell.cell.space;
    }

    if (!id) {
      throw new Error(
        "Cannot resolve alias: no cell provided and no base cell",
      );
    }

    return {
      id,
      path: Array.isArray(alias.path)
        ? alias.path.map((p: any) => p.toString())
        : [],
      space: resolvedSpace,
      schema: alias.schema as JSONSchema | undefined,
    };
  }

  // Handle new sigil alias format
  if (
    isSigilValue(value) &&
    "alias-v0.1" in value["@"] &&
    isRecord(value["@"]["alias-v0.1"])
  ) {
    const sigilAlias = value as SigilAlias;
    const alias = sigilAlias["@"]["alias-v0.1"];

    // Resolve relative references
    let id = alias.id;
    const path = alias.path || [];
    let resolvedSpace = alias.space || space;

    // If no id provided, use base cell's document
    if (!id && baseCell) {
      id = toURI(baseCell.cell.entityId);
      resolvedSpace = resolvedSpace || baseCell.space || baseCell.cell.space;
    }

    if (!id) {
      throw new Error("Cannot resolve alias: no id provided and no base cell");
    }

    return {
      id,
      path: path.map((p) => p.toString()),
      space: resolvedSpace,
      schema: alias.schema,
    };
  }

  return undefined;
}

/**
 * Compare two link values for equality, supporting all link formats
 */
export function areLinksSame(
  value1: any,
  value2: any,
  baseCell?: CellLink,
  space?: DID,
): boolean {
  // If both are the same object, they're equal
  if (value1 === value2) return true;

  // If either is null/undefined, they're only equal if both are
  if (!value1 || !value2) return value1 === value2;

  // Try parsing both as links
  const link1 = parseLink(value1, baseCell, space);
  const link2 = parseLink(value2, baseCell, space);

  // If one parses and the other doesn't, they're not equal
  if (!link1 || !link2) return false;

  // Compare normalized links
  return (
    link1.id === link2.id &&
    link1.space === link2.space &&
    JSON.stringify(link1.path) === JSON.stringify(link2.path)
  );
}
