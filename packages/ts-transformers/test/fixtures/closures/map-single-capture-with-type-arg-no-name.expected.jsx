import * as __cfHelpers from "commonfabric";
import { pattern, UI } from "commonfabric";
interface State {
    items: Array<{
        price: number;
    }>;
    discount: number;
}
// FIXTURE: map-single-capture-with-type-arg-no-name
// Verifies: .map() transform with single capture works with type arg on pattern
//   .map(fn) → .mapWithPattern(pattern(...), {state: {discount: ...}})
// Context: Same as map-single-capture but exercises the type-arg-no-name code path
export default pattern((state) => {
    return {
        [UI]: (<div>
        {state.key("items").mapWithPattern(__cfHelpers.pattern(__ct_pattern_input => {
                const item = __ct_pattern_input.key("element");
                const state = __ct_pattern_input.key("params", "state");
                return (<span>{__cfHelpers.derive({
                    type: "object",
                    properties: {
                        item: {
                            type: "object",
                            properties: {
                                price: {
                                    type: "number"
                                }
                            },
                            required: ["price"]
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
                    required: ["item", "state"]
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "number"
                } as const satisfies __cfHelpers.JSONSchema, {
                    item: {
                        price: item.key("price")
                    },
                    state: {
                        discount: state.key("discount")
                    }
                }, ({ item, state }) => item.price * state.discount)}</span>);
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
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
