/// <cts-enable />
import { cell, derive, type JSONSchema } from "commontools";

export default function TestDerive() {
  const value = cell(10);
  const multiplier = cell(2);

  // Explicit 4-arg form with schemas - should still transform captures
  const result = derive(
    { type: "number", asOpaque: true } as const satisfies JSONSchema,
    { type: "number" } as const satisfies JSONSchema,
    value,
    (v) => v * multiplier.get()
  );

  return result;
}
