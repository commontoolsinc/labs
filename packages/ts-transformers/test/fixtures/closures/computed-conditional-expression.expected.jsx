function __ctHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { Writable, computed, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
// FIXTURE: computed-conditional-expression
// Verifies: computed(() => expr) with four cell captures in a ternary expression
//   computed(() => value.get() > threshold.get() ? a.get() : b.get()) → derive(captureSchema, resultSchema, { value, threshold, a, b }, ({ value, threshold, a, b }) => ...)
//   All four cells are captured with asCell: true in the schema.
export default pattern(() => {
    const value = Writable.of(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    const threshold = Writable.of(5, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    const a = Writable.of(100, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    const b = Writable.of(200, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    const result = __cfHelpers.derive({
        type: "object",
        properties: {
            value: {
                type: "number",
                asCell: true
            },
            threshold: {
                type: "number",
                asCell: true
            },
            a: {
                type: "number",
                asCell: true
            },
            b: {
                type: "number",
                asCell: true
            }
        },
        required: ["value", "threshold", "a", "b"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, {
        value: value,
        threshold: threshold,
        a: a,
        b: b
    }, ({ value, threshold, a, b }) => value.get() > threshold.get() ? a.get() : b.get());
    return result;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__ctHardenFn(h);
