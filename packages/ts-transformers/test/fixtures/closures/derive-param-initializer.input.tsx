/// <cts-enable />
import { cell, derive } from "commontools";

// TODO(gideon): Transformer incorrectly adds "enum": [5] constraint for literal value
// Should be fixed on separate branch - schema should just be type: "number"
export default function TestDerive() {
  const value = 5;
  const multiplier = cell(2);

  // Test parameter with default value
  const result = derive(value, (v = 10) => v * multiplier.get());

  return result;
}
