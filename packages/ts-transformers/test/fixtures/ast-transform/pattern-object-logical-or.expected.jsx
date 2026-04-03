import * as __cfHelpers from "commonfabric";
import { pattern } from "commonfabric";
// FIXTURE: pattern-object-logical-or
// Verifies: top-level non-JSX logical-or in an object property is lowered after
//   closure normalization rather than being left as raw JS short-circuiting.
//   return { label: state.label || "Pending" }
//   → return { label: unless(state.label, "Pending") }
export default pattern((state) => ({
    label: __cfHelpers.unless({
        type: ["string", "undefined"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, state.key("label"), "Pending"),
}), {
    type: "object",
    properties: {
        label: {
            type: "string"
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        label: {
            type: "string"
        }
    },
    required: ["label"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
