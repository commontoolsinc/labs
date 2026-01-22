import * as __ctHelpers from "commontools";
import { computed, fetchData, ifElse, recipe, UI } from "commontools";
// Tests ifElse where ifTrue is explicitly undefined
// This pattern is common: ifElse(pending, undefined, { result })
// The transformer must handle this correctly - the undefined is a VALUE, not a missing argument
export default recipe({
    type: "object",
    properties: {},
    additionalProperties: false
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
                    $ref: "#/$defs/VNode"
                }, {
                    $ref: "#/$defs/VNodeResult"
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
        VNodeResult: {
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
                    $ref: "#/$defs/PropsResult"
                },
                children: {
                    type: "array",
                    items: {
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
                                $ref: "#/$defs/VNodeResult"
                            }, {
                                type: "null"
                            }]
                    }
                },
                $UI: {
                    $ref: "#/$defs/VNodeResult"
                }
            },
            required: ["type", "name", "props"]
        },
        PropsResult: {
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
                        asStream: true
                    }, {
                        type: "null"
                    }]
            }
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
                    $ref: "#/$defs/VNodeResult"
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
} as const satisfies __ctHelpers.JSONSchema, () => {
    const { pending, result } = fetchData({
        url: "/api/data",
        mode: "text",
    });
    // Pattern 1: undefined as ifTrue (waiting state returns nothing)
    const output1 = ifElse({
        type: "boolean"
    } as const satisfies __ctHelpers.JSONSchema, true as const satisfies __ctHelpers.JSONSchema, {
        type: "object",
        properties: {
            result: {
                asOpaque: true
            }
        },
        required: ["result"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "object",
        properties: {
            result: {
                asOpaque: true
            }
        },
        required: ["result"],
        asOpaque: true
    } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
        type: "object",
        properties: {
            pending: {
                type: "boolean",
                asOpaque: true
            },
            result: {
                asOpaque: true
            }
        },
        required: ["pending", "result"]
    } as const satisfies __ctHelpers.JSONSchema, {
        anyOf: [{
                type: "boolean",
                "enum": [false]
            }, {
                type: "boolean",
                asOpaque: true
            }]
    } as const satisfies __ctHelpers.JSONSchema, {
        pending: pending,
        result: result
    }, ({ pending, result }) => pending || !result), undefined, { result });
    // Pattern 2: undefined as ifFalse (error state returns nothing)
    const output2 = ifElse({
        type: "boolean"
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "object",
        properties: {
            data: {
                asOpaque: true
            }
        },
        required: ["data"]
    } as const satisfies __ctHelpers.JSONSchema, true as const satisfies __ctHelpers.JSONSchema, {
        type: "object",
        properties: {
            data: {
                asOpaque: true
            }
        },
        required: ["data"],
        asOpaque: true
    } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
        type: "object",
        properties: {
            result: {
                asOpaque: true
            }
        },
        required: ["result"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "boolean"
    } as const satisfies __ctHelpers.JSONSchema, { result: result }, ({ result }) => !!result), { data: result }, undefined);
    return {
        [UI]: (<div>
        <span>{output1}</span>
        <span>{output2}</span>
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
