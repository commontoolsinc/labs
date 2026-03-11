import * as __ctHelpers from "commontools";
import { Writable, computed, pattern } from "commontools";
// FIXTURE: computed-nested-property
// Verifies: computed() capturing a cell with an object value and accessing a nested property
//   computed(() => { const current = counter.get(); return current.count * 2 }) → derive(..., { counter }, ({ counter }) => { ... })
//   The cell schema preserves the nested object shape { count: number } with asCell: true.
export default pattern(() => {
    const counter = Writable.of({ count: 0 }, {
        type: "object",
        properties: {
            count: {
                type: "number"
            }
        },
        required: ["count"]
    } as const satisfies __ctHelpers.JSONSchema);
    const doubled = __ctHelpers.derive({
        type: "object",
        properties: {
            counter: {
                type: "object",
                properties: {
                    count: {
                        type: "number"
                    }
                },
                required: ["count"],
                asCell: true
            }
        },
        required: ["counter"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, { counter: counter }, ({ counter }) => {
        const current = counter.get();
        return current.count * 2;
    });
    return doubled;
}, false as const satisfies __ctHelpers.JSONSchema, {
    type: "number",
    asOpaque: true
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
