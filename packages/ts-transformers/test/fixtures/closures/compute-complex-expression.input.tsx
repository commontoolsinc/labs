/// <cts-enable />
import { cell, compute } from "commontools";

export default function TestComputeComplexExpression() {
  const a = cell(10);
  const b = cell(20);
  const c = cell(5);

  const result = compute(() => (a.get() * b.get() + c.get()) / 2);

  return result;
}
