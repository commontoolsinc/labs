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
    counter: {
        value: number;
    };
}
// FIXTURE: derive-method-call-capture
// Verifies: a deep property access on a captured object is restructured into a nested capture object
//   derive(value, fn) → derive(schema, schema, { value, state: { counter: { value: state.counter.value } } }, fn)
// Context: `state.counter.value` is captured as a nested object structure, not a flat binding
export default pattern((state: State) => {
    const value = Writable.of(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    // Capture property before method call
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
                    counter: {
                        type: "object",
                        properties: {
                            value: {
                                type: "number"
                            }
                        },
                        required: ["value"]
                    }
                },
                required: ["counter"]
            }
        },
        required: ["value", "state"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, {
        value,
        state: {
            counter: {
                value: state.key("counter", "value")
            }
        }
    }, ({ value: v, state }) => v.get() + state.counter.value);
    return result;
}, {
    type: "object",
    properties: {
        counter: {
            type: "object",
            properties: {
                value: {
                    type: "number"
                }
            },
            required: ["value"]
        }
    },
    required: ["counter"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__ctHardenFn(h);
