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
) => {
  if (source.id !== candidate.id || source.type !== candidate.type) {
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
  if (source.id !== candidate.id || source.type !== candidate.type) {
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
 * Returns true if the address represents an inline data URI.
 */
export const isInline = (address: IMemoryAddress): boolean => {
  return address.id.startsWith("data:");
};
