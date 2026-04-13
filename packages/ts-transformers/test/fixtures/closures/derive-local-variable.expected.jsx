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
// FIXTURE: derive-local-variable
// Verifies: callback-local variables are not captured, but outer cells are
//   derive(a, fn) → derive(schema, schema, { a, b, c }, fn)
// Context: `sum` is a local const inside the callback and must not appear in captures
export default pattern(() => {
    const a = Writable.of(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("a", true);
    const b = Writable.of(20, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("b", true);
    const c = Writable.of(30, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("c", true);
    const result = __cfHelpers.derive({
        type: "object",
        properties: {
            a: {
                type: "number",
                asCell: ["cell"]
            },
            b: {
                type: "number",
                asCell: ["cell"]
            },
            c: {
                type: "number",
                asCell: ["cell"]
            }
        },
        required: ["a", "b", "c"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, {
        a: a.for(["result", 2, "a"], true),
        b: b,
        c: c
    }, ({ a: aVal, b, c }) => {
        const sum = aVal.get() + b.get();
        return sum * c.get();
    }).for("result", true);
    return result;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
