/// <cts-enable />
import { cell } from "commontools";

export default function TestLiteralWidenString() {
  const _s1 = cell("hello");
  const _s2 = cell("");
  const _s3 = cell("hello\nworld");
  const _s4 = cell("with spaces");

  return null;
}
