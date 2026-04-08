import { Cell, cell, ComparableCell } from "commonfabric";

// FIXTURE: cell-of-no-value
// Verifies: Cell.of/cell with type arg but no value injects undefined as first arg plus schema
//   Cell.of<string>() → Cell.of<string>(undefined, { type: "string" })
//   cell<string>() → cell<string>(undefined, { type: "string" })
//   ComparableCell.of<{ name: string }>() → ComparableCell.of<...>(undefined, { type: "object", ... })
//   Cell.of<string>("hello") → Cell.of<string>("hello", { type: "string" })
export default function TestCellOfNoValue() {
  // Cell.of with type argument but no value - should become Cell.of(undefined, schema)
  const _c1 = Cell.of<string>();
  const _c2 = Cell.of<number>();
  const _c3 = Cell.of<boolean>();

  // cell() with type argument but no value - should become cell(undefined, schema)
  const _c4 = cell<string>();

  // ComparableCell.of with type argument but no value
  const _c5 = ComparableCell.of<{ name: string }>();

  // Mixed - some with value, some without
  const _c6 = Cell.of<string>("hello"); // has value
  const _c7 = Cell.of<number>(); // no value

  return null;
}
