function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { lift, Cell, toSchema } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface CharmEntry {
    id: string;
    name: string;
}
// Test: Explicit toSchema, function-first order.
// This overload pattern: lift(fn, toSchema<T>())  (result schema omitted)
const logCharmsList = lift(({ charmsList }) => {
    console.log("logCharmsList: ", charmsList.get());
    return charmsList;
}, {
    type: "object",
    properties: {
        charmsList: {
            type: "array",
            items: {
                $ref: "#/$defs/CharmEntry"
            },
            asCell: ["cell"]
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
} as const satisfies __cfHelpers.JSONSchema);
const getStatus = lift(({ status }) => status, {
    type: "object",
    properties: {
        status: {
            "enum": ["open", "closed"]
        },
        ignored: {
            type: "string",
            "enum": ["draft"]
        }
    },
    required: ["status", "ignored"],
    description: "Status input"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: lift-explicit-toschema
// Verifies: lift() with explicit toSchema<T>() is replaced by the generated JSON schema
//   lift(fn, toSchema<{ charmsList: Cell<CharmEntry[]> }>()) → lift(fn, generatedSchema)
// Context: The toSchema() call is compiled away and replaced with the actual JSON schema object
export default __cfHelpers.__cf_data({ logCharmsList, getStatus });
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    logCharmsList,
    getStatus
});
