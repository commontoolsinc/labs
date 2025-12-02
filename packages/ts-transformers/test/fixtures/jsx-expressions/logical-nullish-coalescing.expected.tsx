import * as __ctHelpers from "commontools";
import { cell, recipe, UI } from "commontools";
// Tests nullish coalescing (??) interaction with && and ||
// ?? should NOT be transformed to when/unless (different semantics)
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
        <span>Timeout: {__ctHelpers.unless(__ctHelpers.derive({
            type: "object",
            properties: {
                config: {
                    type: "object",
                    properties: {
                        timeout: true
                    },
                    required: ["timeout"]
                }
            },
            required: ["config"]
        } as const satisfies __ctHelpers.JSONSchema, true as const satisfies __ctHelpers.JSONSchema, { config: {
                timeout: config.timeout
            } }, ({ config }) => (config.timeout ?? 30)), "disabled")}</span>

        {/* ?? followed by && */}
        <span>{__ctHelpers.when(__ctHelpers.derive({
            type: "object",
            properties: {
                config: {
                    type: "object",
                    properties: {
                        retries: true
                    },
                    required: ["retries"]
                }
            },
            required: ["config"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, { config: {
                retries: config.retries
            } }, ({ config }) => (config.retries ?? 3) > 0), "Will retry")}</span>

        {/* Mixed: ?? with && and || */}
        <span>
          {__ctHelpers.unless(__ctHelpers.derive({
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
        } as const satisfies __ctHelpers.JSONSchema, true as const satisfies __ctHelpers.JSONSchema, { items: items }, ({ items }) => items.length > 0 && (items[0] ?? "empty")), "no items")}
        </span>
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
