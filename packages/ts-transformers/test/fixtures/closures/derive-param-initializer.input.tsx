import { Writable, derive, pattern } from "commonfabric";

// FIXTURE: derive-param-initializer
// Verifies: a callback parameter with a default value is preserved after capture extraction
//   derive(value, (v = 10) => ...) → derive(schema, schema, { value, multiplier }, ({ value: v = 10, multiplier }) => ...)
// Context: the default initializer `= 10` is carried over to the destructured parameter
export default pattern(() => {
  const value = 5;
  const multiplier = Writable.of(2);

  // Test parameter with default value
  const result = derive(value, (v = 10) => v * multiplier.get());

  return result;
});
