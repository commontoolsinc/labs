/// <cts-enable />
import { cell, ComparableCell, ReadonlyCell, WriteonlyCell } from "commontools";

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
