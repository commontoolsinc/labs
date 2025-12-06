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
                $ref: "#/$defs/OpaqueCell"
            }
        },
        required: ["result"],
        $defs: {
            OpaqueCell: {
                asOpaque: true
            }
        }
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "object",
        properties: {
            result: {
                $ref: "#/$defs/OpaqueCell"
            }
        },
        required: ["result"],
        asOpaque: true,
        $defs: {
            OpaqueCell: {
                asOpaque: true
            }
        }
    } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
        type: "object",
        properties: {
            pending: {
                anyOf: [{
                        type: "boolean",
                        "enum": [false],
                        asOpaque: true
                    }, {
                        type: "boolean",
                        "enum": [true],
                        asOpaque: true
                    }]
            },
            result: {
                $ref: "#/$defs/OpaqueCell"
            }
        },
        required: ["pending", "result"],
        $defs: {
            OpaqueCell: {
                asOpaque: true
            }
        }
    } as const satisfies __ctHelpers.JSONSchema, {
        anyOf: [{
                type: "boolean",
                "enum": [false]
            }, {
                type: "boolean",
                "enum": [true],
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
                $ref: "#/$defs/OpaqueCell"
            }
        },
        required: ["data"],
        $defs: {
            OpaqueCell: {
                asOpaque: true
            }
        }
    } as const satisfies __ctHelpers.JSONSchema, true as const satisfies __ctHelpers.JSONSchema, {
        type: "object",
        properties: {
            data: {
                $ref: "#/$defs/OpaqueCell"
            }
        },
        required: ["data"],
        asOpaque: true,
        $defs: {
            OpaqueCell: {
                asOpaque: true
            }
        }
    } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
        type: "object",
        properties: {
            result: {
                $ref: "#/$defs/OpaqueCell"
            }
        },
        required: ["result"],
        $defs: {
            OpaqueCell: {
                asOpaque: true
            }
        }
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
