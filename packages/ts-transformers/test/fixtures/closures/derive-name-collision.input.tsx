/// <cts-enable />
import { Writable, derive, pattern } from "commontools";

// FIXTURE: derive-name-collision
// Verifies: when the input variable and a capture share the same name, the capture is renamed with a suffix
//   derive(multiplier, fn) → derive(schema, schema, { multiplier, multiplier_1 }, fn)
//   callback: `multiplier.get()` (capture) → `multiplier_1.get()`
export default pattern(() => {
  const multiplier = Writable.of(2);

  // Input name collides with capture name
  // multiplier is both the input AND a captured variable (used via .get())
  const result = derive(multiplier, (m) => m.get() * 3 + multiplier.get());

  return result;
});
