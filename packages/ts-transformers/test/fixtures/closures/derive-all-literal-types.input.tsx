/// <cts-enable />
import { cell, derive } from "commontools";

// Test that all literal types are widened in closure captures
export default function TestAllLiteralWidening() {
  const value = cell(10);

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
}
