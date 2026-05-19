import { Writable, derive, pattern } from "commonfabric";

// FIXTURE: derive-conditional-expression
// Verifies: captures used in both branches of a ternary are extracted
//   derive(value, fn) → derive(schema, schema, { value, threshold, multiplier }, fn)
export default pattern(() => {
  const value = new Writable(10);
  const threshold = new Writable(5);
  const multiplier = new Writable(2);

  const result = derive(value, (v) =>
    v.get() > threshold.get() ? v.get() * multiplier.get() : v.get()
  );

  return result;
});
