import * as __ctHelpers from "commontools";
import { cell, derive } from "commontools";
// Test that all literal types are widened in closure captures
export default function TestAllLiteralWidening() {
    const value = cell(10, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    // All literal types that should be widened
    const numLiteral = 42;
    const strLiteral = "hello";
    const boolLiteral = true;
    const floatLiteral = 3.14;
    const result = __ctHelpers.derive({
        type: "object",
        properties: {
            value: {
                type: "number",
                asCell: true
            },
            numLiteral: {
                type: "number"
            },
            floatLiteral: {
                type: "number"
            },
            boolLiteral: {
                type: "boolean"
            },
            strLiteral: {
                type: "string"
            }
        },
        required: ["value", "numLiteral", "floatLiteral", "boolLiteral", "strLiteral"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __ctHelpers.JSONSchema, {
        value,
        numLiteral: numLiteral,
        floatLiteral: floatLiteral,
        boolLiteral: boolLiteral,
        strLiteral: strLiteral
    }, ({ value: v, numLiteral, floatLiteral, boolLiteral, strLiteral }) => {
        // Use all captured literals to ensure they're all widened
        const combined = v.get() + numLiteral + floatLiteral;
        return boolLiteral ? strLiteral + combined : "";
    });
    return result;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
