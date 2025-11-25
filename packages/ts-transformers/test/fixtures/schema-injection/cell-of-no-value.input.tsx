/// <cts-enable />
import { Cell, cell, ComparableCell } from "commontools";

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
