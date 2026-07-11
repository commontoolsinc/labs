import { isRecord } from "@commonfabric/utils/types";
import { FabricPrimitive } from "@commonfabric/data-model/fabric-value";
import { isAdmittedFabricFactory } from "@commonfabric/data-model/fabric-factory";
import { type FactoryInput, isPattern, isReactive } from "./types.ts";
import { noteDerivedCopy } from "./pattern-metadata.ts";
import {
  createFactoryTraversalContext,
  type FactoryTraversalContext,
  mapFactoryForTraversal,
} from "./factory-traversal.ts";
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
  factoryContext: FactoryTraversalContext = createFactoryTraversalContext(),
  insideFactoryState = false,
): any {
  if (
    insideFactoryState && typeof unprocessedValue === "function" &&
    !isAdmittedFabricFactory(unprocessedValue)
  ) {
    throw new TypeError(
      "Arbitrary functions are not valid factory state values",
    );
  }

  // Perform operation, replaces value if non-undefined is returned
  const result = fn(unprocessedValue);
  const value = result !== undefined ? result : unprocessedValue;

  if (
    insideFactoryState && typeof value === "function" &&
    !isAdmittedFabricFactory(value)
  ) {
    throw new TypeError(
      "Arbitrary functions are not valid factory state values",
    );
  }

  // Factory callables carry graph values in hidden state rather than
  // enumerable properties. Traverse that state before the structural pattern
  // branch, then ask the runner-owned builder constructor to rebuild behavior.
  if (isAdmittedFabricFactory(value)) {
    return mapFactoryForTraversal(
      value,
      (nested) => traverseValue(nested, fn, seen, factoryContext, true),
      factoryContext,
    );
  }

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
      return (value as Array<any>).map((v) =>
        traverseValue(v, fn, seen, factoryContext, insideFactoryState)
      );
    } else {
      const copy = Object.fromEntries(
        Object.entries(value).map((
          [key, v],
        ) => [
          key,
          traverseValue(v, fn, seen, factoryContext, insideFactoryState),
        ]),
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
