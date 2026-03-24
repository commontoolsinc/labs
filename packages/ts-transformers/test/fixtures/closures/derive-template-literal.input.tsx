/// <cts-enable />
import { Writable, derive, pattern } from "commonfabric";

// FIXTURE: derive-template-literal
// Verifies: a captured cell used inside a template literal expression is extracted
//   derive(value, fn) → derive(schema, schema, { value, prefix }, fn)
export default pattern(() => {
  const value = Writable.of(10);
  const prefix = Writable.of("Value: ");

  const result = derive(value, (v) => `${prefix.get()}${v}`);

  return result;
});
