/// <cts-enable />
import { Cell, OpaqueCell, Stream } from "commontools";

// FIXTURE: cell-static-factories
// Verifies: static cell factories inject schemas from explicit, inferred, and contextual types
//   Cell.of<string>("hello") → Cell.of<string>("hello", { type: "string" })
//   Cell.of(123) → Cell.of(123, { type: "number" })
//   const cell: Cell<number> = Cell.for("cause") → Cell.for("cause").asSchema({ type: "number" })
//   OpaqueCell.of<boolean>(true) / Stream.of<number>(1) also receive injected schemas
export default function TestCellStaticFactories() {
  const explicitString = Cell.of<string>("hello");
  const inferredNumber = Cell.of(123);
  const explicitCause = Cell.for<string>("cause");
  const contextualCause: Cell<number> = Cell.for("cause");
  const opaque = OpaqueCell.of<boolean>(true);
  const stream = Stream.of<number>(1);

  return {
    explicitString,
    inferredNumber,
    explicitCause,
    contextualCause,
    opaque,
    stream,
  };
}
