import type { IMemoryAddress } from "../interface.ts";
import { normalizeCellScope } from "../../scope.ts";
import { hasDataUriScheme } from "@commonfabric/data-model/data-uri-codec";
export const toString = (address: IMemoryAddress) =>
  `/${normalizeCellScope(address.scope)}/${address.id}/${
    JSON.stringify(address.path)
  }`;

/**
 * Returns true if `candidate` address references location within the
 * the `source` address. Otherwise returns false.
 */
export const includes = (
  source: IMemoryAddress,
  candidate: IMemoryAddress,
) => {
  if (
    source.id !== candidate.id ||
    normalizeCellScope(source.scope) !== normalizeCellScope(candidate.scope)
  ) {
    return false;
  }

  // Check if candidate path starts with source path
  if (candidate.path.length < source.path.length) {
    return false;
  }

  // Compare each path element
  for (let i = 0; i < source.path.length; i++) {
    if (source.path[i] !== candidate.path[i]) {
      return false;
    }
  }

  return true;
};

export const intersects = (
  source: IMemoryAddress,
  candidate: IMemoryAddress,
) => {
  if (
    source.id !== candidate.id ||
    normalizeCellScope(source.scope) !== normalizeCellScope(candidate.scope)
  ) {
    return false;
  }

  // Check if either path is a prefix of the other
  const minLength = Math.min(source.path.length, candidate.path.length);

  for (let i = 0; i < minLength; i++) {
    if (source.path[i] !== candidate.path[i]) {
      return false;
    }
  }

  return true;
};

/**
 * Returns true if the address is served by decoding its own id -- a `data:`
 * URI carrying the value -- rather than by a document stored in a space.
 * There is nothing to fetch, to sync, or to write for such an address. This
 * is the broad test: every media type counts, and the payload is not
 * examined (see `data-uri-codec.ts`).
 */
export const isInline = (address: IMemoryAddress): boolean => {
  return hasDataUriScheme(address.id);
};
