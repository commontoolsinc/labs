import * as __ctHelpers from "commontools";
/**
 * computed() result used as derive capture should use .key("count"),
 * not plain property access. The computed() return value is an
 * OpaqueRef, so rewritePatternBody correctly treats it as opaque.
 */
import { computed, pattern, UI } from "commontools";
interface State {
    items: Array<{
        name: string;
        done: boolean;
    }>;
}
export default pattern((state) => {
    const stats = __ctHelpers.derive({
        type: "object",
        properties: {
            state: {
                type: "object",
                properties: {
                    items: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                name: {
                                    type: "string"
                                },
                                done: {
                                    type: "boolean"
                                }
                            },
                            required: ["name", "done"]
                        },
                        asOpaque: true
                    }
                },
                required: ["items"]
            }
        },
        required: ["state"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "object",
        properties: {
            count: {
                type: "number"
            },
            total: {
                type: "number"
            }
        },
        required: ["count", "total"]
    } as const satisfies __ctHelpers.JSONSchema, { state: {
            items: state.key("items")
        } }, ({ state }) => ({
        count: state.items.filter((i) => i.done).length,
        total: state.items.length,
    }));
    return {
        [UI]: (<div>
        {__ctHelpers.derive({
            type: "object",
            properties: {
                stats: {
                    type: "object",
                    properties: {
                        count: {
                            type: "number",
                            asOpaque: true
                        },
                        total: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["count", "total"]
                }
            },
            required: ["stats"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { stats: {
                count: stats.key("count"),
                total: stats.key("total")
            } }, ({ stats }) => `${stats.count} of ${stats.total} done`)}
      </div>),
    };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    name: {
                        type: "string"
                    },
                    done: {
                        type: "boolean"
                    }
                },
                required: ["name", "done"]
            }
        }
    },
    required: ["items"]
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
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
