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
const __ctModuleCallback_1 = __ctHardenFn(({ element: { x, y }, params: { state } }) => (<div>
            Point: ({__cfHelpers.derive({
    type: "object",
    properties: {
        x: {
            type: "number"
        },
        state: {
            type: "object",
            properties: {
                scale: {
                    type: "number"
                }
            },
            required: ["scale"]
        }
    },
    required: ["x", "state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, {
    x: x,
    state: {
        scale: state.scale
    }
}, ({ x, state }) => x * state.scale)}, {__cfHelpers.derive({
    type: "object",
    properties: {
        y: {
            type: "number"
        },
        state: {
            type: "object",
            properties: {
                scale: {
                    type: "number"
                }
            },
            required: ["scale"]
        }
    },
    required: ["y", "state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, {
    y: y,
    state: {
        scale: state.scale
    }
}, ({ y, state }) => y * state.scale)})
          </div>));
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
        {state.key("points").mapWithPattern(__cfHelpers.pattern(__ctModuleCallback_1, {
                type: "object",
                properties: {
                    element: {
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
                    },
                    params: {
                        type: "object",
                        properties: {
                            state: {
                                type: "object",
                                properties: {
                                    scale: {
                                        type: "number"
                                    }
                                },
                                required: ["scale"]
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
