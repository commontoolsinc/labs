function __ctHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { lift, Cell, toSchema } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
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
} as const satisfies __cfHelpers.JSONSchema, undefined, ({ charmsList }) => {
    console.log("logCharmsList: ", charmsList.get());
    return charmsList;
});
// FIXTURE: lift-explicit-toschema
// Verifies: lift() with explicit toSchema<T>() is replaced by the generated JSON schema
//   lift(toSchema<{ charmsList: Cell<CharmEntry[]> }>(), undefined, fn) → lift(generatedSchema, undefined, fn)
// Context: The toSchema() call is compiled away and replaced with the actual JSON schema object
export default logCharmsList;
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__ctHardenFn(h);
