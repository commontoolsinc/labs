/// <cts-enable />
import { cell, derive } from "commontools";

export default function TestDerive() {
  const value = cell(10);
  const factors = [2, 3, 4];

  const result = derive(value, (v) => v * factors[1]);

  return result;
}
