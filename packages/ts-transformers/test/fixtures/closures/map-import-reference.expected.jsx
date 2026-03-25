import * as __cfHelpers from "commonfabric";
import { pattern, UI } from "commonfabric";
// Module-level constant - should NOT be captured
const TAX_RATE = 0.08;
// Module-level function - should NOT be captured
function formatPrice(price: number): string {
    return `$${price.toFixed(2)}`;
}
interface Item {
    id: number;
    price: number;
}
interface State {
    items: Item[];
}
// FIXTURE: map-import-reference
// Verifies: .map() on reactive array is transformed when callback references module-level constants and functions
//   .map(fn) → .mapWithPattern(pattern(...), {})
//   formatPrice(item.price * (1 + TAX_RATE)) → derive() wrapping the expression
// Context: Module-level constant (TAX_RATE) and function (formatPrice) are NOT captured as reactive params
export default pattern((state) => {
    return {
        [UI]: (<div>
        {/* Should NOT capture module-level constant or function */}
        {state.key("items").mapWithPattern(__cfHelpers.pattern(__ct_pattern_input => {
                const item = __ct_pattern_input.key("element");
                return (<div>
            Item: {__cfHelpers.derive({
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
                        }
                    },
                    required: ["item"]
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "string"
                } as const satisfies __cfHelpers.JSONSchema, { item: {
                        price: item.key("price")
                    } }, ({ item }) => formatPrice(item.price * (1 + TAX_RATE)))}
          </div>);
            }, {
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Item"
                    }
                },
                required: ["element"],
                $defs: {
                    Item: {
                        type: "object",
                        properties: {
                            id: {
                                type: "number"
                            },
                            price: {
                                type: "number"
                            }
                        },
                        required: ["id", "price"]
                    }
                }
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
            } as const satisfies __cfHelpers.JSONSchema), {})}
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
        }
    },
    required: ["items"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "number"
                },
                price: {
                    type: "number"
                }
            },
            required: ["id", "price"]
        }
    }
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
