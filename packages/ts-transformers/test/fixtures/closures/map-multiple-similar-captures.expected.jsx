function __ctHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
const __ctModuleCallback_1 = __ctHardenFn(({ element: item, params: { state } }) => (<span>
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
        price: item.price
    },
    state: {
        checkout: {
            discount: state.checkout.discount
        },
        upsell: {
            discount: state.upsell.discount
        }
    }
}, ({ item, state }) => item.price * state.checkout.discount * state.upsell.discount)}
          </span>));
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
        {state.key("items").mapWithPattern(__cfHelpers.pattern(__ctModuleCallback_1, {
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
__ctHardenFn(h);
