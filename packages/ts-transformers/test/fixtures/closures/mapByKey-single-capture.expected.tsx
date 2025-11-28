import * as __ctHelpers from "commontools";
import { mapByKey, recipe, UI } from "commontools";
interface State {
    items: {
        id: number;
        price: number;
    }[];
    discount: number;
}
export default recipe({
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
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
    const discounted = __ctHelpers.mapByKey(state.items, "id", __ctHelpers.recipe({
        type: "object",
        properties: {
            element: {
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
    } as const satisfies __ctHelpers.JSONSchema, ({ element: item, params: { state } }) => ({ discountedPrice: item.price * state.discount })), {
        state: {
            discount: state.discount
        }
    });
    return {
        [UI]: <div>Items: {__ctHelpers.derive({
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
        } as const satisfies __ctHelpers.JSONSchema, { discounted: discounted }, ({ discounted }) => JSON.stringify(discounted))}</div>,
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
