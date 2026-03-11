/// <cts-enable />
import { Writable, derive, pattern } from "commontools";

export default pattern(() => {
  const numbers = Writable.of([1, 2, 3]);
  const multiplier = Writable.of(2);

  // Nested callback - inner array map should not capture outer multiplier
  const result = derive(numbers, (nums) =>
    nums.map(n => n * multiplier.get())
  );

  return result;
});
