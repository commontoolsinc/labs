/// <cts-enable />
import { cell, derive } from "commontools";

export default function TestDerive() {
  const numbers = cell([1, 2, 3]);
  const multiplier = cell(2);

  // Nested callback - inner array map should not capture outer multiplier
  const result = derive(numbers, (nums) =>
    nums.map(n => n * multiplier.get())
  );

  return result;
}
