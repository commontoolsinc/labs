/// <cts-enable />
import { Writable, derive, pattern } from "commonfabric";

// FIXTURE: derive-local-variable
// Verifies: callback-local variables are not captured, but outer cells are
//   derive(a, fn) → derive(schema, schema, { a, b, c }, fn)
// Context: `sum` is a local const inside the callback and must not appear in captures
export default pattern(() => {
  const a = Writable.of(10);
  const b = Writable.of(20);
  const c = Writable.of(30);

  const result = derive(a, (aVal) => {
    const sum = aVal.get() + b.get();
    return sum * c.get();
  });

  return result;
});
