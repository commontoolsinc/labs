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
// FIXTURE: derive-name-collision
// Verifies: when the input variable and a capture share the same name, the capture is renamed with a suffix
//   derive(multiplier, fn) → derive(schema, schema, { multiplier, multiplier_1 }, fn)
//   callback: `multiplier.get()` (capture) → `multiplier_1.get()`
export default pattern(() => {
    const multiplier = new Writable(2, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("multiplier", true);
    // Input name collides with capture name
    // multiplier is both the input AND a captured variable (used via .get())
    const result = __cfHelpers.lift<{
        multiplier: __cfHelpers.ReadonlyCell<number>;
        multiplier_1: __cfHelpers.ReadonlyCell<number>;
    }, number>({
        type: "object",
        properties: {
            multiplier: {
                type: "number",
                asCell: ["readonly"]
            },
            multiplier_1: {
                type: "number",
                asCell: ["readonly"]
            }
        },
        required: ["multiplier", "multiplier_1"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, ({ multiplier: m, multiplier_1 }) => m.get() * 3 + multiplier_1.get())({
        multiplier: multiplier.for(["result", "multiplier"], true),
        multiplier_1: multiplier
    }).for("result", true);
    return result;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
