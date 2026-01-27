import * as __ctHelpers from "commontools";
import { cell, recipe, UI } from "commontools";
// Tests nullish coalescing (??) interaction with && and ||
// ?? should NOT be transformed to when/unless (different semantics)
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
} as const satisfies __ctHelpers.JSONSchema, (_state) => {
    const config = cell<{
        timeout: number | null;
        retries: number | undefined;
    }>({
        timeout: null,
        retries: undefined,
    }, {
        type: "object",
        properties: {
            timeout: {
                anyOf: [{
                        type: "number"
                    }, {
                        type: "null"
                    }]
            },
            retries: {
                type: "number"
            }
        },
        required: ["timeout"]
    } as const satisfies __ctHelpers.JSONSchema);
    const items = cell<string[]>([], {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __ctHelpers.JSONSchema);
    return {
        [UI]: (<div>
        {/* ?? followed by || - different semantics */}
        <span>Timeout: {__ctHelpers.derive({
            type: "object",
            properties: {
                config: {
                    type: "object",
                    properties: {
                        timeout: {
                            anyOf: [{
                                    type: "number"
                                }, {
                                    type: "null"
                                }]
                        },
                        retries: {
                            type: "number"
                        }
                    },
                    required: ["timeout"],
                    asCell: true
                }
            },
            required: ["config"]
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{
                    type: "number"
                }, {
                    type: "string",
                    "enum": ["disabled"]
                }]
        } as const satisfies __ctHelpers.JSONSchema, { config: config }, ({ config }) => (config.get().timeout ?? 30) || "disabled")}</span>

        {/* ?? followed by && */}
        <span>{__ctHelpers.derive({
            type: "object",
            properties: {
                config: {
                    type: "object",
                    properties: {
                        timeout: {
                            anyOf: [{
                                    type: "number"
                                }, {
                                    type: "null"
                                }]
                        },
                        retries: {
                            type: "number"
                        }
                    },
                    required: ["timeout"],
                    asCell: true
                }
            },
            required: ["config"]
        } as const satisfies __ctHelpers.JSONSchema, {
            "enum": [false, "Will retry"]
        } as const satisfies __ctHelpers.JSONSchema, { config: config }, ({ config }) => (config.get().retries ?? 3) > 0 && "Will retry")}</span>

        {/* Mixed: ?? with && and || */}
        <span>
          {__ctHelpers.derive({
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        type: "string"
                    },
                    asCell: true
                }
            },
            required: ["items"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { items: items }, ({ items }) => items.get().length > 0 && (items.get()[0] ?? "empty") || "no items")}
        </span>
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
