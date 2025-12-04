/// <cts-enable />
import { cell, derive } from "commontools";

export default function TestDerive() {
  const a = cell(10);
  const b = cell(20);
  const c = cell(30);

  const result = derive(a, (x) => (x.get() * b.get() + c.get()) / 2);

  return result;
}
