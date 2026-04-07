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
 * Regression test for array.length access inside computed().
 *
 * This mimics the pattern from default-app.tsx where:
 * - allCharms comes from wish<{ allCharms: MentionableCharm[] }>
 * - computed(() => allCharms.length) accesses .length on an array from wish
 *
 * The fix ensures the schema is { type: "array", items: { not: true } }
 * rather than { type: "object", properties: { length: { type: "number" } } }
 */
import { computed, NAME, pattern, UI, wish } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
interface Charm {
    id: string;
    name: string;
}
// FIXTURE: computed-array-length
// Verifies: computed(() => expr) with .length access on an OpaqueRef<T[]> is closure-extracted
//   computed(() => allCharms.length) → derive(captureSchema, resultSchema, { allCharms: { length: allCharms.length } }, ({ allCharms }) => allCharms.length)
//   allCharms.map(fn) → allCharms.mapWithPattern(pattern(fn, ...schemas), {})
// Context: Regression test ensuring array .length produces the correct schema
//   shape rather than an object schema with a length property.
export default pattern(() => {
    const { allCharms } = wish<{
        allCharms: Charm[];
    }>({ query: "/" }, {
        type: "object",
        properties: {
            allCharms: {
                type: "array",
                items: {
                    $ref: "#/$defs/Charm"
                }
            }
        },
        required: ["allCharms"],
        $defs: {
            Charm: {
                type: "object",
                properties: {
                    id: {
                        type: "string"
                    },
                    name: {
                        type: "string"
                    }
                },
                required: ["id", "name"]
            }
        }
    } as const satisfies __cfHelpers.JSONSchema).result!;
    return {
        [NAME]: __cfHelpers.derive({
            type: "object",
            properties: {
                allCharms: {
                    type: "object",
                    properties: {
                        length: {
                            type: "number"
                        }
                    },
                    required: ["length"]
                }
            },
            required: ["allCharms"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { allCharms: {
                length: allCharms.length
            } }, ({ allCharms }) => `Charms (${allCharms.length})`),
        [UI]: (<div>
        <span>Count: {__cfHelpers.derive({
            type: "object",
            properties: {
                allCharms: {
                    type: "object",
                    properties: {
                        length: {
                            type: "number"
                        }
                    },
                    required: ["length"]
                }
            },
            required: ["allCharms"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { allCharms: {
                length: allCharms.length
            } }, ({ allCharms }) => allCharms.length)}</span>
        <ul>
          {allCharms.mapWithPattern(__cfHelpers.pattern(__cf_pattern_input => {
                const charm = __cf_pattern_input.key("element");
                return (<li>{charm.key("name")}</li>);
            }, {
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Charm"
                    }
                },
                required: ["element"],
                $defs: {
                    Charm: {
                        type: "object",
                        properties: {
                            id: {
                                type: "string"
                            },
                            name: {
                                type: "string"
                            }
                        },
                        required: ["id", "name"]
                    }
                }
            } as const satisfies __cfHelpers.JSONSchema, {
                anyOf: [{
                        $ref: "https://commonfabric.org/schemas/vnode.json"
                    }, {
                        $ref: "#/$defs/UIRenderable"
                    }, {
                        type: "object",
                        properties: {}
                    }],
                $defs: {
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
            } as const satisfies __cfHelpers.JSONSchema), {})}
        </ul>
      </div>),
    };
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $NAME: {
            type: "string"
        },
        $UI: {
            $ref: "#/$defs/JSXElement"
        }
    },
    required: ["$NAME", "$UI"],
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
