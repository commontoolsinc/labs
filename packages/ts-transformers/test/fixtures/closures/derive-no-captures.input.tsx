/// <cts-enable />
import { Writable, derive, pattern } from "commontools";

export default pattern(() => {
  const value = Writable.of(10);

  // No captures - should not be transformed
  const result = derive(value, (v) => v.get() * 2);

  return result;
});
