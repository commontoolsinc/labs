/// <cts-enable />
import { cell, derive } from "commontools";

export default function TestDerive() {
  const value = cell(10);

  // No captures - should not be transformed
  const result = derive(value, (v) => v.get() * 2);

  return result;
}
