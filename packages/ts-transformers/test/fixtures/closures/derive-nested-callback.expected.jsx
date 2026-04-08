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
// FIXTURE: derive-nested-callback
// Verifies: capture extraction works with nested .map() which is itself transformed to mapWithPattern
//   derive(numbers, fn) → derive(schema, schema, { numbers, multiplier }, fn)
//   inner nums.map(fn) → nums.mapWithPattern(pattern(...), { multiplier })
// Context: `multiplier` is captured by both derive and the inner map; inner map receives it via params
export default pattern(() => {
    const numbers = Writable.of([1, 2, 3], {
        type: "array",
        items: {
            type: "number"
        }
    } as const satisfies __cfHelpers.JSONSchema);
    const multiplier = Writable.of(2, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    // Nested callback - inner array map should not capture outer multiplier
    const result = __cfHelpers.derive({
        type: "object",
        properties: {
            numbers: {
                type: "array",
                items: {
                    type: "number"
                },
                asCell: true
            },
            multiplier: {
                type: "number",
                asCell: true
            }
        },
        required: ["numbers", "multiplier"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "array",
        items: {
            type: "number"
        }
    } as const satisfies __cfHelpers.JSONSchema, {
        numbers,
        multiplier: multiplier
    }, ({ numbers: nums, multiplier }) => nums.mapWithPattern(__cfHelpers.pattern(__cf_pattern_input => {
        const n = __cf_pattern_input.key("element");
        const multiplier = __cf_pattern_input.key("params", "multiplier");
        return n * multiplier.get();
    }, {
        type: "object",
        properties: {
            element: {
                type: "number"
            },
            params: {
                type: "object",
                properties: {
                    multiplier: {
                        type: "number",
                        asCell: true
                    }
                },
                required: ["multiplier"]
            }
        },
        required: ["element", "params"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema), {
        multiplier: multiplier
    }));
    return result;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "number"
    }
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
