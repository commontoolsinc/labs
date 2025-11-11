/// <cts-enable />
import { cell, compute } from "commontools";

export default function TestComputeConditionalExpression() {
  const value = cell(10);
  const threshold = cell(5);
  const a = cell(100);
  const b = cell(200);

  const result = compute(() =>
    value.get() > threshold.get() ? a.get() : b.get()
  );

  return result;
}
