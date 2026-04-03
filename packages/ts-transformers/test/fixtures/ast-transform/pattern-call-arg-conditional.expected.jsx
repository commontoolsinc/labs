function __ctHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
const identity = __ctHardenFn(<T,>(value: T) => value);
// FIXTURE: pattern-call-arg-conditional
// Verifies: top-level ordinary helper calls with reactive arguments are lifted
//   as whole calls rather than lowering only the inner argument expression.
//   const label = identity(state.done ? "Done" : "Pending")
//   → const label = derive(..., ({ state }) => identity(state.done ? "Done" : "Pending"))
export default pattern((state) => {
    const label = __cfHelpers.derive({
        type: "object",
        properties: {
            state: {
                type: "object",
                properties: {
                    done: {
                        type: "boolean"
                    }
                },
                required: ["done"]
            }
        },
        required: ["state"]
    } as const satisfies __cfHelpers.JSONSchema, {
        "enum": ["Done", "Pending"]
    } as const satisfies __cfHelpers.JSONSchema, { state: {
            done: state.key("done")
        } }, ({ state }) => identity(state.done ? "Done" : "Pending"));
    return { label };
}, {
    type: "object",
    properties: {
        done: {
            type: "boolean"
        }
    },
    required: ["done"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        label: {
            type: "string"
        }
    },
    required: ["label"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__ctHardenFn(h);
