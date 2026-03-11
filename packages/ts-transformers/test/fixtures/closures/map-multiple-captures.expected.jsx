import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
interface Item {
    price: number;
    quantity: number;
}
interface State {
    items: Item[];
    discount: number;
    taxRate: number;
}
const shippingCost = 5.99;
// FIXTURE: map-multiple-captures
// Verifies: .map() on reactive array captures multiple outer variables (state + local)
//   .map(fn) → .mapWithPattern(pattern(...), {state: {discount, taxRate}, multiplier})
//   expression → derive() combining element props, state props, and local variable
// Context: Captures state.discount, state.taxRate, and local const multiplier; module-level shippingCost is not captured
export default pattern((state) => {
    const multiplier = 2;
    return {
        [UI]: (<div>
        {state.key("items").mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                const item = __ct_pattern_input.key("element");
                const state = __ct_pattern_input.key("params", "state");
                const multiplier = __ct_pattern_input.params.multiplier;
                return (<span>
            Total: {__ctHelpers.derive({
                    type: "object",
                    properties: {
                        item: {
                            type: "object",
                            properties: {
                                price: {
                                    type: "number",
                                    asOpaque: true
                                },
                                quantity: {
                                    type: "number",
                                    asOpaque: true
                                }
                            },
                            required: ["price", "quantity"]
                        },
                        state: {
                            type: "object",
                            properties: {
                                discount: {
                                    type: "number",
                                    asOpaque: true
                                },
                                taxRate: {
                                    type: "number",
                                    asOpaque: true
                                }
                            },
                            required: ["discount", "taxRate"]
                        },
                        multiplier: {
                            type: "number"
                        }
                    },
                    required: ["item", "state", "multiplier"]
                } as const satisfies __ctHelpers.JSONSchema, {
                    type: "number"
                } as const satisfies __ctHelpers.JSONSchema, {
                    item: {
                        price: item.key("price"),
                        quantity: item.key("quantity")
                    },
                    state: {
                        discount: state.key("discount"),
                        taxRate: state.key("taxRate")
                    },
                    multiplier: multiplier
                }, ({ item, state, multiplier }) => item.price * item.quantity * state.discount * state.taxRate * multiplier + shippingCost)}
          </span>);
            }, {
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Item"
                    },
                    params: {
                        type: "object",
                        properties: {
                            state: {
                                type: "object",
                                properties: {
                                    discount: {
                                        type: "number",
                                        asOpaque: true
                                    },
                                    taxRate: {
                                        type: "number",
                                        asOpaque: true
                                    }
                                },
                                required: ["discount", "taxRate"]
                            },
                            multiplier: {
                                type: "number"
                            }
                        },
                        required: ["state", "multiplier"]
                    }
                },
                required: ["element", "params"],
                $defs: {
                    Item: {
                        type: "object",
                        properties: {
                            price: {
                                type: "number"
                            },
                            quantity: {
                                type: "number"
                            }
                        },
                        required: ["price", "quantity"]
                    }
                }
            } as const satisfies __ctHelpers.JSONSchema, {
                anyOf: [{
                        $ref: "https://commonfabric.org/schemas/vnode.json"
                    }, {
                        type: "object",
                        properties: {}
                    }, {
                        $ref: "#/$defs/UIRenderable",
                        asOpaque: true
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
                    discount: state.key("discount"),
                    taxRate: state.key("taxRate")
                },
                multiplier: multiplier
            })}
      </div>),
    };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            }
        },
        discount: {
            type: "number"
        },
        taxRate: {
            type: "number"
        }
    },
    required: ["items", "discount", "taxRate"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                price: {
                    type: "number"
                },
                quantity: {
                    type: "number"
                }
            },
            required: ["price", "quantity"]
        }
    }
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
                    type: "object",
                    properties: {}
                }, {
                    $ref: "#/$defs/UIRenderable",
                    asOpaque: true
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
