import {
  type FabricValue,
  valueEqual,
} from "@commonfabric/data-model/fabric-value";

/**
 * Deduplicate `items` by `valueEqual` — the value model's own equality, which
 * leads with `Object.is` at primitive leaves. Keeps the first of each equal
 * group, in order.
 *
 * This is the honest comparison for schema and enum values, where a
 * `JSON.stringify` key or a `Set` is not: stringify renders `NaN` and
 * `±Infinity` as `null` and drops the sign of `-0` (so distinct values collide),
 * and is sensitive to object key order (so equal values with different insertion
 * order do NOT collide when they should); a `Set` uses SameValueZero, which
 * conflates `-0` with `0`. `valueEqual` distinguishes `-0` from `0`, treats
 * `NaN` as equal to itself, and does not depend on key order.
 */
export function dedupeByValueEqual<T>(items: readonly T[]): T[] {
  const out: T[] = [];
  for (const item of items) {
    const isDuplicate = out.some((kept) =>
      valueEqual(kept as FabricValue, item as FabricValue)
    );
    if (!isDuplicate) out.push(item);
  }
  return out;
}
