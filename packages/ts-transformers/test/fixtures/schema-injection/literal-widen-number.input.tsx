/// <cts-enable />
import { cell } from "commontools";

export default function TestLiteralWidenNumber() {
  const _n1 = cell(10);
  const _n2 = cell(-5);
  const _n3 = cell(3.14);
  const _n4 = cell(1e10);
  const _n5 = cell(0);

  return null;
}
