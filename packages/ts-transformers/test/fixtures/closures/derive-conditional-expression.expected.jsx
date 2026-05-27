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
// FIXTURE: derive-conditional-expression
// Verifies: captures used in both branches of a ternary are extracted
//   derive(value, fn) → derive(schema, schema, { value, threshold, multiplier }, fn)
export default pattern(() => {
    const value = new Writable(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("value", true);
    const threshold = new Writable(5, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("threshold", true);
    const multiplier = new Writable(2, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("multiplier", true);
    const result = __cfHelpers.lift<{
        value: __cfHelpers.ReadonlyCell<number>;
        threshold: __cfHelpers.ReadonlyCell<number>;
        multiplier: __cfHelpers.ReadonlyCell<number>;
    }, number>({
        type: "object",
        properties: {
            value: {
                type: "number",
                asCell: ["readonly"]
            },
            threshold: {
                type: "number",
                asCell: ["readonly"]
            },
            multiplier: {
                type: "number",
                asCell: ["readonly"]
            }
        },
        required: ["value", "threshold", "multiplier"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, ({ value: v, threshold, multiplier }) => v.get() > threshold.get() ? v.get() * multiplier.get() : v.get())({
        value: value.for(["result", "value"], true),
        threshold: threshold,
        multiplier: multiplier
    }).for("result", true);
    return result;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
