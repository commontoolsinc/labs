import * as __ctHelpers from "commontools";
import { cell, recipe, UI } from "commontools";
// Tests triple && chain: a && b && c
// Should produce nested when calls or derive the entire chain
export default recipe(false as const satisfies __ctHelpers.JSONSchema, {
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
} as const satisfies __ctHelpers.JSONSchema, (_state) => {
    const user = cell<{
        active: boolean;
        verified: boolean;
        name: string;
    } | null>(null, {
        anyOf: [{
                type: "object",
                properties: {
                    active: {
                        type: "boolean"
                    },
                    verified: {
                        type: "boolean"
                    },
                    name: {
                        type: "string"
                    }
                },
                required: ["active", "verified", "name"]
            }, {
                type: "null"
            }]
    } as const satisfies __ctHelpers.JSONSchema);
    return {
        [UI]: (<div>
        {/* Triple && chain with complex conditions */}
        {__ctHelpers.when(__ctHelpers.derive({
            type: "object",
            properties: {
                user: {
                    type: "object",
                    properties: {
                        active: true,
                        verified: true
                    },
                    required: ["active", "verified"]
                }
            },
            required: ["user"]
        } as const satisfies __ctHelpers.JSONSchema, true as const satisfies __ctHelpers.JSONSchema, { user: {
                active: user.active,
                verified: user.verified
            } }, ({ user }) => user.active && user.verified), <span>Welcome, {__ctHelpers.derive({
            type: "object",
            properties: {
                user: {
                    type: "object",
                    properties: {
                        name: true
                    },
                    required: ["name"]
                }
            },
            required: ["user"]
        } as const satisfies __ctHelpers.JSONSchema, true as const satisfies __ctHelpers.JSONSchema, { user: {
                name: user.name
            } }, ({ user }) => user.name)}!</span>)}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
