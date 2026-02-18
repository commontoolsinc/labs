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
export default pattern((state) => {
    return {
        [UI]: (<div>
        {/* Map with destructured parameter and capture */}
        {state.points.mapWithPattern(__ctHelpers.pattern(({ element: { x, y }, params: { state } }) => (<div>
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
                    scale: state.scale
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
                    scale: state.scale
                }
            }, ({ y, state }) => y * state.scale)})
          </div>), {
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
                    scale: state.scale
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
