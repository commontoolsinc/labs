import { isRecord } from "@commonfabric/utils/types";
import { isOpaqueRef, isPattern, type Opaque } from "./types.ts";
import { noteDerivedCopy } from "./pattern-metadata.ts";
import { isCell } from "../cell.ts";
import { isCellResultForDereferencing } from "../query-result-proxy.ts";

/**
 * Traverse a value, _not_ entering cells
 *
 * @param value - The value to traverse
 * @param fn - The function to apply to each value, which can return a new value
 * @returns Transformed value
 *
 * TODO(danfuzz): This `isRecord`-gated walk has no `FabricSpecialObject` guard
 * before its `Object.entries`/`Array.map` descent, so it recurses into
 * `FabricPrimitive` values (decomposing them to their empty enumerable props)
 * and walks `FabricInstance` values by their internal slots instead of their
 * codec contents.
 */
export function traverseValue(
  unprocessedValue: Opaque<any>,
  fn: (value: any) => any,
  seen: Set<Opaque<any>> = new Set(),
): any {
  // Perform operation, replaces value if non-undefined is returned
  const result = fn(unprocessedValue);
  const value = result !== undefined ? result : unprocessedValue;

  // Prevent infinite recursion
  if (seen.has(value) || seen.has(result)) return value;
  if (isRecord(result)) seen.add(result);
  else if (isRecord(unprocessedValue)) seen.add(unprocessedValue);

  // Traverse value
  if (
    !isOpaqueRef(value) &&
    !isCell(value) &&
    !isCellResultForDereferencing(value) &&
    (isRecord(value) || isPattern(value))
  ) {
    if (Array.isArray(value)) {
      return (value as Array<any>).map((v) => traverseValue(v, fn, seen));
    } else {
      const copy = Object.fromEntries(
        Object.entries(value).map((
          [key, v],
        ) => [key, traverseValue(v, fn, seen)]),
      );
      // A pattern copied here must keep its link back to the original
      // (branded, content-addressed) factory — otherwise
      // `resolveOriginal`/`getArtifactEntryRef` would be severed, which is how
      // a pattern passed as an `op` is later identified by
      // `{ identity, symbol }`. Mirrors the registration in
      // `toJSONWithLegacyAliases`.
      if (isPattern(value)) noteDerivedCopy(copy, value);
      return copy;
    }
  } else {
    return value;
  }
}
