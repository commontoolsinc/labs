/// <cts-enable />
import { Cell } from "commontools";

export default function TestLiteralWidenExplicitTypeArgs() {
  const c1 = Cell.of<number>(10);
  const c2 = Cell.of<string>("hello");
  const c3 = Cell.of<boolean>(true);

  return null;
}
