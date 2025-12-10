/// <cts-enable />
import { lift, Cell, toSchema } from "commontools";

interface CharmEntry {
  id: string;
  name: string;
}

// Test: Explicit toSchema with undefined result schema
// This overload pattern: lift(toSchema<T>(), undefined, fn)
const logCharmsList = lift(
  toSchema<{ charmsList: Cell<CharmEntry[]> }>(),
  undefined,
  ({ charmsList }) => {
    console.log("logCharmsList: ", charmsList.get());
    return charmsList;
  },
);

export default logCharmsList;
