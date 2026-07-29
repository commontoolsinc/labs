import type { MemorySpace } from "@commonfabric/memory/interface";
import type { CellScope } from "../builder/types.ts";
import { normalizeCellScope } from "../scope.ts";
import type { IMemorySpaceAddress, URI } from "../storage/interface.ts";
import type { SpaceScopeAndURI } from "./types.ts";

export function entityKey(
  address: Pick<IMemorySpaceAddress, "space" | "id" | "scope">,
): SpaceScopeAndURI {
  return `${address.space}/${normalizeCellScope(address.scope)}/${address.id}`;
}

/**
 * The inverse of `entityKey`. A space is a DID and a scope is one of a small
 * fixed set of words, and neither contains a slash, so the first two slashes
 * delimit them. Everything after the second slash is the identifier, which may
 * contain slashes of its own: a `data:` identifier, which carries a frozen
 * value rather than naming a stored document, holds a MIME type and the value
 * itself.
 */
export function parseEntityKey(
  key: SpaceScopeAndURI,
): { space: MemorySpace; scope: CellScope; id: URI } {
  const firstSlash = key.indexOf("/");
  const secondSlash = key.indexOf("/", firstSlash + 1);
  return {
    space: key.slice(0, firstSlash) as MemorySpace,
    scope: key.slice(firstSlash + 1, secondSlash) as CellScope,
    id: key.slice(secondSlash + 1) as URI,
  };
}
