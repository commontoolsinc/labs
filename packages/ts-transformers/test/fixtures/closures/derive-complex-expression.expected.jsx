function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Writable, derive, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// FIXTURE: derive-complex-expression
// Verifies: multiple captured cells in an arithmetic expression are all extracted
//   derive(a, fn) → derive(schema, schema, { a, b, c }, fn)
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
        a,
        b: b,
        c: c
    }, ({ a: x, b, c }) => (x.get() * b.get() + c.get()) / 2);
    return result;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
