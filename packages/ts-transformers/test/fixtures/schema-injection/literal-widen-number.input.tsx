/// <cts-enable />
import { cell } from "commontools";

export default function TestLiteralWidenNumber() {
  const n1 = cell(10);
  const n2 = cell(-5);
  const n3 = cell(3.14);
  const n4 = cell(1e10);
  const n5 = cell(0);

  return null;
}
