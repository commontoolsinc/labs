import * as __cfHelpers from "commonfabric";
import { Writable, computed, pattern } from "commonfabric";
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
    } as const satisfies __cfHelpers.JSONSchema);
    const doubled = __cfHelpers.derive({
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
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, { counter: counter }, ({ counter }) => {
        const current = counter.get();
        return current.count * 2;
    });
    return doubled;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
