import { cell, NAME, pattern, UI } from "commonfabric";

// FIXTURE: conditional-empty-check
// Verifies: !cell.get().length && <JSX> is transformed to when() with derive() predicate
//   !items.get().length && <span> → when(derive({items}, ({items}) => !items.get().length), <span>)
// Context: Negated length check on a cell array used as conditional guard
export default pattern(() => {
  const items = cell<string[]>([]);
  return {
    [NAME]: "Conditional empty check",
    [UI]: (
      <div>
        {!items.get().length && <span>No items</span>}
      </div>
    ),
  };
});
