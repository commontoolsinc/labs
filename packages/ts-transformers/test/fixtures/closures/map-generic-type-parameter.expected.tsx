import * as __ctHelpers from "commontools";
import { recipe, OpaqueRef } from "commontools";
interface Email {
    id: string;
    content: string;
}
interface State {
    emails: OpaqueRef<Email[]>;
    prompt: string;
}
/**
 * Test that generic type parameters (like T) are NOT captured as closed-over
 * variables. Type parameters are compile-time only and don't exist at runtime.
 *
 * The bug was: when a generic function used T inside a .map() callback,
 * the closure transformer would try to capture T as: { T: T, prompt: prompt }
 * This caused "ReferenceError: T is not defined" at runtime.
 */
function processWithType<T>(emails: OpaqueRef<Email[]>, prompt: string) {
    // T is used here but should NOT be captured - it's a type, not a value
    return emails.mapWithPattern(__ctHelpers.recipe({
        type: "object",
        properties: {
            element: {
                $ref: "#/$defs/Email"
            },
            params: {
                type: "object",
                properties: {}
            }
        },
        required: ["element", "params"],
        $defs: {
            Email: {
                type: "object",
                properties: {
                    id: {
                        type: "string"
                    },
                    content: {
                        type: "string"
                    }
                },
                required: ["id", "content"]
            }
        }
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "object",
        properties: {
            id: {
                type: "string"
            },
            type: {}
        },
        required: ["id", "type"]
    } as const satisfies __ctHelpers.JSONSchema, ({ element: email, params: {} }) => {
        // The type annotation <T> should not cause T to be captured
        const result = { id: email.id, type: "processed" as T };
        return result;
    }), {});
}
export default recipe({
    type: "object",
    properties: {
        emails: {
            type: "array",
            items: {
                $ref: "#/$defs/Email"
            },
            asOpaque: true
        },
        prompt: {
            type: "string"
        }
    },
    required: ["emails", "prompt"],
    $defs: {
        Email: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                content: {
                    type: "string"
                }
            },
            required: ["id", "content"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        results: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    id: {
                        type: "string"
                    },
                    type: {
                        type: "string"
                    }
                },
                required: ["id", "type"]
            },
            asOpaque: true
        }
    },
    required: ["results"]
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    const results = processWithType<string>(state.emails, state.prompt);
    return { results };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
