function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
/**
 * computed() result used as derive capture should use .key("count"),
 * not plain property access. The computed() return value is an
 * OpaqueRef, so rewritePatternBody correctly treats it as opaque.
 */
import { computed, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
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
    const stats = __cfHelpers.derive({
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
    } as const satisfies __cfHelpers.JSONSchema, {
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
    } as const satisfies __cfHelpers.JSONSchema, { state: {
            items: state.key("items")
        } }, ({ state }) => ({
        count: state.items.filter((i) => i.done).length,
        total: state.items.length,
    }));
    return {
        [UI]: (<div>
        {__cfHelpers.derive({
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
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { stats: {
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
} as const satisfies __cfHelpers.JSONSchema, {
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
                    $ref: "#/$defs/UIRenderable"
                }, {
                    type: "object",
                    properties: {}
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
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
