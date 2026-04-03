/// <cts-enable />
import { Writable, derive, pattern } from "commonfabric";

// FIXTURE: derive-complex-expression
// Verifies: multiple captured cells in an arithmetic expression are all extracted
//   derive(a, fn) → derive(schema, schema, { a, b, c }, fn)
export default pattern(() => {
  const a = Writable.of(10);
  const b = Writable.of(20);
  const c = Writable.of(30);

  const result = derive(a, (x) => (x.get() * b.get() + c.get()) / 2);

  return result;
});
