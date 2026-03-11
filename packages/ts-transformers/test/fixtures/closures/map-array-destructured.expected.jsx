import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
type PizzaEntry = [
    date: string,
    pizza: string
];
interface State {
    pizzas: PizzaEntry[];
    scale: number;
}
// FIXTURE: map-array-destructured
// Verifies: array destructuring in .map() is lowered, with and without captured outer state
//   .map(([date, pizza]) => ...) → .mapWithPattern(pattern(...), {}) with index-based keys
//   Closing over state.scale → captures { state: { scale: state.key("scale") } }
// Context: Two map calls — one without captures (empty {}), one with a captured outer variable
export default pattern((state) => {
    return {
        [UI]: (<div>
        {/* Map with array destructured parameter */}
        {state.key("pizzas").mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                const date = __ct_pattern_input.key("element", "0");
                const pizza = __ct_pattern_input.key("element", "1");
                return (<div>
            {date}: {pizza}
          </div>);
            }, {
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/PizzaEntry"
                    }
                },
                required: ["element"],
                $defs: {
                    PizzaEntry: {
                        type: "array",
                        items: {
                            type: "string"
                        }
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
            } as const satisfies __ctHelpers.JSONSchema), {})}

        {/* Map with array destructured parameter and capture */}
        {state.key("pizzas").mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                const date = __ct_pattern_input.key("element", "0");
                const pizza = __ct_pattern_input.key("element", "1");
                const state = __ct_pattern_input.key("params", "state");
                return (<div>
            {date}: {pizza} (scale: {state.key("scale")})
          </div>);
            }, {
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/PizzaEntry"
                    },
                    params: {
                        type: "object",
                        properties: {
                            state: {
                                type: "object",
                                properties: {
                                    scale: {
                                        type: "number",
                                        asOpaque: true
                                    }
                                },
                                required: ["scale"]
                            }
                        },
                        required: ["state"]
                    }
                },
                required: ["element", "params"],
                $defs: {
                    PizzaEntry: {
                        type: "array",
                        items: {
                            type: "string"
                        }
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
                    scale: state.key("scale")
                }
            })}
      </div>),
    };
}, {
    type: "object",
    properties: {
        pizzas: {
            type: "array",
            items: {
                $ref: "#/$defs/PizzaEntry"
            }
        },
        scale: {
            type: "number"
        }
    },
    required: ["pizzas", "scale"],
    $defs: {
        PizzaEntry: {
            type: "array",
            items: {
                type: "string"
            }
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
