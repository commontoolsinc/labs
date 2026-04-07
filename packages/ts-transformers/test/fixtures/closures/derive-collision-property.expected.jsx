function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { Writable, derive, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
// FIXTURE: derive-collision-property
// Verifies: name collision renames the capture variable but preserves object property names
//   derive(multiplier, fn) → derive(schema, schema, { multiplier, multiplier_1 }, fn)
//   callback: `multiplier.get()` (capture ref) → `multiplier_1.get()`
// Context: returned object literal `{ multiplier: ... }` property name stays unchanged
export default pattern(() => {
    const multiplier = Writable.of(2, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    // Input name 'multiplier' collides with captured variable 'multiplier'
    // The callback returns an object with a property named 'multiplier'
    // Only the variable reference should be renamed, NOT the property name
    const result = __cfHelpers.derive({
        type: "object",
        properties: {
            multiplier_1: {
                type: "number",
                asCell: true
            },
            multiplier: {
                type: "number",
                asCell: true
            }
        },
        required: ["multiplier_1", "multiplier"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "object",
        properties: {
            multiplier: {
                type: "number"
            },
            value: {
                type: "number"
            }
        },
        required: ["multiplier", "value"]
    } as const satisfies __cfHelpers.JSONSchema, {
        multiplier,
        multiplier_1: multiplier
    }, ({ multiplier: m, multiplier_1 }) => ({
        multiplier: multiplier_1.get(),
        value: m.get() * 3,
    }));
    return result;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        multiplier: {
            type: "number"
        },
        value: {
            type: "number"
        }
    },
    required: ["multiplier", "value"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
