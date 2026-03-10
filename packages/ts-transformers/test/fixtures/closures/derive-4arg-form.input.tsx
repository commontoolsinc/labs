/// <cts-enable />
import { Writable, derive, pattern, type JSONSchema } from "commontools";
import "commontools/schema";

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
