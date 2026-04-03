/// <cts-enable />
import { derive } from "commonfabric";

declare const flag: boolean;

// FIXTURE: schema-generation-derive-multiple-returns
// Verifies: derive() with multiple return paths infers a union output schema
//   derive(flag, fn) → derive({ type: "boolean" }, { enum: ["hello", 42] }, flag, fn)
// Context: Callback has two return statements (string and number); output schema is an enum union
// Function with multiple return statements - should infer string | number
export const multiReturn = derive(flag, (value) => {
  if (value) {
    return "hello";
  }
  return 42;
});
