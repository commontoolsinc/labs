import * as __ctHelpers from "commontools";
import { cell, recipe, UI } from "commontools";
// Tests triple && chain: a && b && c
// Should produce nested when calls or derive the entire chain
export default recipe(false as const satisfies __ctHelpers.JSONSchema, {
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
        active: boolean;
        verified: boolean;
        name: string;
    }>({ active: false, verified: false, name: "" }, {
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
    } as const satisfies __ctHelpers.JSONSchema);
    return {
        [UI]: (<div>
        {/* Triple && chain with complex conditions */}
        {__ctHelpers.when({
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{
                    type: "boolean"
                }, {}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
            type: "object",
            properties: {
                user: {
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
                    required: ["active", "verified", "name"],
                    asCell: true
                }
            },
            required: ["user"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, { user: user }, ({ user }) => user.get().active && user.get().verified), <span>Welcome, {__ctHelpers.derive({
            type: "object",
            properties: {
                user: {
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
                    required: ["active", "verified", "name"],
                    asCell: true
                }
            },
            required: ["user"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { user: user }, ({ user }) => user.get().name)}!</span>)}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
