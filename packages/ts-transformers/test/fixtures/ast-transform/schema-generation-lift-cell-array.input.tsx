/// <cts-enable />
import { lift, Cell } from "commontools";

interface CharmEntry {
  id: string;
  name: string;
}

// Test that lift with single generic parameter preserves Cell wrapper
// This was broken on main - Cell would be unwrapped to ProxyArray
const logCharmsList = lift<{ charmsList: Cell<CharmEntry[]> }>(
  ({ charmsList }) => {
    console.log("logCharmsList: ", charmsList.get());
    return charmsList;
  },
);

export default logCharmsList;