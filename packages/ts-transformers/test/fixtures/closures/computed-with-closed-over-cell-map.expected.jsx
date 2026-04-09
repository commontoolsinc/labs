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
// FIXTURE: computed-with-closed-over-cell-map
// Verifies: .map() on a closed-over Cell inside computed() IS transformed to .mapWithPattern()
//   computed(() => numbers.map(n => n * multiplier.get())) → derive(..., { numbers, multiplier }, ({ numbers, multiplier }) => numbers.mapWithPattern(pattern(fn, ...), { multiplier }))
// Context: Unlike OpaqueRef arrays, Cell arrays still need reactive mapping even
//   inside a derive callback. The .map() callback's closed-over `multiplier` cell
//   is passed as a params object to mapWithPattern.
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
    // Inside computed, we close over numbers (a Cell)
    // The computed gets transformed to derive({}, () => numbers.map(...))
    // Inside a derive, .map on a closed-over Cell should STILL be transformed to mapWithPattern
    // because Cells need the pattern-based mapping even when unwrapped
    const doubled = __cfHelpers.derive({
        type: "object",
        properties: {
            numbers: {
                type: "array",
                items: {
                    type: "number"
                },
                asCell: ["cell"]
            },
            multiplier: {
                type: "number",
                asCell: ["cell"]
            }
        },
        required: ["numbers", "multiplier"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "array",
        items: {
            type: "number"
        }
    } as const satisfies __cfHelpers.JSONSchema, {
        numbers: numbers,
        multiplier: multiplier
    }, ({ numbers, multiplier }) => numbers.mapWithPattern(__cfHelpers.pattern(__cf_pattern_input => {
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
                        asCell: ["cell"]
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
    return doubled;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "number"
    }
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
