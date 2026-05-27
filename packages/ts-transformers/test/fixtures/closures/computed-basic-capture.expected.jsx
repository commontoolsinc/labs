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
// FIXTURE: computed-basic-capture
// Verifies: computed(() => expr) with two cell captures is closure-extracted into derive()
//   computed(() => value.get() * multiplier.get()) → derive(captureSchema, resultSchema, { value, multiplier }, ({ value, multiplier }) => value.get() * multiplier.get())
//   Captured cells are annotated with asCell: true in the capture schema.
export default pattern(() => {
    const value = new Writable(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("value", true);
    const multiplier = new Writable(2, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("multiplier", true);
    const result = __cfHelpers.lift<{
        value: __cfHelpers.ReadonlyCell<number>;
        multiplier: __cfHelpers.ReadonlyCell<number>;
    }, number>({
        type: "object",
        properties: {
            value: {
                type: "number",
                asCell: ["readonly"]
            },
            multiplier: {
                type: "number",
                asCell: ["readonly"]
            }
        },
        required: ["value", "multiplier"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, ({ value, multiplier }) => value.get() * multiplier.get())({
        value: value,
        multiplier: multiplier
    }).for("result", true);
    return result;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
