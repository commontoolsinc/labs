import * as __ctHelpers from "commontools";
import { Cell, cell, pattern, UI } from "commontools";
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
    } as const satisfies __ctHelpers.JSONSchema);
    return {
        [UI]: (<div>
        {typedValues.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                const value = __ct_pattern_input.key("element");
                const state = __ct_pattern_input.key("params", "state");
                return (<span>{__ctHelpers.derive({
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
                } as const satisfies __ctHelpers.JSONSchema, {
                    type: "number"
                } as const satisfies __ctHelpers.JSONSchema, {
                    value: value,
                    state: {
                        multiplier: state.key("multiplier")
                    }
                }, ({ value, state }) => value * state.multiplier)}</span>);
            }, {
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
            } as const satisfies __ctHelpers.JSONSchema, {
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
            } as const satisfies __ctHelpers.JSONSchema), {
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
} as const satisfies __ctHelpers.JSONSchema, {
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
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
