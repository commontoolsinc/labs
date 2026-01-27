import * as __ctHelpers from "commontools";
import { Cell, handler, NAME, recipe, str, UI } from "commontools";
interface RecipeState {
    value: number;
}
const increment = handler(false as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        value: {
            type: "number",
            asCell: true
        }
    },
    required: ["value"]
} as const satisfies __ctHelpers.JSONSchema, (_e, state: {
    value: Cell<number>;
}) => {
    state.value.set(state.value.get() + 1);
});
const decrement = handler(false as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        value: {
            type: "number",
            asCell: true
        }
    },
    required: ["value"]
} as const satisfies __ctHelpers.JSONSchema, (_e, state: {
    value: Cell<number>;
}) => {
    state.value.set(state.value.get() - 1);
});
export default recipe({
    type: "object",
    properties: {
        value: {
            type: "number"
        }
    },
    required: ["value"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        $NAME: {
            type: "string",
            asOpaque: true
        },
        $UI: {
            $ref: "#/$defs/JSXElement"
        },
        value: {
            type: "number",
            asOpaque: true
        },
        metadata: {
            type: "object",
            properties: {
                next: {
                    type: "number"
                },
                previous: {
                    type: "number"
                },
                doubled: {
                    type: "number"
                }
            },
            required: ["next", "previous", "doubled"]
        }
    },
    required: ["$NAME", "$UI", "value", "metadata"],
    $defs: {
        JSXElement: {
            anyOf: [{
                    $ref: "#/$defs/VNode"
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
                    $ref: "#/$defs/VNode"
                }
            },
            required: ["$UI"]
        },
        VNode: {
            type: "object",
            properties: {
                type: {
                    type: "string",
                    "enum": ["vnode"]
                },
                name: {
                    type: "string"
                },
                props: {
                    $ref: "#/$defs/Props"
                },
                children: {
                    $ref: "#/$defs/RenderNode"
                },
                $UI: {
                    $ref: "#/$defs/VNode"
                }
            },
            required: ["type", "name", "props"]
        },
        RenderNode: {
            anyOf: [{
                    type: "string"
                }, {
                    type: "number"
                }, {
                    type: "boolean",
                    "enum": [false]
                }, {
                    type: "boolean",
                    "enum": [true]
                }, {
                    $ref: "#/$defs/VNode"
                }, {
                    type: "object",
                    properties: {}
                }, {
                    $ref: "#/$defs/UIRenderable",
                    asOpaque: true
                }, {
                    type: "object",
                    properties: {}
                }, {
                    type: "array",
                    items: {
                        $ref: "#/$defs/RenderNode"
                    }
                }, {
                    type: "null"
                }]
        },
        Props: {
            type: "object",
            properties: {},
            additionalProperties: {
                anyOf: [{
                        type: "string"
                    }, {
                        type: "number"
                    }, {
                        type: "boolean",
                        "enum": [false]
                    }, {
                        type: "boolean",
                        "enum": [true]
                    }, {
                        type: "object",
                        additionalProperties: true
                    }, {
                        type: "array",
                        items: true
                    }, {
                        asCell: true
                    }, {
                        asStream: true
                    }, {
                        type: "null"
                    }]
            }
        }
    }
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    // These should NOT be transformed (statement context)
    const next = state.value + 1;
    const previous = state.value - 1;
    const doubled = state.value * 2;
    const _isHigh = state.value > 10;
    // This should NOT be transformed (statement context)
    if (state.value > 100) {
        console.log("Too high!");
    }
    return {
        // This template literal SHOULD be transformed (builder function context)
        [NAME]: str `Simple counter: ${state.value}`,
        [UI]: (<div>
        <ct-button onClick={decrement(state)}>-</ct-button>
        <p>
          {/* These SHOULD be transformed (JSX expression context) */}
          Current: {state.value}
          <br />
          Next number: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        value: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["value"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                value: state.value
            } }, ({ state }) => state.value + 1)}
          <br />
          Previous: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        value: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["value"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                value: state.value
            } }, ({ state }) => state.value - 1)}
          <br />
          Doubled: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        value: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["value"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                value: state.value
            } }, ({ state }) => state.value * 2)}
          <br />
          Status: {__ctHelpers.ifElse({
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            "enum": ["High", "Low"]
        } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        value: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["value"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                value: state.value
            } }, ({ state }) => state.value > 10), "High", "Low")}
        </p>
        <ct-button onClick={increment({ value: state.value })}>+</ct-button>
      </div>),
        // Direct property access - no transformation needed
        value: state.value,
        // These should NOT be transformed (object literal in statement context)
        metadata: {
            next: next,
            previous: previous,
            doubled: doubled,
        },
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
