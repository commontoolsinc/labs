import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import { hashStringOf } from "@commonfabric/data-model/value-hash";

/**
 * Deduplicate `items` by value-model equality, keeping the first of each equal
 * group, in order.
 *
 * Equality is decided by canonical content hash (`hashStringOf`) rather than
 * pairwise comparison: the hash IS the value model's identity — `valueEqual`'s
 * own object path compares `hashStringOf(a) === hashStringOf(b)` — so grouping
 * by hash string in a `Set` yields the same result as O(N²) pairwise
 * `valueEqual`, in one pass. Each item is hashed exactly once; for a deep-frozen
 * item that hash is cached, so it is effectively free.
 *
 * This is the honest comparison for schema and enum values, where a
 * `JSON.stringify` key or a `Set` of the values is not: stringify renders `NaN`
 * and `±Infinity` as `null` and drops the sign of `-0` (distinct values
 * collide), and is key-order sensitive (equal values do not collide); a `Set`
 * uses SameValueZero, which conflates `-0` with `0`. The content hash makes the
 * value model's distinctions -- `-0` ≠ `0`, `NaN` = `NaN`, key-order-independent
 * -- exactly.
 */
export function dedupeByValueEqual<T extends FabricValue>(
  items: readonly T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const hash = hashStringOf(item);
    if (!seen.has(hash)) {
      seen.add(hash);
      out.push(item);
    }
  }
  return out;
}
