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
// FIXTURE: derive-template-literal
// Verifies: a captured cell used inside a template literal expression is extracted
//   derive(value, fn) → derive(schema, schema, { value, prefix }, fn)
export default pattern(() => {
    const value = Writable.of(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("value", true);
    const prefix = Writable.of("Value: ", {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema).for("prefix", true);
    const result = __cfHelpers.derive({
        type: "object",
        properties: {
            prefix: {
                type: "string",
                asCell: ["cell"]
            },
            value: {
                type: "number",
                asCell: ["cell"]
            }
        },
        required: ["prefix", "value"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        value: value.for(["result", 2, "value"], true),
        prefix: prefix
    }, ({ value: v, prefix }) => `${prefix.get()}${v}`).for("result", true);
    return result;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
