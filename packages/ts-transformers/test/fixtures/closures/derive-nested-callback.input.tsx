/// <cts-enable />
import { Writable, derive, pattern } from "commontools";

// FIXTURE: derive-nested-callback
// Verifies: capture extraction works with nested .map() which is itself transformed to mapWithPattern
//   derive(numbers, fn) → derive(schema, schema, { numbers, multiplier }, fn)
//   inner nums.map(fn) → nums.mapWithPattern(pattern(...), { multiplier })
// Context: `multiplier` is captured by both derive and the inner map; inner map receives it via params
export default pattern(() => {
  const numbers = Writable.of([1, 2, 3]);
  const multiplier = Writable.of(2);

  // Nested callback - inner array map should not capture outer multiplier
  const result = derive(numbers, (nums) =>
    nums.map(n => n * multiplier.get())
  );

  return result;
});
