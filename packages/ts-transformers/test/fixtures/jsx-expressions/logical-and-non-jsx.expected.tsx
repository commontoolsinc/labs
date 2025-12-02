import * as __ctHelpers from "commontools";
import { cell, recipe, UI } from "commontools";
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
    return {
        [UI]: (<div>
        {/* Non-JSX right side: string template with complex expression */}
        <p>{__ctHelpers.when(__ctHelpers.derive({
            type: "object",
            properties: {
                user: {
                    type: "object",
                    properties: {
                        name: {
                            type: "object",
                            properties: {
                                length: true
                            },
                            required: ["length"]
                        }
                    },
                    required: ["name"]
                }
            },
            required: ["user"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, { user: {
                name: {
                    length: user.name.length
                }
            } }, ({ user }) => user.name.length > 0), `Hello, ${__ctHelpers.derive({
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
            } }, ({ user }) => user.name)}!`)}</p>

        {/* Non-JSX right side: number expression */}
        <p>Age: {__ctHelpers.when(__ctHelpers.derive({
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
            } }, ({ user }) => user.age > 18), user.age)}</p>
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
