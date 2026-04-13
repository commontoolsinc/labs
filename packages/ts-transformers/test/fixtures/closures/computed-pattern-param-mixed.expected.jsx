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
// FIXTURE: computed-pattern-param-mixed
// Verifies: computed() capturing a mix of cells, pattern params, and plain locals
//   computed(() => (value.get() + config.base + offset) * config.multiplier + threshold.get()) → derive(..., { value, config: { base, multiplier }, offset, threshold }, ...)
// Context: Captures four different variable types: cell (value, threshold with
//   asCell), pattern param (config with .key() rewriting), and plain local
//   (offset as plain number). All coexist in a single capture object.
export default pattern((config: {
    base: number;
    multiplier: number;
}) => {
    const value = Writable.of(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    const offset = 5; // non-cell local
    const threshold = Writable.of(15, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema); // cell local
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
                    base: {
                        type: "number"
                    },
                    multiplier: {
                        type: "number"
                    }
                },
                required: ["base", "multiplier"]
            },
            offset: {
                type: "number"
            },
            threshold: {
                type: "number",
                asCell: ["cell"]
            }
        },
        required: ["value", "config", "offset", "threshold"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, {
        value: value,
        config: {
            base: config.key("base"),
            multiplier: config.key("multiplier")
        },
        offset: offset,
        threshold: threshold
    }, ({ value, config, offset, threshold }) => (value.get() + config.base + offset) * config.multiplier + threshold.get());
    return result;
}, {
    type: "object",
    properties: {
        base: {
            type: "number"
        },
        multiplier: {
            type: "number"
        }
    },
    required: ["base", "multiplier"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
