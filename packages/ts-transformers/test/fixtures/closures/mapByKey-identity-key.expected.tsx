import * as __ctHelpers from "commontools";
import { mapByKey, recipe, UI } from "commontools";
interface State {
    numbers: number[];
    multiplier: number;
}
export default recipe({
    type: "object",
    properties: {
        numbers: {
            type: "array",
            items: {
                type: "number"
            }
        },
        multiplier: {
            type: "number"
        }
    },
    required: ["numbers", "multiplier"]
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
    // Identity key (no keyPath) with capture
    const multiplied = __ctHelpers.mapByKey(state.numbers, __ctHelpers.recipe({
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
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, ({ element: n, params: { state } }) => n * state.multiplier), {
        state: {
            multiplier: state.multiplier
        }
    });
    return {
        [UI]: <div>Result: {__ctHelpers.derive({
            type: "object",
            properties: {
                multiplied: {
                    type: "array",
                    items: {
                        type: "number"
                    },
                    asOpaque: true
                }
            },
            required: ["multiplied"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { multiplied: multiplied }, ({ multiplied }) => JSON.stringify(multiplied))}</div>,
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
