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
// FIXTURE: derive-param-initializer
// Verifies: a callback parameter with a default value is preserved after capture extraction
//   derive(value, (v = 10) => ...) → derive(schema, schema, { value, multiplier }, ({ value: v = 10, multiplier }) => ...)
// Context: the default initializer `= 10` is carried over to the destructured parameter
export default pattern(() => {
    const value = 5;
    const multiplier = new Writable(2, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("multiplier", true);
    // Test parameter with default value
    const result = __cfHelpers.lift<{
        value: number;
        multiplier: __cfHelpers.ReadonlyCell<number>;
    }, number>({
        type: "object",
        properties: {
            value: {
                type: "number"
            },
            multiplier: {
                type: "number",
                asCell: ["readonly"]
            }
        },
        required: ["value", "multiplier"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, ({ value: v = 10, multiplier }) => v * multiplier.get())({
        value,
        multiplier: multiplier
    }).for("result", true);
    return result;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
