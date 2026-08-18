function __cfBindVerifiedBinding(value: any, metadata: any) {
    if (value && (typeof value === "object" || typeof value === "function") && Object.isExtensible(value)) {
        Object.defineProperty(value, "__cfVerifiedBindingIdentity", {
            value: metadata,
            configurable: true
        });
    }
    if (value && (typeof value === "object" || typeof value === "function") && typeof value.implementation === "function") {
        var implementation = value.implementation;
        if (implementation && (typeof implementation === "object" || typeof implementation === "function") && Object.isExtensible(implementation)) {
            Object.defineProperty(implementation, "__cfVerifiedBindingIdentity", {
                value: metadata,
                configurable: true
            });
        }
    }
    return value;
}
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
const __cfLift_1 = __cfHelpers.lift<{
    state: {
        preferences: {
            ingredient: string;
            preference: "liked" | "disliked";
        }[];
    };
}, string[]>(({ state }) => {
    return state.preferences
        .filter((p) => p.preference === "liked")
        .map((p) => p.ingredient);
}, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                preferences: {
                    type: "array",
                    items: {
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
            },
            required: ["preferences"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "string"
    }
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
__cfBindVerifiedBinding(__cfLift_1, {
    sourceFile: "/test.tsx",
    position: { line: 15, col: 25 },
    bindingName: "liked"
});
// FIXTURE: computed-filter-map-chain
// Verifies: .filter() and .map() inside computed() are NOT transformed
// Context: Inside computed(), Reactive auto-unwraps to plain array, so
//   .filter() and .map() are standard Array methods — they must remain
//   untransformed. This is a negative test for the reactive method detection.
export default __cfBindVerifiedBinding(pattern((state) => {
    const liked = __cfLift_1({ state: {
            preferences: state.key("preferences")
        } }).for("liked", true);
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
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 14, col: 54 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1
});
