/// <cts-enable />
import { cell, derive } from "commontools";

export default function TestDerive() {
  const value = cell(10);
  const config = { multiplier: 2, divisor: 5 };
  const key = "multiplier";

  const result = derive(value, (v) => v.get() * config[key]);

  return result;
}
