function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { computed, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Preference {
    ingredient: string;
    preference: "liked" | "disliked";
}
// FIXTURE: computed-filter-map-chain
// Verifies: .filter() and .map() inside computed() are NOT transformed
// Context: Inside computed(), OpaqueRef auto-unwraps to plain array, so
//   .filter() and .map() are standard Array methods — they must remain
//   untransformed. This is a negative test for the reactive method detection.
export default pattern((state) => {
    const liked = __cfHelpers.derive({
        type: "object",
        properties: {
            state: {
                type: "object",
                properties: {
                    preferences: {
                        type: "array",
                        items: {
                            $ref: "#/$defs/Preference"
                        }
                    }
                },
                required: ["preferences"]
            }
        },
        required: ["state"],
        $defs: {
            Preference: {
                type: "object",
                properties: {
                    ingredient: {
                        type: "string"
                    },
                    preference: {
                        "enum": ["liked", "disliked"]
                    }
                },
                required: ["ingredient", "preference"]
            }
        }
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __cfHelpers.JSONSchema, { state: {
            preferences: state.key("preferences")
        } }, ({ state }) => {
        return state.preferences
            .filter((p) => p.preference === "liked")
            .map((p) => p.ingredient);
    });
    return { liked };
}, {
    type: "object",
    properties: {
        preferences: {
            type: "array",
            items: {
                $ref: "#/$defs/Preference"
            }
        }
    },
    required: ["preferences"],
    $defs: {
        Preference: {
            type: "object",
            properties: {
                ingredient: {
                    type: "string"
                },
                preference: {
                    "enum": ["liked", "disliked"]
                }
            },
            required: ["ingredient", "preference"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        liked: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["liked"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
