import * as __ctHelpers from "commontools";
import { recipe, UI } from "commontools";
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
export default recipe({
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
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    const multiplier = 2;
    return {
        [UI]: (<div>
        {state.items.mapWithPattern(__ctHelpers.recipe({
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
                                type: "number",
                                enum: [2]
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
            } as const satisfies __ctHelpers.JSONSchema, ({ element: item, params: { state, multiplier } }) => (<span>
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
                    }
                },
                required: ["item", "state"]
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "number"
            } as const satisfies __ctHelpers.JSONSchema, {
                item: {
                    price: item.price,
                    quantity: item.quantity
                },
                state: {
                    discount: state.discount,
                    taxRate: state.taxRate
                }
            }, ({ item, state }) => item.price * item.quantity * state.discount * state.taxRate * multiplier + shippingCost)}
          </span>)), {
                state: {
                    discount: state.discount,
                    taxRate: state.taxRate
                },
                multiplier: multiplier
            })}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
