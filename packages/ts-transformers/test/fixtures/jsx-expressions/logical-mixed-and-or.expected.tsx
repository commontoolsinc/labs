import * as __ctHelpers from "commontools";
import { cell, recipe, UI } from "commontools";
// Tests mixed && and || operators: (a && b) || c
// The && should use when, the || should use unless
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
        name: string;
        age: number;
    } | null>(null, {
        anyOf: [{
                type: "object",
                properties: {
                    name: {
                        type: "string"
                    },
                    age: {
                        type: "number"
                    }
                },
                required: ["name", "age"]
            }, {
                type: "null"
            }]
    } as const satisfies __ctHelpers.JSONSchema);
    const defaultMessage = cell("Guest", {
        type: "string"
    } as const satisfies __ctHelpers.JSONSchema);
    return {
        [UI]: (<div>
        {/* (condition && value) || fallback pattern */}
        <span>{__ctHelpers.unless(__ctHelpers.derive({
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
            } }, ({ user }) => (user.name.length > 0 && user.name)), defaultMessage)}</span>

        {/* condition && (value || fallback) pattern */}
        <span>{__ctHelpers.when(__ctHelpers.derive({
            type: "object",
            properties: {
                user: {
                    type: "object",
                    properties: {
                        age: true
                    },
                    required: ["age"]
                }
            },
            required: ["user"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, { user: {
                age: user.age
            } }, ({ user }) => user.age > 18), __ctHelpers.unless(__ctHelpers.derive({
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
            } }, ({ user }) => user.name), "Anonymous Adult"))}</span>

        {/* Complex: (a && b) || (c && d) */}
        <span>
          {__ctHelpers.unless(__ctHelpers.derive({
            type: "object",
            properties: {
                user: {
                    type: "object",
                    properties: {
                        name: true,
                        age: true
                    },
                    required: ["name", "age"]
                }
            },
            required: ["user"]
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{
                    type: "string"
                }, {
                    type: "boolean",
                    "enum": [false]
                }]
        } as const satisfies __ctHelpers.JSONSchema, { user: {
                name: user.name,
                age: user.age
            } }, ({ user }) => (user.name.length > 0 && `Hello ${user.name}`) ||
            (user.age > 0 && `Age: ${user.age}`)), "Unknown user")}
        </span>
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
