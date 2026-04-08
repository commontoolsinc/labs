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
// FIXTURE: computed-optional-chaining
// Verifies: computed() with optional chaining and nullish coalescing on captured cells
//   computed(() => value.get() * (config.get()?.multiplier ?? 1)) → derive(..., { value, config }, ({ value, config }) => ...)
//   The config cell has a nullable type (anyOf [object, null]) with asCell: true in the capture schema.
export default pattern(() => {
    const config = Writable.of<{
        multiplier?: number;
    } | null>({ multiplier: 2 }, {
        anyOf: [{
                type: "object",
                properties: {
                    multiplier: {
                        type: "number"
                    }
                }
            }, {
                type: "null"
            }]
    } as const satisfies __cfHelpers.JSONSchema);
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
                anyOf: [{
                        type: "object",
                        properties: {
                            multiplier: {
                                type: "number"
                            }
                        }
                    }, {
                        type: "null"
                    }],
                asCell: true
            }
        },
        required: ["value", "config"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, {
        value: value,
        config: config
    }, ({ value, config }) => value.get() * (config.get()?.multiplier ?? 1));
    return result;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
