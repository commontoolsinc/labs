import * as __ctHelpers from "commontools";
import { cell, pattern } from "commontools";
// FIXTURE: cell-pattern-input-structure-recovery
// Verifies: `cell(state.values)` preserves array/item structure when the source
// comes from a typed pattern input.
export default pattern((state) => {
    const typedValues = cell(state.key("values"), {
        type: "array",
        items: {
            type: "number"
        }
    } as const satisfies __ctHelpers.JSONSchema);
    return { typedValues };
}, {
    type: "object",
    properties: {
        values: {
            type: "array",
            items: {
                type: "number"
            }
        }
    },
    required: ["values"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        typedValues: {
            type: "array",
            items: {
                type: "number"
            },
            asCell: true
        }
    },
    required: ["typedValues"]
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
