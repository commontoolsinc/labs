import * as __ctHelpers from "commontools";
import { cell, pattern, UI } from "commontools";
export default pattern(false as const satisfies __ctHelpers.JSONSchema, {
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
} as const satisfies __ctHelpers.JSONSchema, (_state) => {
    const user = cell<{
        name: string;
        age: number;
    }>({ name: "", age: 0 }, {
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
    } as const satisfies __ctHelpers.JSONSchema);
    return {
        [UI]: (<div>
        {/* Non-JSX right side: string template with complex expression */}
        <p>{__ctHelpers.when({
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{
                    type: "string"
                }, {
                    type: "boolean"
                }]
        } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
            type: "object",
            properties: {
                user: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string"
                        },
                        age: {
                            type: "number"
                        }
                    },
                    required: ["name", "age"],
                    asCell: true
                }
            },
            required: ["user"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, { user: user }, ({ user }) => user.get().name.length > 0), `Hello, ${__ctHelpers.derive({
            type: "object",
            properties: {
                user: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string"
                        },
                        age: {
                            type: "number"
                        }
                    },
                    required: ["name", "age"],
                    asCell: true
                }
            },
            required: ["user"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { user: user }, ({ user }) => user.get().name)}!`)}</p>

        {/* Non-JSX right side: number expression */}
        <p>Age: {__ctHelpers.when({
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{
                    type: "number"
                }, {
                    type: "boolean"
                }]
        } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
            type: "object",
            properties: {
                user: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string"
                        },
                        age: {
                            type: "number"
                        }
                    },
                    required: ["name", "age"],
                    asCell: true
                }
            },
            required: ["user"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, { user: user }, ({ user }) => user.get().age > 18), __ctHelpers.derive({
            type: "object",
            properties: {
                user: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string"
                        },
                        age: {
                            type: "number"
                        }
                    },
                    required: ["name", "age"],
                    asCell: true
                }
            },
            required: ["user"]
        } as const satisfies __ctHelpers.JSONSchema, {
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
        } as const satisfies __ctHelpers.JSONSchema, { user: user }, ({ user }) => user.get()).age)}</p>
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
