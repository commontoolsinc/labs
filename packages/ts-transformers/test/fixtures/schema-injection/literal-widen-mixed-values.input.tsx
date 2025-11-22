/// <cts-enable />
import { cell } from "commontools";

export default function TestLiteralWidenMixedValues() {
  const variable = 42;
  const c1 = cell(10);
  const c2 = cell(variable);
  const c3 = cell(10 + 20);

  return null;
}
