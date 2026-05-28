import { cloneIfNecessary } from "@commonfabric/data-model/fabric-value";
import type { FabricValue } from "@commonfabric/memory/interface";

/**
 * Produces a detached, deep-frozen snapshot of a request `value`, for use as a
 * CFC write-policy input (which is also content-hashed downstream). The result
 * is a deep clone, so later mutation of the input does not leak into the
 * snapshot.
 *
 * The `value` is treated as a `FabricValue`: `cloneIfNecessary()` deep-clones
 * to a frozen result, preserving `FabricInstance` / `FabricPrimitive` class
 * identity (which a `structuredClone()` would silently strip). Cyclic values
 * are not yet supported (see `cloneIfNecessary`).
 */
export function createFrozenRequestSnapshot<T>(value: T): T {
  return cloneIfNecessary(value as FabricValue) as T;
}
