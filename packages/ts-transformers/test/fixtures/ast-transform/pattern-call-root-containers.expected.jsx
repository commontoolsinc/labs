function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const identity = __cfHardenFn(<T,>(value: T) => value);
// FIXTURE: pattern-call-root-containers
// Verifies: top-level ordinary call roots whole-wrap consistently across
//   non-JSX container kinds instead of lowering only their nested conditional
//   arguments.
//   { value: identity(state.done ? "Done" : "Pending") }
//   → { value: derive(..., ({ state }) => identity(state.done ? "Done" : "Pending")) }
//   [identity(state.done ? "Done" : "Pending")]
//   → [derive(..., ({ state }) => identity(state.done ? "Done" : "Pending"))]
//   return identity(state.done ? "Done" : "Pending")
//   → return derive(..., ({ state }) => identity(state.done ? "Done" : "Pending"))
export const objectAndArray = pattern((state) => {
    const view = {
        value: __cfHelpers.derive({
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
            } }, ({ state }) => identity(state.done ? "Done" : "Pending")),
        list: [__cfHelpers.derive({
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
                } }, ({ state }) => identity(state.done ? "Done" : "Pending"))],
    };
    return view;
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
        value: {
            type: "string"
        },
        list: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["value", "list"]
} as const satisfies __cfHelpers.JSONSchema);
export default pattern((state) => __cfHelpers.derive({
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
    } }, ({ state }) => identity(state.done ? "Done" : "Pending")), {
    type: "object",
    properties: {
        done: {
            type: "boolean"
        }
    },
    required: ["done"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
