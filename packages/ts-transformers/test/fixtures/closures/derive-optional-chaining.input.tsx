/// <cts-enable />
import { cell, derive } from "commontools";

interface Config {
  multiplier?: number;
}

export default function TestDerive(config: Config) {
  const value = cell(10);

  const result = derive(value, (v) => v * (config.multiplier ?? 1));

  return result;
}
