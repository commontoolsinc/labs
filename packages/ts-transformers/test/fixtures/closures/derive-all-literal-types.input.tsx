/// <cts-enable />
import { Writable, derive, pattern } from "commontools";

// Test that all literal types are widened in closure captures
// FIXTURE: derive-all-literal-types
// Verifies: literal values (number, string, boolean, float) are captured and their types widened in schemas
//   derive(value, fn) → derive(schema, schema, { value, numLiteral, floatLiteral, boolLiteral, strLiteral }, fn)
// Context: each literal type maps to its widened JSON schema type (e.g., 42 → "number", "hello" → "string")
export default pattern(() => {
  const value = Writable.of(10);

  // All literal types that should be widened
  const numLiteral = 42;
  const strLiteral = "hello";
  const boolLiteral = true;
  const floatLiteral = 3.14;

  const result = derive(value, (v) => {
    // Use all captured literals to ensure they're all widened
    const combined = v.get() + numLiteral + floatLiteral;
    return boolLiteral ? strLiteral + combined : "";
  });

  return result;
});
