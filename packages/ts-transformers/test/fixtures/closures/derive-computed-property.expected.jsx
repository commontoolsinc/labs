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
// FIXTURE: derive-computed-property
// Verifies: computed property access with a dynamic key captures both the object and the key
//   derive(value, fn) → derive(schema, schema, { value, config, key }, fn)
// Context: `config[key]` requires both `config` and `key` to be captured as plain values
export default pattern(() => {
    const value = Writable.of(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("value", true);
    const config = { multiplier: 2, divisor: 5 };
    const key = "multiplier";
    const result = __cfHelpers.derive({
        type: "object",
        properties: {
            value: {
                type: "number",
                asCell: ["cell"]
            },
            config: {
                type: "object",
                properties: {
                    multiplier: {
                        type: "number"
                    },
                    divisor: {
                        type: "number"
                    }
                },
                required: ["multiplier", "divisor"]
            },
            key: {
                type: "string"
            }
        },
        required: ["value", "config", "key"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, {
        value: value.for(["result", 2, "value"], true),
        config: config,
        key: key
    }, ({ value: v, config, key }) => v.get() * config[key]).for("result", true);
    return result;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
