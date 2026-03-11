import * as __ctHelpers from "commontools";
import { Writable, derive, pattern } from "commontools";
// Test that all literal types are widened in closure captures
// FIXTURE: derive-all-literal-types
// Verifies: literal values (number, string, boolean, float) are captured and their types widened in schemas
//   derive(value, fn) → derive(schema, schema, { value, numLiteral, floatLiteral, boolLiteral, strLiteral }, fn)
// Context: each literal type maps to its widened JSON schema type (e.g., 42 → "number", "hello" → "string")
export default pattern(() => {
    const value = Writable.of(10, {
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
}, false as const satisfies __ctHelpers.JSONSchema, {
    type: "string",
    asOpaque: true
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
