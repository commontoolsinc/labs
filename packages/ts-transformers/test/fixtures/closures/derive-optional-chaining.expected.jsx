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
    const value = new Writable(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("value", true);
    const result = __cfHelpers.lift<{
        value: __cfHelpers.ReadonlyCell<number>;
        config: {
            multiplier?: number | undefined;
        };
    }, number>({
        type: "object",
        properties: {
            value: {
                type: "number",
                asCell: ["readonly"]
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
    } as const satisfies __cfHelpers.JSONSchema, ({ value: v, config }) => v.get() * (config.multiplier ?? 1))({
        value: value.for(["result", "value"], true),
        config: {
            multiplier: config.key("multiplier")
        }
    }).for("result", true);
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
