import * as __ctHelpers from "commontools";
import { derive, pattern } from "commontools";
interface Preference {
    ingredient: string;
    preference: "liked" | "disliked";
}
// FIXTURE: derive-filter-map-chain
// Verifies: .filter() and .map() inside a derive callback are NOT transformed to reactive versions
//   .filter(fn) stays as .filter(fn) (not .filterWithPattern)
//   .map(fn) stays as .map(fn) (not .mapWithPattern)
// Context: inside derive, `prefs` is unwrapped to a plain array; plain array methods should not be rewritten
export default pattern((state) => {
    // Using object input form for derive - exactly like the issue describes
    // This matches: derive({ foodDescription, preferences }, ({ foodDescription: food, preferences: prefs }) => ...)
    const wishQuery = derive({
        type: "object",
        properties: {
            prefs: {
                type: "array",
                items: true
            },
            food: {
                type: "string"
            }
        },
        required: ["prefs", "food"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __ctHelpers.JSONSchema, { food: state.key("foodDescription"), prefs: state.key("preferences") }, ({ food, prefs }) => {
        // Filter-map chain inside derive callback
        // The .map() should NOT be transformed to .mapWithPattern() because:
        // - Inside derive, `prefs` is unwrapped to a plain array
        // - .filter() returns a plain JS array
        // - Plain arrays don't have .mapWithPattern()
        const liked = prefs
            .filter((p) => p.preference === "liked")
            .map((p) => p.ingredient)
            .join(", ");
        return `Pattern for ${food} with: ${liked}`;
    });
    return { wishQuery };
}, {
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
            type: "string"
        }
    },
    required: ["wishQuery"]
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
