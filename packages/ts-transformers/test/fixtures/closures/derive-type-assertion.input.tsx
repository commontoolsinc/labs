/// <cts-enable />
import { cell, derive } from "commontools";

export default function TestDerive() {
  const value = cell(10);
  const multiplier = cell(2);

  const result = derive(value, (v) => (v.get() * multiplier.get()) as number);

  return result;
}
