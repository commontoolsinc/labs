/// <cts-enable />
import { Cell, lift } from "commonfabric";

interface CharmEntry {
  id: string;
  name: string;
}

// FIXTURE: schema-generation-lift-cell-array
// Verifies: lift() with Cell<T[]> in the generic arg preserves asCell in the generated schema
//   lift<{ charmsList: Cell<CharmEntry[]> }>(fn) → lift(inputSchema, outputSchema, fn)
// Context: Cell wrapper must produce `asCell: true` in the schema; output schema inferred from return type
// Test that lift with single generic parameter preserves Cell wrapper
// This was broken on main - Cell would be unwrapped to ProxyArray
const logCharmsList = lift<{ charmsList: Cell<CharmEntry[]> }>(
  ({ charmsList }) => {
    console.log("logCharmsList: ", charmsList.get());
    return charmsList;
  },
);

export default logCharmsList;
