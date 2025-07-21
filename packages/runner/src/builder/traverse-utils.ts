import { isRecord } from "@commontools/utils/types";
import {
  canBeOpaqueRef,
  isOpaqueRef,
  isRecipe,
  isShadowRef,
  type Opaque,
} from "./types.ts";

/**
 * Traverse a value, _not_ entering cells
 *
 * @param value - The value to traverse
 * @param fn - The function to apply to each value, which can return a new value
 * @returns Transformed value
 */
export function traverseValue(
  value: Opaque<any>,
  fn: (value: any) => any,
  seen: Set<Opaque<any>> = new Set(),
): any {
  if (seen.has(value)) return value;
  seen.add(value);

  // Perform operation, replaces value if non-undefined is returned
  const result = fn(value);
  if (result !== undefined) {
    value = result;
    seen.add(value);
  }

  // Traverse value
  if (Array.isArray(value)) {
    return value.map((v) => traverseValue(v, fn, seen));
  } else if (
    !isOpaqueRef(value) &&
    !canBeOpaqueRef(value) &&
    !isShadowRef(value) &&
    (isRecord(value) || isRecipe(value))
  ) {
    return Object.fromEntries(
      Object.entries(value).map((
        [key, v],
      ) => [key, traverseValue(v, fn, seen)]),
    );
  } else return value;
}
