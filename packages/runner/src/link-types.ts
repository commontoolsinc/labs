import { isRecord } from "@commonfabric/utils/types";
import { cellRefInner, isCellRef } from "@commonfabric/data-model/cell-rep";
import {
  type CellScope,
  type JSONSchema,
  type LinkScope,
} from "./builder/types.ts";
import { type MemorySpace } from "./cell.ts";
import {
  type LegacyAlias,
  type SigilLink,
  type SigilWriteRedirectLink,
  type URI,
} from "./sigil-types.ts";
import { arrayEqual } from "./path-utils.ts";
import type {
  IMemorySpaceAddress,
  MemoryAddressPathComponent,
} from "./storage/interface.ts";

const CELL_SCOPE_VALUES = new Set(["space", "user", "session"]);

function parseScopedIdSegment(idSegment: string): {
  id: string;
  scope?: CellScope;
} {
  const scopeSeparator = idSegment.lastIndexOf("@");
  if (scopeSeparator === -1) return { id: idSegment };

  const id = idSegment.slice(0, scopeSeparator);
  const scope = idSegment.slice(scopeSeparator + 1);
  if (!id || !CELL_SCOPE_VALUES.has(scope)) {
    throw new Error(
      `Invalid scope suffix "@${scope}" in link handle. Expected @space, @user, or @session.`,
    );
  }

  return { id, scope: scope as CellScope };
}

/**
 * Normalized link structure returned by parsers
 */
export type NormalizedLink = {
  id?: URI; // URI format with "of:" prefix
  path: readonly MemoryAddressPathComponent[];
  space?: MemorySpace;
  scope?: LinkScope;
  schema?: JSONSchema;
  overwrite?: "redirect"; // "this" gets normalized away to undefined
};

/**
 * Full normalized link from a complete link, i.e. with required id and space.
 * Gets created by parseLink if a base is provided.
 *
 * Normalized link paths are value-relative. Use `toMemorySpaceAddress` when a
 * document-root memory address is required.
 */
export type NormalizedFullLink = NormalizedLink & {
  id: URI;
  space: MemorySpace;
  scope: CellScope;
};

export type ValuePath = readonly ["value", ...string[]];
export type IMemorySpaceValueAddress = IMemorySpaceAddress & {
  path: ValuePath;
};
/**
 * Convert a value-relative normalized link into a document-root memory address.
 */
export function toMemorySpaceAddress(
  link: NormalizedFullLink,
): IMemorySpaceValueAddress {
  return {
    space: link.space,
    id: link.id,
    scope: link.scope,
    path: ["value", ...link.path],
  };
}

/**
 * Primitive cell link types that can be serialized.
 */
export type PrimitiveCellLink =
  | SigilLink
  | LegacyAlias; // @deprecated

export function isSigilLink(value: any): value is SigilLink {
  return isCellRef(value);
}

export function isPrimitiveCellLink(
  value: any,
): value is PrimitiveCellLink {
  return isSigilLink(value) ||
    isLegacyAlias(value);
}

export function isNormalizedLink(value: any): value is NormalizedLink {
  if (!isRecord(value)) return false;
  const { path, id, space, scope } = value;
  return Array.isArray(path) &&
    (typeof id === "string" || id === undefined) &&
    (typeof space === "string" || space === undefined) &&
    (scope === undefined || scope === "inherit" || scope === "space" ||
      scope === "user" || scope === "session");
}

/**
 * Check if value is a normalized full link.
 *
 * Beware: Unlike all the other types that `isLink` is checking for, this could
 * appear in regular data and not actually be meant as a link. So only use this
 * if you know for sure that the value is a link.
 *
 * We don't verify that the id and space are URI or MemorySpace, but we do
 * verify that they are strings.
 */
export function isNormalizedFullLink(value: any): value is NormalizedFullLink {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.space === "string" &&
    (value.scope === "space" || value.scope === "user" ||
      value.scope === "session") &&
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
    return cellRefInner(value).overwrite === "redirect";
  }

  return false;
}

/**
 * Check if value is a legacy alias.
 *
 * While legacy aliases are no longer used as links, we do still use them in
 * bindings in the intermediate form where we don't have enough detail to
 * point to an actual cell.
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
    const link = cellRefInner(value);

    // Resolve relative references
    let id = link.id;
    const path = link.path || [];
    const resolvedSpace = link.space || base?.space;
    const resolvedScope = link.scope === undefined || link.scope === "inherit"
      ? base?.scope
      : link.scope;

    // If no id provided, use base cell's document
    if (!id && base) {
      id = base.id;
    }

    return {
      ...(id && { id }),
      path: path.map((p) => p.toString()),
      ...(resolvedSpace && { space: resolvedSpace }),
      ...(resolvedScope && { scope: resolvedScope }),
      ...(link.schema !== undefined && { schema: link.schema }),
      ...(link.overwrite === "redirect" && { overwrite: "redirect" }),
    };
  } else if (isLegacyAlias(value)) {
    const alias = value.$alias;
    // Named-cell ("argument"/"result") and partialCause aliases carry no
    // absolute id of their own here, so resolve to the base cell's document.
    const id = base?.id;

    return {
      ...(id && { id }),
      path: alias.path,
      ...(base?.space && { space: base.space }),
      ...(alias.scope !== undefined
        ? { scope: alias.scope }
        : base?.scope
        ? { scope: base.scope }
        : {}),
      ...(alias.schema !== undefined && { schema: alias.schema }),
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
    (link1.scope ?? "space") === (link2.scope ?? "space") &&
    arrayEqual(link1.path, link2.path);
}

export function areNormalizedLinksSameIgnoringScope(
  link1: NormalizedLink,
  link2: NormalizedLink,
): boolean {
  return link1.id === link2.id && link1.space === link2.space &&
    arrayEqual(link1.path, link2.path);
}

/**
 * Serialize an address to a string key for use in Maps/Sets/memoization.
 * Includes space, id, and path — the same fields compared by
 * areNormalizedLinksSame for document links.
 *
 * Because links are relative to "value", the IMemorySpaceAddress and
 * NormalizedFullLink version of the same address will return different
 * keys, so they should not be mixed up.
 */
type ScopedMemorySpaceAddress = IMemorySpaceAddress & { scope: CellScope };

export function addressKey(
  addr: ScopedMemorySpaceAddress | NormalizedFullLink,
): string {
  return JSON.stringify([
    addr.space,
    addr.id,
    addr.scope,
    addr.path,
  ]);
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
 * - Standard: /of:fid1:abc123/path
 * - Cross-space: /@did:key:z6Mk.../of:fid1:abc123/path
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
      'Target must include a piece handle, e.g. "/of:fid1:abc123/path".',
    );
  }

  const [empty, firstSegment, ...rest] = decodeJsonPointer(target);

  if (empty !== "") {
    throw new Error("Target must start with a slash.");
  }

  // Check if first segment is a space DID (cross-space link)
  let id: string | undefined;
  let path: string[];
  const spaceMatch = firstSegment?.match(matchSpacePrefix);
  if (spaceMatch) {
    // Cross-space format: /@did:key:z6Mk.../of:fid1:abc123/path
    const embeddedSpace = spaceMatch[1] as MemorySpace;
    [id, ...path] = rest;
    space = embeddedSpace;
  } else {
    // Standard format: /of:fid1:abc123/path
    id = firstSegment;
    path = rest;
  }
  if (id === undefined) {
    throw new Error(
      'Target must include a piece handle, e.g. "/of:fid1:abc123/path".',
    );
  }
  const scopedId = parseScopedIdSegment(id);
  id = scopedId.id;

  // Check if first segment looks like a CID/handle by length
  //
  // CIDs are long encoded strings (typically 40+ chars), whereas human names
  // are short. Use a conservative threshold to distinguish handles from
  // human-readable names Handle format is "/of:..." (the internal storage
  // format)
  if (id === undefined || id.length < 20) {
    throw new Error(
      `Piece references must use handles (e.g., "/of:fid1:abc123/path"), not human names (e.g., "${id}").`,
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
    ...(scopedId.scope && { scope: scopedId.scope }),
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
  const id = link.scope && link.scope !== "space"
    ? `${link.id}@${link.scope}`
    : link.id;
  // If contextSpace provided and differs, include space in link
  if (contextSpace && link.space && link.space !== contextSpace) {
    return encodeJsonPointer(["", `@${link.space}`, id, ...link.path]);
  }
  return encodeJsonPointer(["", id, ...link.path]);
}
