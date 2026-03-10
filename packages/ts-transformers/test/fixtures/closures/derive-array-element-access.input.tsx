/// <cts-enable />
import { Writable, derive, pattern } from "commontools";

export default pattern(() => {
  const value = Writable.of(10);
  const factors = [2, 3, 4];

  const result = derive(value, (v) => v.get() * factors[1]!);

  return result;
});
