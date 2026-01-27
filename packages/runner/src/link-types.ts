import { isObject, isRecord } from "@commontools/utils/types";
import { type JSONSchema } from "./builder/types.ts";
import { type MemorySpace } from "./cell.ts";
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
 * Primitive cell link types that can be serialized.
 */
export type PrimitiveCellLink =
  | SigilLink
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
 * Check if value is a JSON cell link (storage format).
 * @deprecated Switch to isLink instead.
 */
export function isJSONCellLink(value: any): value is LegacyJSONCellLink {
  return (
    isRecord(value) &&
    isRecord(value.cell) &&
    typeof value.cell["/"] === "string" &&
    Array.isArray(value.path)
  );
}

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
 * Check if value is a deprecated link of type `{ "/": <string> }`
 * @deprecated Switch to isLink instead.
 */
export function isDeprecatedStringLink(
  value: any,
): value is { "/": string } {
  return isRecord(value) && "/" in value && typeof value["/"] === "string"; // EntityId format
}

export function isPrimitiveCellLink(
  value: any,
): value is PrimitiveCellLink {
  return isSigilLink(value) ||
    isJSONCellLink(value) ||
    isLegacyAlias(value) || isDeprecatedStringLink(value);
}

export function isNormalizedLink(value: any): value is NormalizedLink {
  if (!isRecord(value)) return false;
  const { path, id, type, space } = value;
  return Array.isArray(path) &&
    (typeof id === "string" || id === undefined) &&
    (typeof type === "string" || type === undefined) &&
    (typeof space === "string" || space === undefined);
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
 * @deprecated Switch to isWriteRedirectLink instead.
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
export function parseLinkPrimitive(
  value: PrimitiveCellLink,
  base?: NormalizedLink,
): NormalizedLink {
  if (isSigilLink(value)) {
    const link = value["/"][LINK_V1_TAG];

    // Resolve relative references
    let id = link.id;
    const path = link.path || [];
    const resolvedSpace = link.space || base?.space;

    // If no id provided, use base cell's document
    if (!id && base) {
      id = base.id;
    }

    return {
      ...(id && { id }),
      path: path.map((p) => p.toString()),
      ...(resolvedSpace && { space: resolvedSpace }),
      type: "application/json",
      ...(link.schema !== undefined && { schema: link.schema }),
      ...(link.rootSchema !== undefined && { rootSchema: link.rootSchema }),
      ...(link.overwrite === "redirect" && { overwrite: "redirect" }),
    };
  } else if (isJSONCellLink(value)) {
    return {
      id: toURI(value.cell["/"]),
      path: value.path.map((p) => p.toString()),
      ...(base?.space && { space: base.space }),
      type: "application/json",
    };
  } else if (isDeprecatedStringLink(value)) {
    return {
      id: toURI(value["/"]),
      path: [],
      ...(base?.space && { space: base.space }), // Space must come from context for JSON links
      type: "application/json",
    };
  } else if (isLegacyAlias(value)) {
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
      id = base.id;
    }

    return {
      ...(id && { id }),
      path: Array.isArray(alias.path)
        ? alias.path.map((p) => p.toString())
        : [],
      ...(base?.space && { space: base.space }),
      type: "application/json",
      ...(alias.schema !== undefined && { schema: alias.schema }),
      ...(alias.rootSchema !== undefined && { rootSchema: alias.rootSchema }),
      overwrite: "redirect",
    };
  }
  throw new Error(`Link is not a primitive: ${value}`);
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
 * Encodes a JSON Pointer path according to RFC 6901.
 * Each token has ~ replaced with ~0 and / replaced with ~1, then joined with /.
 * @param path - Array of path tokens to encode
 * @returns The encoded JSON Pointer string
 */
export function encodeJsonPointer(path: readonly string[]): string {
  return path
    .map((token) => token.replace(/~/g, "~0").replace(/\//g, "~1"))
    .join("/");
}

/**
 * Decodes a JSON Pointer string according to RFC 6901.
 * Splits by / then replaces ~1 with / and ~0 with ~ in each token.
 * @param pointer - The JSON Pointer string to decode
 * @returns Array of decoded path tokens
 */
export function decodeJsonPointer(pointer: string): string[] {
  return pointer
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

// Matches both standard links (/of:...) and cross-space links (/@did:...)
export const matchLLMFriendlyLink = new RegExp("^/[@a-zA-Z0-9]+:");

// Matches a space DID prefix in a link (/@did:key:z6Mk...)
const matchSpacePrefix = new RegExp("^@(did:[^:]+:[^/]+)$");

/**
 * Parses a LLM friendly link from a target string.
 * Supports both standard and cross-space formats:
 * - Standard: /of:bafyabc123/path
 * - Cross-space: /@did:key:z6Mk.../of:bafyabc123/path
 *
 * @param target - The target string to parse
 * @param space - The fallback space to use if not embedded in link
 * @returns The parsed LLM friendly link
 */
export function parseLLMFriendlyLink(
  target: string,
  space: MemorySpace,
): NormalizedFullLink;
export function parseLLMFriendlyLink(
  target: string,
  space?: MemorySpace,
): NormalizedLink;
export function parseLLMFriendlyLink(
  target: string,
  space?: MemorySpace,
): NormalizedLink {
  target = target.trim();

  if (!matchLLMFriendlyLink.test(target)) {
    throw new Error(
      'Target must include a charm handle, e.g. "/of:bafyabc123/path".',
    );
  }

  const [empty, firstSegment, ...rest] = decodeJsonPointer(target);

  if (empty !== "") {
    throw new Error("Target must start with a slash.");
  }

  // Check if first segment is a space DID (cross-space link)
  let id: string;
  let path: string[];
  const spaceMatch = firstSegment?.match(matchSpacePrefix);
  if (spaceMatch) {
    // Cross-space format: /@did:key:z6Mk.../of:bafyabc123/path
    const embeddedSpace = spaceMatch[1] as MemorySpace;
    [id, ...path] = rest;
    space = embeddedSpace;
  } else {
    // Standard format: /of:bafyabc123/path
    id = firstSegment;
    path = rest;
  }

  // Check if first segment looks like a CID/handle by length
  //
  // CIDs are long encoded strings (typically 40+ chars), whereas human names
  // are short. Use a conservative threshold to distinguish handles from
  // human-readable names Handle format is "/of:..." (the internal storage
  // format)
  if (id === undefined || id.length < 20) {
    throw new Error(
      `Charm references must use handles (e.g., "/of:bafyabc123/path"), not human names (e.g., "${id}").`,
    );
  }

  // Remove path element from trailing slash
  if (path.length > 0 && path[path.length - 1] === "") {
    path.pop();
  }

  return {
    id: id as `${string}:${string}`,
    path,
    ...(space && { space }),
    type: "application/json",
  };
}

/**
 * Creates an LLM-friendly link string from a normalized link.
 * If contextSpace is provided and differs from the link's space,
 * includes the space DID in the link for cross-space resolution.
 *
 * @param link - The normalized link to encode
 * @param contextSpace - The current execution space (optional)
 * @returns The encoded link string
 */
export function createLLMFriendlyLink(
  link: NormalizedFullLink,
  contextSpace?: MemorySpace,
): string {
  // If contextSpace provided and differs, include space in link
  if (contextSpace && link.space && link.space !== contextSpace) {
    return encodeJsonPointer(["", `@${link.space}`, link.id, ...link.path]);
  }
  return encodeJsonPointer(["", link.id, ...link.path]);
}
