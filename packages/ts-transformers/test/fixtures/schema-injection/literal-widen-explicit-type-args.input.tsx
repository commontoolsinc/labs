/// <cts-enable />
import { Cell } from "commontools";

export default function TestLiteralWidenExplicitTypeArgs() {
  const _c1 = Cell.of<number>(10);
  const _c2 = Cell.of<string>("hello");
  const _c3 = Cell.of<boolean>(true);

  return null;
}
