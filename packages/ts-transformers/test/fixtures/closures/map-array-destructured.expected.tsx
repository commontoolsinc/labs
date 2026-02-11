import * as __ctHelpers from "commontools";
import { recipe, UI } from "commontools";
type PizzaEntry = [
    date: string,
    pizza: string
];
interface State {
    pizzas: PizzaEntry[];
    scale: number;
}
export default recipe({
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
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    return {
        [UI]: (<div>
        {/* Map with array destructured parameter */}
        {state.pizzas.mapWithPattern(__ctHelpers.recipe({
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/PizzaEntry"
                    },
                    params: {
                        type: "object",
                        properties: {}
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
            } as const satisfies __ctHelpers.JSONSchema, ({ element: [date, pizza], params: {} }) => (<div>
            {date}: {pizza}
          </div>)), {})}

        {/* Map with array destructured parameter and capture */}
        {state.pizzas.mapWithPattern(__ctHelpers.recipe({
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
            } as const satisfies __ctHelpers.JSONSchema, ({ element: [date, pizza], params: { state } }) => (<div>
            {date}: {pizza} (scale: {state.scale})
          </div>)), {
                state: {
                    scale: state.scale
                }
            })}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
