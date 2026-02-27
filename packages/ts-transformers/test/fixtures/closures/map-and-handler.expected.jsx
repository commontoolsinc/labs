import * as __ctHelpers from "commontools";
import { Cell, pattern, UI } from "commontools";
interface State {
    items: Array<{
        price: number;
    }>;
    discount: number;
    selectedIndex: Cell<number>;
}
export default pattern((state) => {
    return {
        [UI]: (<div>
        {state.key("items").mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                const item = __ct_pattern_input.key("element");
                const index = __ct_pattern_input.key("index");
                const state = __ct_pattern_input.key("params", "state");
                return (<div>
            <span>{__ctHelpers.derive({
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
                        price: item.key("price")
                    },
                    state: {
                        discount: state.key("discount")
                    }
                }, ({ item, state }) => item.price * state.discount)}</span>
            <button type="button" onClick={__ctHelpers.handler(false as const satisfies __ctHelpers.JSONSchema, {
                    type: "object",
                    properties: {
                        state: {
                            type: "object",
                            properties: {
                                selectedIndex: {
                                    type: "number",
                                    asCell: true
                                }
                            },
                            required: ["selectedIndex"]
                        },
                        index: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["state", "index"]
                } as const satisfies __ctHelpers.JSONSchema, (__ct_handler_event, { state, index }) => state.selectedIndex.set(index))({
                    state: {
                        selectedIndex: state.key("selectedIndex")
                    },
                    index: index
                })}>
              Select
            </button>
          </div>);
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
                    index: {
                        type: "number"
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
                                    selectedIndex: {
                                        type: "number",
                                        asCell: true
                                    }
                                },
                                required: ["discount", "selectedIndex"]
                            }
                        },
                        required: ["state"]
                    }
                },
                required: ["element", "params"]
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
                    selectedIndex: state.key("selectedIndex")
                }
            })}
        <div>
          Selected: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
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
                            },
                            asOpaque: true
                        },
                        selectedIndex: {
                            type: "number",
                            asCell: true
                        }
                    },
                    required: ["items", "selectedIndex"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                items: state.key("items"),
                selectedIndex: state.key("selectedIndex")
            } }, ({ state }) => state.items[state.selectedIndex.get()]?.price ?? 0)} x {state.key("discount")} ={" "}
          {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
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
                            },
                            asOpaque: true
                        },
                        selectedIndex: {
                            type: "number",
                            asCell: true
                        },
                        discount: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["items", "selectedIndex", "discount"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                items: state.key("items"),
                selectedIndex: state.key("selectedIndex"),
                discount: state.key("discount")
            } }, ({ state }) => (state.items[state.selectedIndex.get()]?.price ?? 0) * state.discount)}
        </div>
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
        },
        selectedIndex: {
            type: "number",
            asCell: true
        }
    },
    required: ["items", "discount", "selectedIndex"]
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
