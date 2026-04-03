import * as __ctHelpers from "commontools";
import { pattern } from "commontools";
// FIXTURE: pattern-object-logical-or
// Verifies: top-level non-JSX logical-or in an object property is lowered after
//   closure normalization rather than being left as raw JS short-circuiting.
//   return { label: state.label || "Pending" }
//   → return { label: unless(state.label, "Pending") }
export default pattern((state) => ({
    label: __ctHelpers.unless({
        type: ["string", "undefined"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __ctHelpers.JSONSchema, state.key("label"), "Pending"),
}), {
    type: "object",
    properties: {
        label: {
            type: "string"
        }
    }
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        label: {
            type: "string"
        }
    },
    required: ["label"]
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
