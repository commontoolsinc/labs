import * as __ctHelpers from "commontools";
/**
 * computed() result property access in derive captures should use
 * .key("length"). The computed() return is an OpaqueRef, so
 * rewritePatternBody correctly rewrites summary.length to
 * summary.key("length").
 */
import { computed, pattern } from "commontools";
interface State {
    items: string[];
}
// FIXTURE: computed-result-property-in-return
// Verifies: .length on a computed() string result is captured via .key("length") in a subsequent derive
//   computed(() => summary.length) → derive(..., { summary: { length: summary.key("length") } }, ({ summary }) => summary.length)
// Context: The first computed() returns a string OpaqueRef (from .join()).
//   When the second computed() accesses summary.length, the capture is rewritten
//   to summary.key("length") because summary is an OpaqueRef, not a plain value.
export default pattern((state) => {
    const summary = __ctHelpers.derive({
        type: "object",
        properties: {
            state: {
                type: "object",
                properties: {
                    items: {
                        type: "array",
                        items: {
                            type: "string"
                        },
                        asOpaque: true
                    }
                },
                required: ["items"]
            }
        },
        required: ["state"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __ctHelpers.JSONSchema, { state: {
            items: state.key("items")
        } }, ({ state }) => state.items.join(", "));
    return {
        summary,
        charCount: __ctHelpers.derive({
            type: "object",
            properties: {
                summary: {
                    type: "object",
                    properties: {
                        length: {
                            type: "number"
                        }
                    },
                    required: ["length"]
                }
            },
            required: ["summary"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { summary: {
                length: summary.key("length")
            } }, ({ summary }) => summary.length),
    };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["items"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        summary: {
            type: "string",
            asOpaque: true
        },
        charCount: {
            type: "number",
            asOpaque: true
        }
    },
    required: ["summary", "charCount"]
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
