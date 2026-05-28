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
// FIXTURE: derive-multiple-captures
// Verifies: two captured cells are both extracted into the derive capture object
//   derive(value, fn) → derive(schema, schema, { value, multiplier, offset }, fn)
export default pattern(() => {
    const value = new Writable(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("value", true);
    const multiplier = new Writable(2, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("multiplier", true);
    const offset = new Writable(5, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("offset", true);
    const result = __cfHelpers.lift<{
        value: __cfHelpers.ReadonlyCell<number>;
        multiplier: __cfHelpers.ReadonlyCell<number>;
        offset: __cfHelpers.ReadonlyCell<number>;
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
            },
            offset: {
                type: "number",
                asCell: ["readonly"]
            }
        },
        required: ["value", "multiplier", "offset"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, ({ value: v, multiplier, offset }) => (v.get() * multiplier.get()) + offset.get())({
        value: value.for(["result", "value"], true),
        multiplier: multiplier,
        offset: offset
    }).for("result", true);
    return result;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
