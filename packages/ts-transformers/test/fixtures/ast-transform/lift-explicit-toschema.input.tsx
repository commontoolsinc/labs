import { Cell, lift, toSchema } from "commonfabric";

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

const getStatus = lift(
  toSchema<{ status: "open" | "closed"; ignored: "draft" }>({
    description: "Status input",
  }),
  toSchema<string>(),
  ({ status }) => status,
);

// FIXTURE: lift-explicit-toschema
// Verifies: lift() with explicit toSchema<T>() is replaced by the generated JSON schema
//   lift(toSchema<{ charmsList: Cell<CharmEntry[]> }>(), undefined, fn) → lift(generatedSchema, undefined, fn)
// Context: The toSchema() call is compiled away and replaced with the actual JSON schema object
export default { logCharmsList, getStatus };
