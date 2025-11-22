/// <cts-enable />
import { cell } from "commontools";

export default function TestLiteralWidenBigInt() {
  const bi1 = cell(123n);
  const bi2 = cell(0n);
  const bi3 = cell(-456n);

  return null;
}
