/// <cts-enable />
import { Writable, derive, pattern } from "commontools";

interface Config {
  required: number;
  unionUndefined: number | undefined;
}

export default pattern((config: Config) => {
  const value = Writable.of(10);

  const result = derive(value, (v) => 
    v.get() + config.required + (config.unionUndefined ?? 0)
  );

  return result;
});
