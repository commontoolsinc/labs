/// <cts-enable />
import { Writable, derive, pattern } from "commontools";

// FIXTURE: derive-type-assertion
// Verifies: a type assertion (`as number`) in the callback body is preserved after capture extraction
//   derive(value, fn) → derive(schema, schema, { value, multiplier }, fn)
// Context: the `as number` cast remains intact in the transformed callback expression
export default pattern(() => {
  const value = Writable.of(10);
  const multiplier = Writable.of(2);

  const result = derive(value, (v) => (v.get() * multiplier.get()) as number);

  return result;
});
