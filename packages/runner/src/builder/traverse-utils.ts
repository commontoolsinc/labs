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
