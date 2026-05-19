import { Writable, derive, pattern } from "commonfabric";

// FIXTURE: derive-multiple-captures
// Verifies: two captured cells are both extracted into the derive capture object
//   derive(value, fn) → derive(schema, schema, { value, multiplier, offset }, fn)
export default pattern(() => {
  const value = new Writable(10);
  const multiplier = new Writable(2);
  const offset = new Writable(5);

  const result = derive(value, (v) => (v.get() * multiplier.get()) + offset.get());

  return result;
});
