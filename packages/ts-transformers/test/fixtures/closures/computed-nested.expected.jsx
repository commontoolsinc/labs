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
// FIXTURE: computed-nested
// Verifies: chained computed() calls where the second captures the result of the first
//   computed(() => a.get() + b.get()) → lift(({ a, b }) => a.get() + b.get())({ a, b })
//   computed(() => sum * 2) → lift(({ sum }) => sum * 2)({ sum })
// Context: The first lift-applied computation captures cells (asCell: true), the second captures
//   the computed result (asOpaque: true) since it is an OpaqueRef.
export default pattern(() => {
    const a = new Writable(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("a", true);
    const b = new Writable(20, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("b", true);
    const sum = __cfHelpers.lift<{
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
    }).for("sum", true);
    const doubled = __cfHelpers.lift<{
        sum: number;
    }, number>({
        type: "object",
        properties: {
            sum: {
                type: "number"
            }
        },
        required: ["sum"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, ({ sum }) => sum * 2)({ sum: sum }).for("doubled", true);
    return doubled;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
