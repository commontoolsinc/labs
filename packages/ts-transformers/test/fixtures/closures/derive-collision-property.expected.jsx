import * as __ctHelpers from "commontools";
import { Writable, derive, pattern } from "commontools";
// FIXTURE: derive-collision-property
// Verifies: name collision renames the capture variable but preserves object property names
//   derive(multiplier, fn) → derive(schema, schema, { multiplier, multiplier_1 }, fn)
//   callback: `multiplier.get()` (capture ref) → `multiplier_1.get()`
// Context: returned object literal `{ multiplier: ... }` property name stays unchanged
export default pattern(() => {
    const multiplier = Writable.of(2, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    // Input name 'multiplier' collides with captured variable 'multiplier'
    // The callback returns an object with a property named 'multiplier'
    // Only the variable reference should be renamed, NOT the property name
    const result = __ctHelpers.derive({
        type: "object",
        properties: {
            multiplier: {
                type: "number",
                asCell: true
            },
            multiplier_1: {
                type: "number",
                asCell: true
            }
        },
        required: ["multiplier", "multiplier_1"]
    } as const satisfies __ctHelpers.JSONSchema, {
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
    } as const satisfies __ctHelpers.JSONSchema, {
        multiplier,
        multiplier_1: multiplier
    }, ({ multiplier: m, multiplier_1 }) => ({
        multiplier: multiplier_1.get(),
        value: m.get() * 3,
    }));
    return result;
}, false as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        multiplier: {
            type: "number"
        },
        value: {
            type: "number"
        }
    },
    required: ["multiplier", "value"],
    asOpaque: true
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
