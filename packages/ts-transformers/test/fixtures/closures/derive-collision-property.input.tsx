/// <cts-enable />
import { Writable, derive, pattern } from "commontools";

// FIXTURE: derive-collision-property
// Verifies: name collision renames the capture variable but preserves object property names
//   derive(multiplier, fn) → derive(schema, schema, { multiplier, multiplier_1 }, fn)
//   callback: `multiplier.get()` (capture ref) → `multiplier_1.get()`
// Context: returned object literal `{ multiplier: ... }` property name stays unchanged
export default pattern(() => {
  const multiplier = Writable.of(2);

  // Input name 'multiplier' collides with captured variable 'multiplier'
  // The callback returns an object with a property named 'multiplier'
  // Only the variable reference should be renamed, NOT the property name
  const result = derive(multiplier, (m) => ({
    multiplier: multiplier.get(),
    value: m.get() * 3,
  }));

  return result;
});
