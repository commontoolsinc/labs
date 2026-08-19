function __cfBindVerifiedBinding(value: any, metadata: any) {
    if (value && (typeof value === "object" || typeof value === "function") && Object.isExtensible(value)) {
        Object.defineProperty(value, "__cfVerifiedBindingIdentity", {
            value: metadata,
            configurable: true
        });
    }
    if (value && (typeof value === "object" || typeof value === "function") && typeof value.implementation === "function") {
        var implementation = value.implementation;
        if (implementation && (typeof implementation === "object" || typeof implementation === "function") && Object.isExtensible(implementation)) {
            Object.defineProperty(implementation, "__cfVerifiedBindingIdentity", {
                value: metadata,
                configurable: true
            });
        }
    }
    return value;
}
function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Writable, computed, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface State {
    counter: {
        value: number;
    };
}
const __cfLift_1 = __cfHelpers.lift<{
    value: __cfHelpers.ReadonlyCell<number>;
    state: {
        counter: {
            value: number;
        };
    };
}, number>(({ value, state }) => value.get() + state.counter.value, {
    type: "object",
    properties: {
        value: {
            type: "number",
            asCell: ["readonly"]
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
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
__cfBindVerifiedBinding(__cfLift_1, {
    sourceFile: "/test.tsx",
    position: { line: 16, col: 26 },
    bindingName: "result"
});
// FIXTURE: computed-method-call-capture
// Verifies: a deep property access on a captured object is restructured into a nested capture object
//   computed(() => value.get() + state.counter.value) → lift(...)({ value, state: { counter: { value } } })
// Context: `state.counter.value` is captured as a nested object structure, not a flat binding
export default __cfBindVerifiedBinding(pattern((state: State) => {
    const value = new Writable(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("value", true);
    // Capture a deep property path on the pattern input
    const result = __cfLift_1({
        value: value,
        state: {
            counter: {
                value: state.key("counter", "value")
            }
        }
    }).for("result", true);
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
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 12, col: 23 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1
});
