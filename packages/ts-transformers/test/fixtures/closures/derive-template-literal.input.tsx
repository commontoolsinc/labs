/// <cts-enable />
import { cell, derive } from "commontools";

export default function TestDerive() {
  const value = cell(10);
  const prefix = cell("Value: ");

  const result = derive(value, (v) => `${prefix.get()}${v}`);

  return result;
}
