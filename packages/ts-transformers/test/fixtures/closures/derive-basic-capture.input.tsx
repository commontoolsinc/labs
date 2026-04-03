/// <cts-enable />
import { Writable, derive, pattern } from "commontools";

// FIXTURE: derive-basic-capture
// Verifies: a single closed-over cell is extracted into the derive capture object
//   derive(value, fn) → derive(schema, schema, { value, multiplier }, fn)
export default pattern(() => {
  const value = Writable.of(10);
  const multiplier = Writable.of(2);

  const result = derive(value, (v) => v.get() * multiplier.get());

  return result;
});
