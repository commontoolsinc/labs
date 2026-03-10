import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
interface Point {
    x: number;
    y: number;
}
interface State {
    points: Point[];
    scale: number;
}
// FIXTURE: map-destructured-param
// Verifies: object destructuring in .map() param is lowered to key() calls on each property
//   .map(({ x, y }) => ...) → key("element", "x"), key("element", "y")
//   x * state.scale, y * state.scale → derive() calls with captured state
// Context: Captures state.scale from outer scope; destructured element properties used in expressions
export default pattern((state) => {
    return {
        [UI]: (<div>
        {/* Map with destructured parameter and capture */}
        {state.key("points").mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                const x = __ct_pattern_input.key("element", "x");
                const y = __ct_pattern_input.key("element", "y");
                const state = __ct_pattern_input.key("params", "state");
                return (<div>
            Point: ({__ctHelpers.derive({
                    type: "object",
                    properties: {
                        x: {
                            type: "number",
                            asOpaque: true
                        },
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
                    required: ["x", "state"]
                } as const satisfies __ctHelpers.JSONSchema, {
                    type: "number"
                } as const satisfies __ctHelpers.JSONSchema, {
                    x: x,
                    state: {
                        scale: state.key("scale")
                    }
                }, ({ x, state }) => x * state.scale)}, {__ctHelpers.derive({
                    type: "object",
                    properties: {
                        y: {
                            type: "number",
                            asOpaque: true
                        },
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
                    required: ["y", "state"]
                } as const satisfies __ctHelpers.JSONSchema, {
                    type: "number"
                } as const satisfies __ctHelpers.JSONSchema, {
                    y: y,
                    state: {
                        scale: state.key("scale")
                    }
                }, ({ y, state }) => y * state.scale)})
          </div>);
            }, {
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Point"
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
                    Point: {
                        type: "object",
                        properties: {
                            x: {
                                type: "number"
                            },
                            y: {
                                type: "number"
                            }
                        },
                        required: ["x", "y"]
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
        points: {
            type: "array",
            items: {
                $ref: "#/$defs/Point"
            }
        },
        scale: {
            type: "number"
        }
    },
    required: ["points", "scale"],
    $defs: {
        Point: {
            type: "object",
            properties: {
                x: {
                    type: "number"
                },
                y: {
                    type: "number"
                }
            },
            required: ["x", "y"]
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
