import { Writable, derive, pattern } from "commonfabric";

// FIXTURE: derive-empty-input-no-params
// Verifies: zero-parameter callback with empty `{}` input still captures closed-over cells
//   derive({}, () => ...) → derive(schema, schema, { a, b }, ({ a, b }) => ...)
// Context: no explicit input param; captures become the sole parameters of the rewritten callback
export default pattern(() => {
  const a = new Writable(10);
  const b = new Writable(20);

  // Zero-parameter callback that closes over a and b
  const result = derive({}, () => a.get() + b.get());

  return result;
});
