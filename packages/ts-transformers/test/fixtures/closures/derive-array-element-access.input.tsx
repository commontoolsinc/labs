/// <cts-enable />
import { Writable, derive, pattern } from "commonfabric";

// FIXTURE: derive-array-element-access
// Verifies: an array variable accessed by index inside derive is captured as a whole array
//   derive(value, fn) → derive(schema, schema, { value, factors }, fn)
// Context: `factors[1]!` uses bracket access; the entire `factors` array is captured
export default pattern(() => {
  const value = Writable.of(10);
  const factors = [2, 3, 4];

  const result = derive(value, (v) => v.get() * factors[1]!);

  return result;
});
