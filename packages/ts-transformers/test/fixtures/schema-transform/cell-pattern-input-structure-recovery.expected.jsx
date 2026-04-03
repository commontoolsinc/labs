import * as __cfHelpers from "commonfabric";
import { cell, pattern } from "commonfabric";
// FIXTURE: cell-pattern-input-structure-recovery
// Verifies: `cell(state.values)` preserves array/item structure when the source
// comes from a typed pattern input.
export default pattern((state) => {
    const typedValues = cell(state.key("values"), {
        type: "array",
        items: {
            type: "number"
        }
    } as const satisfies __cfHelpers.JSONSchema);
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
} as const satisfies __cfHelpers.JSONSchema, {
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
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
