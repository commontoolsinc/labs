import { lift, Cell, toSchema } from "commonfabric";

interface CharmEntry {
  id: string;
  name: string;
}

// Test: Explicit toSchema, function-first order.
// This overload pattern: lift(fn, toSchema<T>())  (result schema omitted)
const logCharmsList = lift(
  ({ charmsList }) => {
    console.log("logCharmsList: ", charmsList.get());
    return charmsList;
  },
  toSchema<{ charmsList: Cell<CharmEntry[]> }>(),
);

const getStatus = lift(
  ({ status }) => status,
  toSchema<{ status: "open" | "closed"; ignored: "draft" }>({
    description: "Status input",
  }),
  toSchema<string>(),
);

// FIXTURE: lift-explicit-toschema
// Verifies: lift() with explicit toSchema<T>() is replaced by the generated JSON schema
//   lift(fn, toSchema<{ charmsList: Cell<CharmEntry[]> }>()) → lift(fn, generatedSchema)
// Context: The toSchema() call is compiled away and replaced with the actual JSON schema object
export default { logCharmsList, getStatus };
