import * as __ctHelpers from "commontools";
import { cell, derive } from "commontools";
const __lift_0 = __ctHelpers.lift({
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
        value: {
            type: "number"
        },
        data: {
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
    required: ["value", "data"]
} as const satisfies __ctHelpers.JSONSchema, ({ multiplier: m, multiplier_1 }) => ({
    value: m.get() * 3,
    data: { multiplier: multiplier_1 },
}));
export default function TestDeriveCollisionShorthand() {
    const multiplier = cell(2, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    // Input name 'multiplier' collides with captured variable 'multiplier'
    // The callback uses shorthand property { multiplier }
    // This should expand to { multiplier: multiplier_1 } after renaming
    const result = __lift_0({
        multiplier,
        multiplier_1: multiplier
    });
    return result;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
