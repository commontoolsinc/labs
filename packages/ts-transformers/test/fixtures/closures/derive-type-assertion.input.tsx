/// <cts-enable />
import { Writable, derive, pattern } from "commontools";

export default pattern(() => {
  const value = Writable.of(10);
  const multiplier = Writable.of(2);

  const result = derive(value, (v) => (v.get() * multiplier.get()) as number);

  return result;
});
