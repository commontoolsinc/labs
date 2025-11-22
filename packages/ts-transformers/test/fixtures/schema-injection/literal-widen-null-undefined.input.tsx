/// <cts-enable />
import { cell } from "commontools";

export default function TestLiteralWidenNullUndefined() {
  const c1 = cell(null);
  const c2 = cell(undefined);

  return null;
}
