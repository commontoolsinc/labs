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
    const a = new Writable(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("a", true);
    const b = new Writable(20, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("b", true);
    const c = new Writable(30, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("c", true);
    const result = __cfHelpers.lift<{
        a: __cfHelpers.ReadonlyCell<number>;
        b: __cfHelpers.ReadonlyCell<number>;
        c: __cfHelpers.ReadonlyCell<number>;
    }, number>({
        type: "object",
        properties: {
            a: {
                type: "number",
                asCell: ["readonly"]
            },
            b: {
                type: "number",
                asCell: ["readonly"]
            },
            c: {
                type: "number",
                asCell: ["readonly"]
            }
        },
        required: ["a", "b", "c"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, ({ a: x, b, c }) => (x.get() * b.get() + c.get()) / 2)({
        a: a.for(["result", "a"], true),
        b: b,
        c: c
    }).for("result", true);
    return result;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
