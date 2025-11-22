/// <cts-enable />
import { cell } from "commontools";

export default function TestLiteralWidenString() {
  const s1 = cell("hello");
  const s2 = cell("");
  const s3 = cell("hello\nworld");
  const s4 = cell("with spaces");

  return null;
}
