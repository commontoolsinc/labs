import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
interface Item {
    id: number;
    price: number;
}
interface State {
    items: Item[];
    discount: number;
    threshold: number;
}
export default pattern((state) => {
    return {
        [UI]: (<div>
        {/* Ternary with captures in map callback */}
        {state.items.map((item) => (<div>
            Price: ${__ctHelpers.ifElse({
                type: "boolean"
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "number"
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "number",
                asOpaque: true
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "number"
            } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
                type: "object",
                properties: {
                    item: {
                        type: "object",
                        properties: {
                            price: {
                                type: "number",
                                asOpaque: true
                            }
                        },
                        required: ["price"]
                    },
                    state: {
                        type: "object",
                        properties: {
                            threshold: {
                                type: "number",
                                asOpaque: true
                            }
                        },
                        required: ["threshold"]
                    }
                },
                required: ["item", "state"]
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "boolean"
            } as const satisfies __ctHelpers.JSONSchema, {
                item: {
                    price: item.price
                },
                state: {
                    threshold: state.threshold
                }
            }, ({ item, state }) => item.price > state.threshold), __ctHelpers.derive({
                type: "object",
                properties: {
                    item: {
                        type: "object",
                        properties: {
                            price: {
                                type: "number",
                                asOpaque: true
                            }
                        },
                        required: ["price"]
                    },
                    state: {
                        type: "object",
                        properties: {
                            discount: {
                                type: "number",
                                asOpaque: true
                            }
                        },
                        required: ["discount"]
                    }
                },
                required: ["item", "state"]
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "number"
            } as const satisfies __ctHelpers.JSONSchema, {
                item: {
                    price: item.price
                },
                state: {
                    discount: state.discount
                }
            }, ({ item, state }) => item.price * (1 - state.discount)), item.price)}
          </div>))}
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
        threshold: {
            type: "number"
        }
    },
    required: ["items", "discount", "threshold"],
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
