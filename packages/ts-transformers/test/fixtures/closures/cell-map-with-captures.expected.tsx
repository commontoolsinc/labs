import * as __ctHelpers from "commontools";
import { Cell, cell, recipe, UI } from "commontools";
interface State {
    values: number[];
    multiplier: number;
}
export default recipe({
    type: "object",
    properties: {
        values: {
            type: "array",
            items: {
                type: "number"
            }
        },
        multiplier: {
            type: "number"
        }
    },
    required: ["values", "multiplier"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "#/$defs/Element"
        }
    },
    required: ["$UI"],
    $defs: {
        Element: {
            type: "object",
            properties: {
                type: {
                    type: "string",
                    enum: ["vnode"]
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
        VNode: {
            type: "object",
            properties: {
                type: {
                    type: "string",
                    enum: ["vnode"]
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
                    enum: [false]
                }, {
                    type: "boolean",
                    enum: [true]
                }, {
                    $ref: "#/$defs/VNode"
                }, {
                    type: "object",
                    properties: {}
                }, {
                    type: "array",
                    items: {
                        $ref: "#/$defs/RenderNode"
                    }
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
                        enum: [false]
                    }, {
                        type: "boolean",
                        enum: [true]
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
    // Explicitly type as Cell to ensure closure transformation
    const typedValues: Cell<number[]> = cell(state.values);
    return {
        [UI]: (<div>
        {typedValues.mapWithPattern(__ctHelpers.recipe({
                type: "object",
                properties: {
                    element: {
                        type: "number"
                    },
                    params: {
                        type: "object",
                        properties: {
                            state: {
                                type: "object",
                                properties: {
                                    multiplier: {
                                        type: "number",
                                        asOpaque: true
                                    }
                                },
                                required: ["multiplier"]
                            }
                        },
                        required: ["state"]
                    }
                },
                required: ["element", "params"]
            } as const satisfies __ctHelpers.JSONSchema, true as const satisfies __ctHelpers.JSONSchema, ({ element: value, params: { state } }) => (<span>{__ctHelpers.derive({
                type: "object",
                properties: {
                    value: {
                        type: "number",
                        asOpaque: true
                    },
                    state: {
                        type: "object",
                        properties: {
                            multiplier: {
                                type: "number",
                                asOpaque: true
                            }
                        },
                        required: ["multiplier"]
                    }
                },
                required: ["value", "state"]
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "number"
            } as const satisfies __ctHelpers.JSONSchema, {
                value: value,
                state: {
                    multiplier: state.multiplier
                }
            }, ({ value, state }) => value * state.multiplier)}</span>)), {
                state: {
                    multiplier: state.multiplier
                }
            })}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
