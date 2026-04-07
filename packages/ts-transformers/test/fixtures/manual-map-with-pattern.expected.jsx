function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import * as __cfHelpers from "commonfabric";
import { pattern, UI } from "commonfabric";
interface Item {
    price: number;
}
interface State {
    items: Item[];
    discount: number;
}
export default pattern((state) => {
    return {
        [UI]: (<div>
        {state.key("items").mapWithPattern(pattern((__cf_pattern_input) => {
                const element = __cf_pattern_input.key("element");
                const params = __cf_pattern_input.key("params");
                return (<span>{__cfHelpers.derive({
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
                                discount: {
                                    type: "number"
                                }
                            },
                            required: ["discount"]
                        }
                    },
                    required: ["element", "params"]
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "number"
                } as const satisfies __cfHelpers.JSONSchema, {
                    element: {
                        price: element.key("price")
                    },
                    params: {
                        discount: params.key("discount")
                    }
                }, ({ element, params }) => element.price * params.discount)}</span>);
            }, {
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Item"
                    },
                    params: {
                        type: "object",
                        properties: {
                            discount: {
                                type: "number"
                            }
                        },
                        required: ["discount"]
                    }
                },
                required: ["element", "params"],
                $defs: {
                    Item: {
                        type: "object",
                        properties: {
                            price: {
                                type: "number"
                            }
                        },
                        required: ["price"]
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
            } as const satisfies __cfHelpers.JSONSchema), { discount: state.key("discount") })}
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
        }
    },
    required: ["items", "discount"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                price: {
                    type: "number"
                }
            },
            required: ["price"]
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
__cfHardenFn(h);
