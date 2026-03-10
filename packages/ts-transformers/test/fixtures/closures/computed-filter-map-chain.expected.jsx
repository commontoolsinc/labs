import * as __ctHelpers from "commontools";
import { computed, pattern } from "commontools";
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
    const liked = __ctHelpers.derive({
        type: "object",
        properties: {
            state: {
                type: "object",
                properties: {
                    preferences: {
                        type: "array",
                        items: {
                            $ref: "#/$defs/Preference"
                        },
                        asOpaque: true
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
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "array",
        items: {
            type: "string",
            asOpaque: true
        }
    } as const satisfies __ctHelpers.JSONSchema, { state: {
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
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        liked: {
            type: "array",
            items: {
                type: "string",
                asOpaque: true
            },
            asOpaque: true
        }
    },
    required: ["liked"]
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
