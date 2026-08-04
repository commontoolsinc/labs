import type { IMemoryAddress } from "../interface.ts";
import { normalizeCellScope } from "../../scope.ts";
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
