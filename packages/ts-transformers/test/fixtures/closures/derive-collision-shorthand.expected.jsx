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
// FIXTURE: derive-collision-shorthand
// Verifies: shorthand property `{ multiplier }` expands correctly when the capture is renamed
//   derive(multiplier, fn) → derive(schema, schema, { multiplier, multiplier_1 }, fn)
//   shorthand `{ multiplier }` → `{ multiplier: multiplier_1 }`
// Context: shorthand must expand to keep the property name while using the renamed capture binding
export default pattern(() => {
    const multiplier = Writable.of(2, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    // Input name 'multiplier' collides with captured variable 'multiplier'
    // The callback uses shorthand property { multiplier }
    // This should expand to { multiplier: multiplier_1 } after renaming
    const result = __cfHelpers.derive({
        type: "object",
        properties: {
            multiplier: {
                type: "number",
                asCell: ["cell"]
            },
            multiplier_1: {
                type: "number",
                asCell: ["cell"]
            }
        },
        required: ["multiplier", "multiplier_1"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "object",
        properties: {
            value: {
                type: "number"
            },
            data: {
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
        required: ["value", "data"]
    } as const satisfies __cfHelpers.JSONSchema, {
        multiplier,
        multiplier_1: multiplier
    }, ({ multiplier: m, multiplier_1 }) => ({
        value: m.get() * 3,
        data: { multiplier: multiplier_1 },
    }));
    return result;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        value: {
            type: "number"
        },
        data: {
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
    required: ["value", "data"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
