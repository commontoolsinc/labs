/// <cts-enable />
import { cell, compute } from "commontools";

export default function TestCompute() {
  const value = cell(10);
  const multiplier = cell(2);

  const result = compute(() => value.get() * multiplier.get());

  return result;
}
