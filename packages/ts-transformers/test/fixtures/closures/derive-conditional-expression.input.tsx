import { Writable, derive, pattern } from "commonfabric";

// FIXTURE: derive-conditional-expression
// Verifies: captures used in both branches of a ternary are extracted
//   derive(value, fn) → derive(schema, schema, { value, threshold, multiplier }, fn)
export default pattern(() => {
  const value = Writable.of(10);
  const threshold = Writable.of(5);
  const multiplier = Writable.of(2);

  const result = derive(value, (v) =>
    v.get() > threshold.get() ? v.get() * multiplier.get() : v.get()
  );

  return result;
});
