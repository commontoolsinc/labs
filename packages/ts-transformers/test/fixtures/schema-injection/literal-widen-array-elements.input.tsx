/// <cts-enable />
import { cell } from "commontools";

export default function TestLiteralWidenArrayElements() {
  const _arr1 = cell([1, 2, 3]);
  const _arr2 = cell(["a", "b", "c"]);
  const _arr3 = cell([true, false]);

  return null;
}
