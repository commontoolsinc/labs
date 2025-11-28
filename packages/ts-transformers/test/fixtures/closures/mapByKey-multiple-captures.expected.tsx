import * as __ctHelpers from "commontools";
import { mapByKey, recipe, UI } from "commontools";
interface State {
    products: {
        id: number;
        basePrice: number;
    }[];
    taxRate: number;
    discount: number;
}
export default recipe({
    type: "object",
    properties: {
        products: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    id: {
                        type: "number"
                    },
                    basePrice: {
                        type: "number"
                    }
                },
                required: ["id", "basePrice"]
            }
        },
        taxRate: {
            type: "number"
        },
        discount: {
            type: "number"
        }
    },
    required: ["products", "taxRate", "discount"]
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
    const priced = __ctHelpers.mapByKey(state.products, "id", __ctHelpers.recipe({
        type: "object",
        properties: {
            element: {
                type: "object",
                properties: {
                    id: {
                        type: "number"
                    },
                    basePrice: {
                        type: "number"
                    }
                },
                required: ["id", "basePrice"]
            },
            params: {
                type: "object",
                properties: {
                    state: {
                        type: "object",
                        properties: {
                            taxRate: {
                                type: "number",
                                asOpaque: true
                            },
                            discount: {
                                type: "number",
                                asOpaque: true
                            }
                        },
                        required: ["taxRate", "discount"]
                    }
                },
                required: ["state"]
            }
        },
        required: ["element", "params"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "object",
        properties: {
            id: {
                type: "number",
                asOpaque: true
            },
            finalPrice: {
                type: "number"
            }
        },
        required: ["id", "finalPrice"]
    } as const satisfies __ctHelpers.JSONSchema, ({ element: product, params: { state } }) => ({
        id: product.id,
        finalPrice: product.basePrice * (1 + state.taxRate) * state.discount,
    })), {
        state: {
            taxRate: state.taxRate,
            discount: state.discount
        }
    });
    return {
        [UI]: <div>Products: {__ctHelpers.derive({
            type: "object",
            properties: {
                priced: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            id: {
                                type: "number",
                                asOpaque: true
                            },
                            finalPrice: {
                                type: "number"
                            }
                        },
                        required: ["id", "finalPrice"]
                    },
                    asOpaque: true
                }
            },
            required: ["priced"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { priced: priced }, ({ priced }) => JSON.stringify(priced))}</div>,
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
