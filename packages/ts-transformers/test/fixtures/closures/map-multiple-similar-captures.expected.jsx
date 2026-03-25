import * as __cfHelpers from "commonfabric";
import { pattern, UI } from "commonfabric";
interface State {
    items: Array<{
        price: number;
    }>;
    checkout: {
        discount: number;
    };
    upsell: {
        discount: number;
    };
}
// FIXTURE: map-multiple-similar-captures
// Verifies: .map() correctly captures multiple state properties with the same leaf name
//   .map(fn) → .mapWithPattern(pattern(...), {state: {checkout: {discount}, upsell: {discount}}})
//   expression → derive() with both discount paths distinguished
// Context: state.checkout.discount and state.upsell.discount share the name "discount" but are separate captures
export default pattern((state) => {
    return {
        [UI]: (<div>
        {state.key("items").mapWithPattern(__cfHelpers.pattern(__ct_pattern_input => {
                const item = __ct_pattern_input.key("element");
                const state = __ct_pattern_input.key("params", "state");
                return (<span>
            {__cfHelpers.derive({
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
                        },
                        state: {
                            type: "object",
                            properties: {
                                checkout: {
                                    type: "object",
                                    properties: {
                                        discount: {
                                            type: "number"
                                        }
                                    },
                                    required: ["discount"]
                                },
                                upsell: {
                                    type: "object",
                                    properties: {
                                        discount: {
                                            type: "number"
                                        }
                                    },
                                    required: ["discount"]
                                }
                            },
                            required: ["checkout", "upsell"]
                        }
                    },
                    required: ["item", "state"]
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "number"
                } as const satisfies __cfHelpers.JSONSchema, {
                    item: {
                        price: item.key("price")
                    },
                    state: {
                        checkout: {
                            discount: state.key("checkout", "discount")
                        },
                        upsell: {
                            discount: state.key("upsell", "discount")
                        }
                    }
                }, ({ item, state }) => item.price * state.checkout.discount * state.upsell.discount)}
          </span>);
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
                    params: {
                        type: "object",
                        properties: {
                            state: {
                                type: "object",
                                properties: {
                                    checkout: {
                                        type: "object",
                                        properties: {
                                            discount: {
                                                type: "number"
                                            }
                                        },
                                        required: ["discount"]
                                    },
                                    upsell: {
                                        type: "object",
                                        properties: {
                                            discount: {
                                                type: "number"
                                            }
                                        },
                                        required: ["discount"]
                                    }
                                },
                                required: ["checkout", "upsell"]
                            }
                        },
                        required: ["state"]
                    }
                },
                required: ["element", "params"]
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
            } as const satisfies __cfHelpers.JSONSchema), {
                state: {
                    checkout: {
                        discount: state.key("checkout", "discount")
                    },
                    upsell: {
                        discount: state.key("upsell", "discount")
                    }
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
                type: "object",
                properties: {
                    price: {
                        type: "number"
                    }
                },
                required: ["price"]
            }
        },
        checkout: {
            type: "object",
            properties: {
                discount: {
                    type: "number"
                }
            },
            required: ["discount"]
        },
        upsell: {
            type: "object",
            properties: {
                discount: {
                    type: "number"
                }
            },
            required: ["discount"]
        }
    },
    required: ["items", "checkout", "upsell"]
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
