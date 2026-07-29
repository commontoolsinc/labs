import type { Cell } from "../cell.ts";
import { cellIdentityKey } from "./scope-policy.ts";

/**
 * The identity key of each element the list currently holds, by position.
 * Sparse holes are skipped: they get no key and so no element run.
 *
 * A list may hold the same identity more than once, so the key also carries how
 * many times that identity has already appeared. Each occurrence then keeps an
 * element run of its own.
 */
export function listElementKeys(list: Cell<any>[]): Map<number, string> {
  const occurrences = new Map<string, number>();
  const keys = new Map<number, string>();
  for (let i = 0; i < list.length; i++) {
    if (!(i in list)) continue;
    const { dedupKey, linkKey } = cellIdentityKey(list[i]);
    const occurrence = occurrences.get(dedupKey) ?? 0;
    occurrences.set(dedupKey, occurrence + 1);
    keys.set(i, JSON.stringify([...linkKey, occurrence]));
  }
  return keys;
}
