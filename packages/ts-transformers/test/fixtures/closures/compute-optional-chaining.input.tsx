/// <cts-enable />
import { cell, compute } from "commontools";

export default function TestComputeOptionalChaining() {
  const config = cell<{ multiplier?: number } | null>({ multiplier: 2 });
  const value = cell(10);

  const result = compute(() => value.get() * (config.get()?.multiplier ?? 1));

  return result;
}
