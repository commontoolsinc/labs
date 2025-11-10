/// <cts-enable />
import { cell, derive } from "commontools";

export default function TestDerive() {
  const value = cell(5);
  const multiplier = cell(2);

  // Test parameter with default value
  const result = derive(value, (v = 10) => v * multiplier.get());

  return result;
}
