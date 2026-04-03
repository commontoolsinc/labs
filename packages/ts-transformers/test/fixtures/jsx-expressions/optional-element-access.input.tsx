/// <cts-enable />
import { cell, NAME, pattern, UI } from "commonfabric";

// FIXTURE: optional-element-access
// Verifies: optional element access (?.[0]) in a negated && guard is transformed to when(derive(...))
//   !list.get()?.[0] && <span> → when(derive({list}, ({list}) => !list.get()?.[0]), <span>)
// Context: Cell typed as string[] | undefined, with optional bracket access
export default pattern(() => {
  const list = cell<string[] | undefined>(undefined);
  return {
    [NAME]: "Optional element access",
    [UI]: (
      <div>
        {!list.get()?.[0] && <span>No first entry</span>}
      </div>
    ),
  };
});
