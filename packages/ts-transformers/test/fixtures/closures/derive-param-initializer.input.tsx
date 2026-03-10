/// <cts-enable />
import { Writable, derive, pattern } from "commontools";

export default pattern(() => {
  const value = 5;
  const multiplier = Writable.of(2);

  // Test parameter with default value
  const result = derive(value, (v = 10) => v * multiplier.get());

  return result;
});
