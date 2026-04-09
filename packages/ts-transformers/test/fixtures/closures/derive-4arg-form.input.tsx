import { Writable, derive, pattern, type JSONSchema } from "commonfabric";
import "commonfabric/schema";

// FIXTURE: derive-4arg-form
// Verifies: closure extraction works with explicit 4-arg derive(inputSchema, outputSchema, input, fn)
//   derive(schema, schema, value, fn) → derive(mergedSchema, schema, { value, multiplier }, fn)
// Context: `multiplier` is captured even though schemas are already provided
export default pattern(() => {
  const value = Writable.of(10);
  const multiplier = Writable.of(2);

  // Explicit 4-arg form with schemas - should still transform captures
  const result = derive(
    { type: "number", asCell: true } as const satisfies JSONSchema,
    { type: "number" } as const satisfies JSONSchema,
    value,
    (v) => v.get() * multiplier.get()
  );

  return result;
});
