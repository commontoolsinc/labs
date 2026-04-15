function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { computed, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// FIXTURE: pattern-computed-opaque-ref-map
// Verifies: .map() on an OpaqueRef inside computed() is NOT transformed to mapWithPattern
//   computed(() => items.map((n) => n * 2)) → derive({ items }, ({ items }) => items.map((n) => n * 2))
// Context: Inside computed/derive, OpaqueRef auto-unwraps to a plain array, so
//   .map() is a standard Array.prototype.map — it must remain untransformed.
//   This is a negative test for reactive method detection.
export default pattern((items) => {
    // items is OpaqueRef<number[]> as a pattern parameter
    // Inside the computed callback (which becomes derive), items.map should NOT be transformed
    const doubled = __cfHelpers.derive({
        type: "object",
        properties: {
            items: {
                type: "array",
                items: {
                    type: "number"
                }
            }
        },
        required: ["items"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "array",
        items: {
            type: "number"
        }
    } as const satisfies __cfHelpers.JSONSchema, { items: items }, ({ items }) => items.map((n) => n * 2)).for("doubled", true);
    return doubled;
}, {
    type: "array",
    items: {
        type: "number"
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "number"
    }
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
