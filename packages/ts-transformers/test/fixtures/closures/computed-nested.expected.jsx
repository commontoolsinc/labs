import * as __cfHelpers from "commonfabric";
import { Writable, computed, pattern } from "commonfabric";
// FIXTURE: computed-nested
// Verifies: chained computed() calls where the second captures the result of the first
//   computed(() => a.get() + b.get()) → derive(..., { a, b }, ({ a, b }) => a.get() + b.get())
//   computed(() => sum * 2) → derive(..., { sum }, ({ sum }) => sum * 2)
// Context: The first derive captures cells (asCell: true), the second captures
//   the computed result (asOpaque: true) since it is an OpaqueRef.
export default pattern(() => {
    const a = Writable.of(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    const b = Writable.of(20, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    const sum = __cfHelpers.derive({
        type: "object",
        properties: {
            a: {
                type: "number",
                asCell: true
            },
            b: {
                type: "number",
                asCell: true
            }
        },
        required: ["a", "b"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, {
        a: a,
        b: b
    }, ({ a, b }) => a.get() + b.get());
    const doubled = __cfHelpers.derive({
        type: "object",
        properties: {
            sum: {
                type: "number"
            }
        },
        required: ["sum"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, { sum: sum }, ({ sum }) => sum * 2);
    return doubled;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
