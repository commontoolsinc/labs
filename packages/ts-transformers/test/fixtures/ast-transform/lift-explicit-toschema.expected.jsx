import * as __ctHelpers from "commontools";
import { lift, Cell, toSchema } from "commontools";
interface CharmEntry {
    id: string;
    name: string;
}
// Test: Explicit toSchema with undefined result schema
// This overload pattern: lift(toSchema<T>(), undefined, fn)
const logCharmsList = lift({
    type: "object",
    properties: {
        charmsList: {
            type: "array",
            items: {
                $ref: "#/$defs/CharmEntry"
            },
            asCell: true
        }
    },
    required: ["charmsList"],
    $defs: {
        CharmEntry: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                name: {
                    type: "string"
                }
            },
            required: ["id", "name"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, undefined, ({ charmsList }) => {
    console.log("logCharmsList: ", charmsList.get());
    return charmsList;
});
// FIXTURE: lift-explicit-toschema
// Verifies: lift() with explicit toSchema<T>() is replaced by the generated JSON schema
//   lift(toSchema<{ charmsList: Cell<CharmEntry[]> }>(), undefined, fn) → lift(generatedSchema, undefined, fn)
// Context: The toSchema() call is compiled away and replaced with the actual JSON schema object
export default logCharmsList;
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
