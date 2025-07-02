import type { IMemoryAddress } from "../interface.ts";
export const toString = (address: IMemoryAddress) =>
  `/${address.id}/${address.type}/${address.path.join("/")}`;

/**
 * Returns true if `candidate` address references location within the
 * the `source` address. Otherwise returns false.
 */
export const includes = (
  source: IMemoryAddress,
  candidate: IMemoryAddress,
) =>
  source.id === candidate.id &&
  source.type === candidate.type &&
  source.path.join("/").startsWith(candidate.path.join("/"));

export const intersect = (
  source: IMemoryAddress,
  candidate: IMemoryAddress,
) => {
  if (source.id === candidate.id && source.type === candidate.type) {
    const left = source.path.join("/");
    const right = candidate.path.join("/");
    return left.startsWith(right) || right.startsWith(left);
  }
  return false;
};
