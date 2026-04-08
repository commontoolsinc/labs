function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Writable, computed, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// FIXTURE: computed-complex-expression
// Verifies: computed(() => expr) with three cell captures in an arithmetic expression
//   computed(() => (a.get() * b.get() + c.get()) / 2) → derive(captureSchema, resultSchema, { a, b, c }, ({ a, b, c }) => ...)
//   All three cells (a, b, c) are captured with asCell: true in the schema.
export default pattern(() => {
    const a = Writable.of(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    const b = Writable.of(20, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    const c = Writable.of(5, {
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
    }, ({ a, b, c }) => (a.get() * b.get() + c.get()) / 2);
    return result;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
