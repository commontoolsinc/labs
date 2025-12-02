import * as __ctHelpers from "commontools";
import { cell, derive } from "commontools";
export default function TestDeriveCollisionProperty() {
    const multiplier = cell(2, {
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
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
