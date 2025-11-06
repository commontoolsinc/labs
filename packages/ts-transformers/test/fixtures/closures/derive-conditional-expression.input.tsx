/// <cts-enable />
import { cell, derive } from "commontools";

export default function TestDerive() {
  const value = cell(10);
  const threshold = cell(5);
  const multiplier = cell(2);

  const result = derive(value, (v) =>
    v > threshold.get() ? v * multiplier.get() : v
  );

  return result;
}
