/// <cts-enable />
import { Cell } from "commonfabric";

// FIXTURE: literal-widen-explicit-type-args
// Verifies: Cell.of with explicit type arguments injects schema matching the type arg
//   Cell.of<number>(10) → Cell.of<number>(10, { type: "number" })
//   Cell.of<string>("hello") → Cell.of<string>("hello", { type: "string" })
//   Cell.of<boolean>(true) → Cell.of<boolean>(true, { type: "boolean" })
export default function TestLiteralWidenExplicitTypeArgs() {
  const _c1 = Cell.of<number>(10);
  const _c2 = Cell.of<string>("hello");
  const _c3 = Cell.of<boolean>(true);

  return null;
}
