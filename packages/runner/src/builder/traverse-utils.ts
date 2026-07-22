import { isRecord } from "@commonfabric/utils/types";
import { FabricPrimitive } from "@commonfabric/data-model/fabric-value";
import { type FactoryInput, isPattern, isReactive } from "./types.ts";
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
 * TODO(danfuzz): The `isRecord`-gated `Object.entries`/`Array.map` descent
 * below now leaves `FabricPrimitive` values atomic (an `instanceof` check
 * short-circuits the descent condition), but the other special-object type,
 * `FabricInstance` (a container), is still walked by its internal slots instead
 * of its codec contents. Unlike a primitive it *does* need descending into —
 * but by its actual contents, which the generic enumerable-prop traversal won't
 * do correctly. This site will need attention once FabricInstances see real
 * use.
 */
export function traverseValue(
  unprocessedValue: FactoryInput<any>,
  fn: (value: any) => any,
  seen: Set<FactoryInput<any>> = new Set(),
): any {
  // Perform operation, replaces value if non-undefined is returned
  const result = fn(unprocessedValue);
  const value = result !== undefined ? result : unprocessedValue;

  // Prevent infinite recursion
  if (seen.has(value) || seen.has(result)) return value;
  if (isRecord(result)) seen.add(result);
  else if (isRecord(unprocessedValue)) seen.add(unprocessedValue);

  // Traverse value. A `FabricPrimitive` is an atomic value whose state lives in
  // private fields (zero enumerable own-props); descending into one would
  // rebuild it as `{}`, corrupting it. It has already been shown to `fn` above
  // like any other leaf — here we just decline to descend, so the original
  // instance passes through intact.
  if (
    !isReactive(value) &&
    !isCell(value) &&
    !isCellResultForDereferencing(value) &&
    !((value as object) instanceof FabricPrimitive) &&
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
      // `toJSONWithAliasBindings`.
      if (isPattern(value)) noteDerivedCopy(copy, value);
      return copy;
    }
  } else {
    return value;
  }
}
