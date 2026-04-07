function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { Cell, cell, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
const __cfModuleCallback_1 = __cfHardenFn(({ element: value, params: { state } }) => (<span>{__cfHelpers.derive({
    type: "object",
    properties: {
        value: {
            type: "number"
        },
        state: {
            type: "object",
            properties: {
                multiplier: {
                    type: "number"
                }
            },
            required: ["multiplier"]
        }
    },
    required: ["value", "state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, {
    value: value,
    state: {
        multiplier: state.multiplier
    }
}, ({ value, state }) => value * state.multiplier)}</span>));
interface State {
    values: number[];
    multiplier: number;
}
// FIXTURE: cell-map-with-captures
// Verifies: Cell.map() with outer-scope captures is transformed to mapWithPattern with params
//   typedValues.map((value) => <span>{value * state.multiplier}</span>)
//     → typedValues.mapWithPattern(pattern(...), { state: { multiplier: state.key("multiplier") } })
//   value * state.multiplier → derive({ value, state: { multiplier } }, ...)
// Context: The map callback captures `state.multiplier` from the outer scope,
//   which must be threaded through as a mapWithPattern param and re-derived inside.
export default pattern((state) => {
    // Explicitly type as Cell to ensure closure transformation
    const typedValues: Cell<number[]> = cell(state.key("values"), {
        type: "array",
        items: {
            type: "number"
        }
    } as const satisfies __cfHelpers.JSONSchema);
    return {
        [UI]: (<div>
        {typedValues.mapWithPattern(__cfHelpers.pattern(__cfModuleCallback_1, {
                type: "object",
                properties: {
                    element: {
                        type: "number"
                    },
                    params: {
                        type: "object",
                        properties: {
                            state: {
                                type: "object",
                                properties: {
                                    multiplier: {
                                        type: "number"
                                    }
                                },
                                required: ["multiplier"]
                            }
                        },
                        required: ["state"]
                    }
                },
                required: ["element", "params"]
            } as const satisfies __cfHelpers.JSONSchema, {
                anyOf: [{
                        $ref: "https://commonfabric.org/schemas/vnode.json"
                    }, {
                        $ref: "#/$defs/UIRenderable"
                    }, {
                        type: "object",
                        properties: {}
                    }],
                $defs: {
                    UIRenderable: {
                        type: "object",
                        properties: {
                            $UI: {
                                $ref: "https://commonfabric.org/schemas/vnode.json"
                            }
                        },
                        required: ["$UI"]
                    }
                }
            } as const satisfies __cfHelpers.JSONSchema), {
                state: {
                    multiplier: state.key("multiplier")
                }
            })}
      </div>),
    };
}, {
    type: "object",
    properties: {
        values: {
            type: "array",
            items: {
                type: "number"
            }
        },
        multiplier: {
            type: "number"
        }
    },
    required: ["values", "multiplier"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "#/$defs/JSXElement"
        }
    },
    required: ["$UI"],
    $defs: {
        JSXElement: {
            anyOf: [{
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }, {
                    $ref: "#/$defs/UIRenderable"
                }, {
                    type: "object",
                    properties: {}
                }]
        },
        UIRenderable: {
            type: "object",
            properties: {
                $UI: {
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }
            },
            required: ["$UI"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
