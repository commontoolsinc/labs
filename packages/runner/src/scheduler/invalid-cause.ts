/**
 * Canonical identity for scheduler invalidation causes.
 *
 * Scope participates in identity. An omitted scope normalizes to `space`,
 * matching storage. JSON keeps path segments unambiguous, so `["a", "b"]`
 * does not collide with `["a/b"]`.
 */

import type { IMemorySpaceAddress } from "../storage/interface.ts";

export function invalidCauseKey(address: IMemorySpaceAddress): string {
  return JSON.stringify([
    address.space,
    address.scope ?? "space",
    address.id,
    address.path,
  ]);
}
