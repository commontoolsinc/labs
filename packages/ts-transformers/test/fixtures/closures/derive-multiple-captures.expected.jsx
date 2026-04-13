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
    const value = Writable.of(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("value", true);
    const multiplier = Writable.of(2, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("multiplier", true);
    const offset = Writable.of(5, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("offset", true);
    const result = __cfHelpers.derive({
        type: "object",
        properties: {
            value: {
                type: "number",
                asCell: ["cell"]
            },
            multiplier: {
                type: "number",
                asCell: ["cell"]
            },
            offset: {
                type: "number",
                asCell: ["cell"]
            }
        },
        required: ["value", "multiplier", "offset"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, {
        value: value.for(["result", 2, "value"], true),
        multiplier: multiplier,
        offset: offset
    }, ({ value: v, multiplier, offset }) => (v.get() * multiplier.get()) + offset.get()).for("result", true);
    return result;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
