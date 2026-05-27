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
// FIXTURE: derive-empty-input-no-params
// Verifies: zero-parameter callback with empty `{}` input still captures closed-over cells
//   derive({}, () => ...) → derive(schema, schema, { a, b }, ({ a, b }) => ...)
// Context: no explicit input param; captures become the sole parameters of the rewritten callback
export default pattern(() => {
    const a = new Writable(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("a", true);
    const b = new Writable(20, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("b", true);
    // Zero-parameter callback that closes over a and b
    const result = __cfHelpers.lift<{
        a: __cfHelpers.ReadonlyCell<number>;
        b: __cfHelpers.ReadonlyCell<number>;
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
            }
        },
        required: ["a", "b"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, ({ a, b }) => a.get() + b.get())({
        a: a,
        b: b
    }).for("result", true);
    return result;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
