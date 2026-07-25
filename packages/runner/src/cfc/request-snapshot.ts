import { cloneIfNecessary } from "@commonfabric/data-model/fabric-value";
import type { FabricValue } from "@commonfabric/api";
import type { FabricValueLayer } from "@commonfabric/data-model/interface";

/**
 * Produces a detached, deep-frozen snapshot of a request `value`, for use as a
 * CFC write-policy input (which is also content-hashed downstream). The result
 * is a deep clone, so later mutation of the input does not leak into the
 * snapshot.
 *
 * `cloneIfNecessary()` deep-clones to a frozen result, preserving
 * `FabricInstance` / `FabricPrimitive` class identity (which a
 * `structuredClone()` would silently strip). Cyclic values are not yet
 * supported (see `cloneIfNecessary`).
 *
 * A request is a `FabricValueLayer` rather than a `FabricValue`: an authored
 * request may still hold native content awaiting conversion (an LLM image part
 * accepts a `Uint8Array`, an `ArrayBuffer`, or a `URL`). `cloneIfNecessary()`
 * handles those natives at runtime; its parameter type names only the
 * already-converted case, hence the cast.
 */
export function createFrozenRequestSnapshot<T extends FabricValueLayer>(
  value: T,
): T {
  // `cloneIfNecessary`'s frozen default is typed `Immutable<T>`; callers
  // consume the snapshot as a (read-only-in-practice) `T`.
  return cloneIfNecessary(value as FabricValue) as T;
}
