/// <cts-enable />
import { cell, computed } from "commontools";

export default function TestComputedWithClosedOverCellMap() {
  const numbers = cell([1, 2, 3]);
  const multiplier = cell(2);

  // Inside computed, we close over numbers (a Cell)
  // The computed gets transformed to derive({}, () => numbers.map(...))
  // Inside a derive, .map on a closed-over Cell should STILL be transformed to mapWithPattern
  // because Cells need the pattern-based mapping even when unwrapped
  const doubled = computed(() => numbers.map(n => n * multiplier.get()));

  return doubled;
}
