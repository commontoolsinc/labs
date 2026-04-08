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
interface Config {
    multiplier?: number;
}
// FIXTURE: derive-optional-chaining
// Verifies: an optional property captured via nullish coalescing is extracted with a union type schema
//   derive(value, fn) → derive(schema, schema, { value, config: { multiplier: ... } }, fn)
// Context: `config.multiplier` is `number | undefined`; schema uses `type: ["number", "undefined"]`
export default pattern((config: Config) => {
    const value = Writable.of(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    const result = __cfHelpers.derive({
        type: "object",
        properties: {
            value: {
                type: "number",
                asCell: true
            },
            config: {
                type: "object",
                properties: {
                    multiplier: {
                        type: "number"
                    }
                }
            }
        },
        required: ["value", "config"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, {
        value,
        config: {
            multiplier: config.key("multiplier")
        }
    }, ({ value: v, config }) => v.get() * (config.multiplier ?? 1));
    return result;
}, {
    type: "object",
    properties: {
        multiplier: {
            type: "number"
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
