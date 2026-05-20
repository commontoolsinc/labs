import { Writable, derive, pattern } from "commonfabric";

// FIXTURE: derive-template-literal
// Verifies: a captured cell used inside a template literal expression is extracted
//   derive(value, fn) → derive(schema, schema, { value, prefix }, fn)
export default pattern(() => {
  const value = new Writable(10);
  const prefix = new Writable("Value: ");

  const result = derive(value, (v) => `${prefix.get()}${v}`);

  return result;
});
