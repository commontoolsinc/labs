/// <cts-enable />
import { Writable, derive, pattern } from "commontools";

// FIXTURE: derive-nested-callback
// Verifies: capture extraction works with nested plain-array .map() inside derive
//   derive(numbers, fn) → derive(schema, schema, { numbers, multiplier }, fn)
//   inner nums.map(fn) stays as plain .map(fn)
// Context: inside derive, `nums` is a plain array, so nested array methods are not rewritten
export default pattern(() => {
  const numbers = Writable.of([1, 2, 3]);
  const multiplier = Writable.of(2);

  // Nested callback - inner array map should not capture outer multiplier
  const result = derive(numbers, (nums) =>
    nums.map(n => n * multiplier.get())
  );

  return result;
});
