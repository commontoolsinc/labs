import * as __ctHelpers from "commontools";
import { pattern } from "commontools";
const wrap = <T,>(value: T) => value;
// FIXTURE: pattern-call-arg-conditional
// Verifies: top-level non-JSX ternary in a call argument is lowered after
//   closure normalization rather than being left as raw JS truthiness.
//   const label = wrap(state.done ? "Done" : "Pending")
//   → const label = wrap(ifElse(state.done, "Done", "Pending"))
export default pattern((state) => {
    const label = wrap(__ctHelpers.ifElse({
        type: "boolean"
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __ctHelpers.JSONSchema, {
        "enum": ["Done", "Pending"]
    } as const satisfies __ctHelpers.JSONSchema, state.key("done"), "Done", "Pending"));
    return { label };
}, {
    type: "object",
    properties: {
        done: {
            type: "boolean"
        }
    },
    required: ["done"]
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
