/// <cts-enable />
import { cell, derive } from "commontools";

export default function TestDeriveLocalVariable() {
  const a = cell(10);
  const b = cell(20);
  const c = cell(30);

  const result = derive(a, (aVal) => {
    const sum = aVal.get() + b.get();
    return sum * c.get();
  });

  return result;
}
