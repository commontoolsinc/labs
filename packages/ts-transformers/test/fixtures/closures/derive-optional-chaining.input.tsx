/// <cts-enable />
import { Writable, derive, pattern } from "commontools";

interface Config {
  multiplier?: number;
}

export default pattern((config: Config) => {
  const value = Writable.of(10);

  const result = derive(value, (v) => v.get() * (config.multiplier ?? 1));

  return result;
});
