import * as __ctHelpers from "commontools";
import { derive, recipe } from "commontools";
interface Preference {
    ingredient: string;
    preference: "liked" | "disliked";
}
export default recipe({
    type: "object",
    properties: {
        preferences: {
            type: "array",
            items: {
                $ref: "#/$defs/Preference"
            }
        },
        foodDescription: {
            type: "string"
        }
    },
    required: ["preferences", "foodDescription"],
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
        wishQuery: {
            type: "string",
            asOpaque: true
        }
    },
    required: ["wishQuery"]
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    // Using object input form for derive - exactly like the issue describes
    // This matches: derive({ foodDescription, preferences }, ({ foodDescription: food, preferences: prefs }) => ...)
    const wishQuery = __lift_0({ food: state.foodDescription, prefs: state.preferences });
    return { wishQuery };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
const __lift_0 = __ctHelpers.lift({
    type: "object",
    properties: {
        food: {
            type: "string",
            asOpaque: true
        },
        prefs: {
            type: "array",
            items: {
                $ref: "#/$defs/Preference"
            },
            asOpaque: true
        }
    },
    required: ["food", "prefs"],
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
    type: "string"
} as const satisfies __ctHelpers.JSONSchema, ({ food, prefs }) => {
    // Filter-map chain inside derive callback
    // The .map() should NOT be transformed to .mapWithPattern() because:
    // - Inside derive, `prefs` is unwrapped to a plain array
    // - .filter() returns a plain JS array
    // - Plain arrays don't have .mapWithPattern()
    const liked = prefs
        .filter((p) => p.preference === "liked")
        .map((p) => p.ingredient)
        .join(", ");
    return `Recipe for ${food} with: ${liked}`;
});
