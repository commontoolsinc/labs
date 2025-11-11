import * as __ctHelpers from "commontools";
import { cell, derive } from "commontools";
export default function TestDeriveCollisionShorthand() {
    const multiplier = cell(2);
    // Input name 'multiplier' collides with captured variable 'multiplier'
    // The callback uses shorthand property { multiplier }
    // This should expand to { multiplier: multiplier_1 } after renaming
    const result = __ctHelpers.derive({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
            multiplier: {
                type: "number",
                asOpaque: true
            },
            multiplier_1: {
                type: "number",
                asOpaque: true
            }
        },
        required: ["multiplier", "multiplier_1"]
    } as const satisfies __ctHelpers.JSONSchema, {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
            value: {
                type: "number"
            },
            data: {
                type: "object",
                properties: {
                    multiplier: true
                },
                required: ["multiplier"]
            }
        },
        required: ["value", "data"]
    } as const satisfies __ctHelpers.JSONSchema, {
        multiplier,
        multiplier_1: multiplier
    }, ({ multiplier: m, multiplier_1 }) => ({
        value: m * 3,
        data: { multiplier: multiplier_1 },
    }));
    return result;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
