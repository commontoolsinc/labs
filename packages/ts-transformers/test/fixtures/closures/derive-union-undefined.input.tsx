/// <cts-enable />
import { cell, derive } from "commontools";

interface Config {
  required: number;
  unionUndefined: number | undefined;
}

export default function TestDerive(config: Config) {
  const value = cell(10);

  const result = derive(value, (v) => 
    v.get() + config.required + (config.unionUndefined ?? 0)
  );

  return result;
}
