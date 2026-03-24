/// <cts-enable />
import { Writable, derive, pattern } from "commonfabric";

// FIXTURE: derive-collision-shorthand
// Verifies: shorthand property `{ multiplier }` expands correctly when the capture is renamed
//   derive(multiplier, fn) → derive(schema, schema, { multiplier, multiplier_1 }, fn)
//   shorthand `{ multiplier }` → `{ multiplier: multiplier_1 }`
// Context: shorthand must expand to keep the property name while using the renamed capture binding
export default pattern(() => {
  const multiplier = Writable.of(2);

  // Input name 'multiplier' collides with captured variable 'multiplier'
  // The callback uses shorthand property { multiplier }
  // This should expand to { multiplier: multiplier_1 } after renaming
  const result = derive(multiplier, (m) => ({
    value: m.get() * 3,
    data: { multiplier },
  }));

  return result;
});
