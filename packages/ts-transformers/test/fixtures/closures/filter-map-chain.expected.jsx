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
// FIXTURE: filter-map-chain
// Verifies: filter+map chain with captured outer variables
//   .filter(fn) → .filterWithPattern(pattern(...), {})  — no captures
//   .map(fn)    → .mapWithPattern(pattern(...), { state: { taxRate } })
// Context: The map callback captures state.taxRate from outer scope, so it
//   appears in the params object and the map body uses derive() for the
//   reactive computation. The filter has no captures (only element properties).
export default pattern((state) => {
    return {
        [UI]: (<div>
        {state.items.filterWithPattern(__ctHelpers.pattern(({ element: item, params: {} }) => item.active, {
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Item"
                    },
                    params: {
                        type: "object",
                        properties: {}
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
                type: "boolean",
                asOpaque: true
            } as const satisfies __ctHelpers.JSONSchema), {}).mapWithPattern(__ctHelpers.pattern(({ element: item, params: { state } }) => (<div>
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
