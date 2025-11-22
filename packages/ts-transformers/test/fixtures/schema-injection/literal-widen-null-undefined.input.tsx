/// <cts-enable />
import { cell } from "commontools";

export default function TestLiteralWidenNullUndefined() {
  const _c1 = cell(null);
  const _c2 = cell(undefined);

  return null;
}
