/// <cts-enable />
import { cell } from "commontools";

export default function TestLiteralWidenBigInt() {
  const _bi1 = cell(123n);
  const _bi2 = cell(0n);
  const _bi3 = cell(-456n);

  return null;
}
