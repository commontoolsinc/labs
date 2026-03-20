import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
interface State {
    items: Array<{
        price: number;
    }>;
    discount: number;
}
// FIXTURE: map-destructured-alias
// Verifies: object destructuring with alias in .map() param is lowered to key() on the original name
//   .map(({ price: cost }) => ...) → key("element", "price") assigned to cost
//   cost * state.discount → derive() with both element key and captured state
// Context: Captures state.discount from outer scope; alias uses the original property name for key access
export default pattern((state) => {
    return {
        [UI]: (<div>
        {state.key("items").mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                const cost = __ct_pattern_input.key("element", "price");
                const state = __ct_pattern_input.key("params", "state");
                return (<span>{__ctHelpers.derive({
                    type: "object",
                    properties: {
                        cost: {
                            type: "number"
                        },
                        state: {
                            type: "object",
                            properties: {
                                discount: {
                                    type: "number"
                                }
                            },
                            required: ["discount"]
                        }
                    },
                    required: ["cost", "state"]
                } as const satisfies __ctHelpers.JSONSchema, {
                    type: "number"
                } as const satisfies __ctHelpers.JSONSchema, {
                    cost: cost,
                    state: {
                        discount: state.key("discount")
                    }
                }, ({ cost, state }) => cost * state.discount)}</span>);
            }, {
                type: "object",
                properties: {
                    element: {
                        type: "object",
                        properties: {
                            price: {
                                type: "number"
                            }
                        },
                        required: ["price"]
                    },
                    params: {
                        type: "object",
                        properties: {
                            state: {
                                type: "object",
                                properties: {
                                    discount: {
                                        type: "number"
                                    }
                                },
                                required: ["discount"]
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
                    discount: state.key("discount")
                }
            })}
      </div>),
    };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    price: {
                        type: "number"
                    }
                },
                required: ["price"]
            }
        },
        discount: {
            type: "number"
        }
    },
    required: ["items", "discount"]
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
