/// <cts-enable />
import { Writable, derive, pattern } from "commontools";

export default pattern(() => {
  const value = Writable.of(10);
  const config = { multiplier: 2, divisor: 5 };
  const key = "multiplier";

  const result = derive(value, (v) => v.get() * config[key]);

  return result;
});
