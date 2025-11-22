/// <cts-enable />
import { cell } from "commontools";

export default function TestLiteralWidenArrayElements() {
  const arr1 = cell([1, 2, 3]);
  const arr2 = cell(["a", "b", "c"]);
  const arr3 = cell([true, false]);

  return null;
}
