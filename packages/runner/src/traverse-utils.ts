import { isRecord } from "@commontools/utils/types";
import {
  canBeOpaqueRef,
  isOpaqueRef,
  isRecipe,
  isShadowRef,
  type Opaque,
} from "./builder/types.ts";

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
): any {
  // Perform operation, replaces value if non-undefined is returned
  const result = fn(value);
  if (result !== undefined) value = result;

  // Traverse value
  if (Array.isArray(value)) {
    return value.map((v) => traverseValue(v, fn));
  } else if (
    (!isOpaqueRef(value) &&
      !canBeOpaqueRef(value) &&
      !isShadowRef(value) &&
      isRecord(value)) ||
    isRecipe(value)
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, traverseValue(v, fn)]),
    );
  } else return value;
}
