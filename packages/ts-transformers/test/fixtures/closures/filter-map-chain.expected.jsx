import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
interface Item {
    id: number;
    price: number;
    active: boolean;
}
interface State {
    items: Item[];
    taxRate: number;
}
export default pattern((state) => {
    return {
        [UI]: (<div>
        {/* Method chain: filter then map, both with captures */}
        {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        items: {
                            type: "array",
                            items: {
                                $ref: "#/$defs/Item"
                            },
                            asOpaque: true
                        }
                    },
                    required: ["items"]
                }
            },
            required: ["state"],
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
                        active: {
                            type: "boolean"
                        }
                    },
                    required: ["id", "price", "active"]
                }
            }
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "array",
            items: {
                $ref: "#/$defs/Item",
                asOpaque: true
            },
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
                        active: {
                            type: "boolean"
                        }
                    },
                    required: ["id", "price", "active"]
                }
            }
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                items: state.items
            } }, ({ state }) => state.items
            .filter((item) => item.active)).mapWithPattern(__ctHelpers.pattern(({ element: item, params: { state } }) => (<div>
              Total: {__ctHelpers.derive({
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
                        taxRate: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["taxRate"]
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
                taxRate: state.taxRate
            }
        }, ({ item, state }) => item.price * (1 + state.taxRate))}
            </div>), {
            type: "object",
            properties: {
                element: {
                    $ref: "#/$defs/Item",
                    asOpaque: true
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
                                }
                            },
                            required: ["taxRate"]
                        }
                    },
                    required: ["state"]
                }
            },
            required: ["element", "params"],
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
                        active: {
                            type: "boolean"
                        }
                    },
                    required: ["id", "price", "active"]
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
                taxRate: state.taxRate
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
                $ref: "#/$defs/Item"
            }
        },
        taxRate: {
            type: "number"
        }
    },
    required: ["items", "taxRate"],
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
                active: {
                    type: "boolean"
                }
            },
            required: ["id", "price", "active"]
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
