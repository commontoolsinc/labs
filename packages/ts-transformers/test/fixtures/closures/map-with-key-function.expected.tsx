import * as __ctHelpers from "commontools";
import { recipe, UI, Cell } from "commontools";
interface Item {
    id: number;
    price: number;
    category: {
        name: string;
    };
}
interface State {
    items: Cell<Item[]>;
    discount: number;
}
export default recipe({
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            asCell: true
        },
        discount: {
            type: "number"
        }
    },
    required: ["items", "discount"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "number"
                },
                price: {
                    type: "number"
                },
                category: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string"
                        }
                    },
                    required: ["name"]
                }
            },
            required: ["id", "price", "category"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "#/$defs/Element"
        }
    },
    required: ["$UI"],
    $defs: {
        Element: {
            type: "object",
            properties: {
                type: {
                    type: "string",
                    "enum": ["vnode"]
                },
                name: {
                    type: "string"
                },
                props: {
                    $ref: "#/$defs/Props"
                },
                children: {
                    $ref: "#/$defs/RenderNode"
                },
                $UI: {
                    $ref: "#/$defs/VNode"
                }
            },
            required: ["type", "name", "props"]
        },
        VNode: {
            type: "object",
            properties: {
                type: {
                    type: "string",
                    "enum": ["vnode"]
                },
                name: {
                    type: "string"
                },
                props: {
                    $ref: "#/$defs/Props"
                },
                children: {
                    $ref: "#/$defs/RenderNode"
                },
                $UI: {
                    $ref: "#/$defs/VNode"
                }
            },
            required: ["type", "name", "props"]
        },
        RenderNode: {
            anyOf: [{
                    type: "string"
                }, {
                    type: "number"
                }, {
                    type: "boolean",
                    "enum": [false]
                }, {
                    type: "boolean",
                    "enum": [true]
                }, {
                    $ref: "#/$defs/VNode"
                }, {
                    type: "object",
                    properties: {}
                }, {
                    type: "array",
                    items: {
                        $ref: "#/$defs/RenderNode"
                    }
                }]
        },
        Props: {
            type: "object",
            properties: {},
            additionalProperties: {
                anyOf: [{
                        type: "string"
                    }, {
                        type: "number"
                    }, {
                        type: "boolean",
                        "enum": [false]
                    }, {
                        type: "boolean",
                        "enum": [true]
                    }, {
                        type: "object",
                        additionalProperties: true
                    }, {
                        type: "array",
                        items: true
                    }, {
                        asCell: true
                    }, {
                        asStream: true
                    }, {
                        type: "null"
                    }]
            }
        }
    }
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    // Using key function syntax: .map(fn, { key: item => item.id })
    // This gets compiled to { key: "id" } at build time
    const discounted = __ctHelpers.mapByKey(state.items, "id", __ctHelpers.recipe({
        type: "object",
        properties: {
            element: true,
            params: {
                type: "object",
                properties: {
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
                required: ["state"]
            }
        },
        required: ["element", "params"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "object",
        properties: {
            discountedPrice: {
                type: "number"
            }
        },
        required: ["discountedPrice"]
    } as const satisfies __ctHelpers.JSONSchema, ({ element: item, key: _key, params: { state } }) => ({ discountedPrice: item.price * state.discount })), {
        state: {
            discount: state.discount
        }
    });
    // Also test nested property access: { key: item => item.category.name }
    // This gets compiled to { key: ["category", "name"] }
    const byCategory = __ctHelpers.mapByKey(state.items, ["category", "name"], __ctHelpers.recipe({
        type: "object",
        properties: {
            element: true,
            params: {
                type: "object",
                properties: {}
            }
        },
        required: ["element", "params"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "object",
        properties: {
            price: {
                type: "number",
                asOpaque: true
            }
        },
        required: ["price"]
    } as const satisfies __ctHelpers.JSONSchema, ({ element: item, key: _key, params: {} }) => ({ price: item.price })), {});
    return {
        [UI]: (<div>
        Discounted: {__ctHelpers.derive({
            type: "object",
            properties: {
                discounted: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            discountedPrice: {
                                type: "number"
                            }
                        },
                        required: ["discountedPrice"]
                    },
                    asOpaque: true
                }
            },
            required: ["discounted"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { discounted: discounted }, ({ discounted }) => JSON.stringify(discounted))}
        By Category: {__ctHelpers.derive({
            type: "object",
            properties: {
                byCategory: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            price: {
                                type: "number",
                                asOpaque: true
                            }
                        },
                        required: ["price"]
                    },
                    asOpaque: true
                }
            },
            required: ["byCategory"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { byCategory: byCategory }, ({ byCategory }) => JSON.stringify(byCategory))}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
