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
// FIXTURE: computed-result-in-derive-captures
// Verifies: computed() result properties captured in a subsequent derive use .key() access
//   computed(() => `${stats.count} of ${stats.total} done`) → derive(..., { stats: { count: stats.key("count"), total: stats.key("total") } }, ({ stats }) => ...)
// Context: The first computed() returns an OpaqueRef with { count, total }.
//   When the second computed() captures stats.count and stats.total, the
//   transform rewrites them to stats.key("count") and stats.key("total") in
//   the captures object because stats is an OpaqueRef.
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
                        }
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
                            type: "number"
                        },
                        total: {
                            type: "number"
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
                    $ref: "#/$defs/UIRenderable"
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
