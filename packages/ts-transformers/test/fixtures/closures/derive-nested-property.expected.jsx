function __ctHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { Writable, derive, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
interface State {
    config: {
        multiplier: number;
    };
}
// FIXTURE: derive-nested-property
// Verifies: a nested property path on a captured object produces a nested capture structure
//   derive(value, fn) → derive(schema, schema, { value, state: { config: { multiplier: ... } } }, fn)
// Context: `state.config.multiplier` is a two-level deep property access captured as a nested object
export default pattern((state: State) => {
    const value = Writable.of(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    const result = __cfHelpers.derive({
        type: "object",
        properties: {
            value: {
                type: "number",
                asCell: true
            },
            state: {
                type: "object",
                properties: {
                    config: {
                        type: "object",
                        properties: {
                            multiplier: {
                                type: "number"
                            }
                        },
                        required: ["multiplier"]
                    }
                },
                required: ["config"]
            }
        },
        required: ["value", "state"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, {
        value,
        state: {
            config: {
                multiplier: state.key("config", "multiplier")
            }
        }
    }, ({ value: v, state }) => v.get() * state.config.multiplier);
    return result;
}, {
    type: "object",
    properties: {
        config: {
            type: "object",
            properties: {
                multiplier: {
                    type: "number"
                }
            },
            required: ["multiplier"]
        }
    },
    required: ["config"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__ctHardenFn(h);
