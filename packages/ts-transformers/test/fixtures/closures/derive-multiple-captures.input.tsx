/// <cts-enable />
import { Writable, derive, pattern } from "commontools";

// FIXTURE: derive-multiple-captures
// Verifies: two captured cells are both extracted into the derive capture object
//   derive(value, fn) → derive(schema, schema, { value, multiplier, offset }, fn)
export default pattern(() => {
  const value = Writable.of(10);
  const multiplier = Writable.of(2);
  const offset = Writable.of(5);

  const result = derive(value, (v) => (v.get() * multiplier.get()) + offset.get());

  return result;
});
