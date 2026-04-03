/// <cts-enable />
import { cell, ComparableCell, ReadonlyCell, WriteonlyCell } from "commonfabric";

// FIXTURE: cell-like-classes
// Verifies: schema injection works for cell(), ComparableCell.of(), ReadonlyCell.of(), and WriteonlyCell.of()
//   cell(100) → cell(100, { type: "number" })
//   ComparableCell.of(200) → ComparableCell.of(200, { type: "number" })
//   ReadonlyCell.of(300) → ReadonlyCell.of(300, { type: "number" })
//   WriteonlyCell.of(400) → WriteonlyCell.of(400, { type: "number" })
export default function TestCellLikeClasses() {
  // Standalone cell() function
  const _standalone = cell(100);

  // ComparableCell.of()
  const _comparable = ComparableCell.of(200);

  // ReadonlyCell.of()
  const _readonly = ReadonlyCell.of(300);

  // WriteonlyCell.of()
  const _writeonly = WriteonlyCell.of(400);

  return {
    standalone: _standalone,
    comparable: _comparable,
    readonly: _readonly,
    writeonly: _writeonly,
  };
}
