function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
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
const __cfAmdHooks = undefined;
interface Charm {
    id: string;
    name: string;
}
const __cfLift_1 = __cfHelpers.lift<{
    allCharms: {
        length: number;
    };
}, string>({
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
} as const satisfies __cfHelpers.JSONSchema, ({ allCharms }) => `Charms (${allCharms.length})`);
const __cfLift_2 = __cfHelpers.lift<{
    allCharms: {
        length: number;
    };
}, number>({
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
} as const satisfies __cfHelpers.JSONSchema, ({ allCharms }) => allCharms.length);
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
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
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: computed-array-length
// Verifies: computed(() => expr) with .length access on an OpaqueRef<T[]> is closure-extracted
//   computed(() => allCharms.length) → lift(({ allCharms }) => allCharms.length)({ allCharms: { length: allCharms.length } })
//   allCharms.map(fn) → allCharms.mapWithPattern(pattern(fn, ...schemas), {})
// Context: Regression test ensuring array .length produces the correct schema
//   shape rather than an object schema with a length property.
export default pattern(() => {
    const __cf_destructure_1 = wish<{
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
    } as const satisfies __cfHelpers.JSONSchema), allCharms = __cf_destructure_1.key("result", "allCharms").for("allCharms", true);
    return {
        [NAME]: __cfLift_1({ allCharms: {
                length: allCharms.key("length")
            } }),
        [UI]: (<div>
        <span>Count: {__cfLift_2({ allCharms: {
                length: allCharms.key("length")
            } })}</span>
        <ul>
          {allCharms.mapWithPattern(__cfPattern_1, {})}
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
