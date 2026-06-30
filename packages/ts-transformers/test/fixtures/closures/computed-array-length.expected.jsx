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
 * - allPieces comes from wish<{ allPieces: MentionablePiece[] }>
 * - computed(() => allPieces.length) accesses .length on an array from wish
 *
 * The fix ensures the schema is { type: "array", items: { not: true } }
 * rather than { type: "object", properties: { length: { type: "number" } } }
 */
import { computed, NAME, pattern, UI, wish } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Piece {
    id: string;
    name: string;
}
const __cfLift_1 = __cfHelpers.lift<{
    allPieces: {
        length: number;
    };
}, string>(({ allPieces }) => `Pieces (${allPieces.length})`, {
    type: "object",
    properties: {
        allPieces: {
            type: "object",
            properties: {
                length: {
                    type: "number"
                }
            },
            required: ["length"]
        }
    },
    required: ["allPieces"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_2 = __cfHelpers.lift<{
    allPieces: {
        length: number;
    };
}, number>(({ allPieces }) => allPieces.length, {
    type: "object",
    properties: {
        allPieces: {
            type: "object",
            properties: {
                length: {
                    type: "number"
                }
            },
            required: ["length"]
        }
    },
    required: ["allPieces"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const piece = __cf_pattern_input.key("element");
    return (<li>{piece.key("name")}</li>);
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Piece"
        }
    },
    required: ["element"],
    $defs: {
        Piece: {
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
// Verifies: computed(() => expr) with .length access on a Reactive<T[]> is closure-extracted
//   computed(() => allPieces.length) → lift(({ allPieces }) => allPieces.length)({ allPieces: { length: allPieces.length } })
//   allPieces.map(fn) → allPieces.mapWithPattern(pattern(fn, ...schemas), {})
// Context: Regression test ensuring array .length produces the correct schema
//   shape rather than an object schema with a length property.
export default pattern(() => {
    const __cf_destructure_1 = wish<{
        allPieces: Piece[];
    }>({ query: "/" }, {
        type: "object",
        properties: {
            allPieces: {
                type: "array",
                items: {
                    $ref: "#/$defs/Piece"
                }
            }
        },
        required: ["allPieces"],
        $defs: {
            Piece: {
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
    } as const satisfies __cfHelpers.JSONSchema), allPieces = __cf_destructure_1.key("result", "allPieces").for("allPieces", true);
    return {
        [NAME]: __cfLift_1({ allPieces: {
                length: allPieces.key("length")
            } }),
        [UI]: (<div>
        <span>Count: {__cfLift_2({ allPieces: {
                length: allPieces.key("length")
            } })}</span>
        <ul>
          {allPieces.mapWithPattern(__cfPattern_1, {})}
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
__cfReg({
    __cfLift_1,
    __cfLift_2,
    __cfPattern_1
});
