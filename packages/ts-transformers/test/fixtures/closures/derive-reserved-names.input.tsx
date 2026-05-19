import { Writable, derive, pattern } from "commonfabric";

// FIXTURE: derive-reserved-names
// Verifies: variables with __cf_ prefixed names are captured without special treatment
//   derive(value, fn) → derive(schema, schema, { value, __cf_reserved }, fn)
export default pattern(() => {
  const value = new Writable(10);
  // Reserved JavaScript keyword as variable name (valid in TS with quotes)
  const __cf_reserved = new Writable(2);

  const result = derive(value, (v) => v.get() * __cf_reserved.get());

  return result;
});
