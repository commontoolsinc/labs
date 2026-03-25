import * as __cfHelpers from "commonfabric";
import { Writable, computed, pattern } from "commonfabric";
// FIXTURE: computed-multiple-captures
// Verifies: computed() with a multi-statement body capturing three cells is closure-extracted
//   computed(() => { const sum = a.get() + b.get(); return sum * c.get() }) → derive(captureSchema, resultSchema, { a, b, c }, ({ a, b, c }) => { ... })
//   All three cells (a, b, c) are captured with asCell: true in the schema.
export default pattern(() => {
    const a = Writable.of(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    const b = Writable.of(20, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    const c = Writable.of(30, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    const result = __cfHelpers.derive({
        type: "object",
        properties: {
            a: {
                type: "number",
                asCell: true
            },
            b: {
                type: "number",
                asCell: true
            },
            c: {
                type: "number",
                asCell: true
            }
        },
        required: ["a", "b", "c"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, {
        a: a,
        b: b,
        c: c
    }, ({ a, b, c }) => {
        const sum = a.get() + b.get();
        return sum * c.get();
    });
    return result;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
