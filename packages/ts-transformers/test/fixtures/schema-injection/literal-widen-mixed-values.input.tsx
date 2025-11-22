/// <cts-enable />
import { cell } from "commontools";

export default function TestLiteralWidenMixedValues() {
  const variable = 42;
  const _c1 = cell(10);
  const _c2 = cell(variable);
  const _c3 = cell(10 + 20);

  return null;
}
