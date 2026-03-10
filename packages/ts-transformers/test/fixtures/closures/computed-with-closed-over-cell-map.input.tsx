/// <cts-enable />
import { Writable, computed, pattern } from "commontools";

export default pattern(() => {
  const numbers = Writable.of([1, 2, 3]);
  const multiplier = Writable.of(2);

  // Inside computed, we close over numbers (a Cell)
  // The computed gets transformed to derive({}, () => numbers.map(...))
  // Inside a derive, .map on a closed-over Cell should STILL be transformed to mapWithPattern
  // because Cells need the pattern-based mapping even when unwrapped
  const doubled = computed(() => numbers.map(n => n * multiplier.get()));

  return doubled;
});
