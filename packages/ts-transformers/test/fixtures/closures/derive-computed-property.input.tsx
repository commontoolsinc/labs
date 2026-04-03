/// <cts-enable />
import { Writable, derive, pattern } from "commontools";

// FIXTURE: derive-computed-property
// Verifies: computed property access with a dynamic key captures both the object and the key
//   derive(value, fn) → derive(schema, schema, { value, config, key }, fn)
// Context: `config[key]` requires both `config` and `key` to be captured as plain values
export default pattern(() => {
  const value = Writable.of(10);
  const config = { multiplier: 2, divisor: 5 };
  const key = "multiplier";

  const result = derive(value, (v) => v.get() * config[key]);

  return result;
});
