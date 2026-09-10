import { isObjectOrArray } from "@commonfabric/utils/types";
import {
  FabricInstance,
  FabricSpecialObject,
  refuseFabricInstance,
} from "@commonfabric/data-model";
import { isAdmittedFabricFactory } from "@commonfabric/data-model/fabric-factory";
import { type FactoryInput, isPattern, isReactive } from "./types.ts";
import { noteDerivedCopy } from "./pattern-metadata.ts";
import { isCell } from "../cell.ts";
import { isCellResultForDereferencing } from "../query-result-proxy.ts";
import {
  createFactoryTraversalContext,
  type FactoryTraversalContext,
  mapFactoryForTraversal,
} from "./factory-traversal.ts";

/**
 * Traverse a value, _not_ entering cells
 *
 * @param value - The value to traverse
 * @param fn - The function to apply to each value, which can return a new value
 * @returns Transformed value
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
  if (isObjectOrArray(result)) seen.add(result);
  else if (isObjectOrArray(unprocessedValue)) seen.add(unprocessedValue);

  // A `FabricInstance` is NOT a leaf. It is a container reached by its codec
  // contents rather than by property name, which this walk cannot do, so the
  // rebuild below would hand back a bare `{}` -- and whatever `fn` was looking
  // for inside it would go unseen. It refuses instead of doing that quietly.
  //
  // This sits after `fn`, not before it, for the same reason the primitive
  // guard does: an instance is a value `fn` gets to see and may replace, and
  // only descending into one is refused.
  //
  // Nothing reaches this in production today, de facto rather than by
  // construction: a `FabricError` is exposed to pattern authors and ungated, so
  // what keeps this safe is that no caller yet puts one in a builder value.
  //
  // TODO(danfuzz): descend a `FabricInstance` by its codec contents, at which
  // point this becomes a walk rather than a refusal.
  if ((value as object) instanceof FabricInstance) {
    refuseFabricInstance(
      value as FabricInstance,
      "when traversing a builder value",
    );
  }

  // Traverse value. A `FabricPrimitive` is an atomic value whose state lives
  // in private fields (zero enumerable own-props); descending into one would
  // rebuild it as `{}`, corrupting it. It has already been shown to `fn` above
  // like any other leaf — here we just decline to descend, so the original
  // value passes through intact. The test names the base class rather than
  // that one: an instance is refused above, so the two select the same values
  // here, and the class this walk declines to descend is the wider one.
  if (
    !isReactive(value) &&
    !isCell(value) &&
    !isCellResultForDereferencing(value) &&
    !((value as object) instanceof FabricSpecialObject) &&
    (isObjectOrArray(value) || isPattern(value))
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
      // `withAliasBindings`.
      if (isPattern(value)) noteDerivedCopy(copy, value);
      return copy;
    }
  } else {
    return value;
  }
}
