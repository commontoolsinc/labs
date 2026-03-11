import * as __ctHelpers from "commontools";
import { Writable, derive, pattern } from "commontools";
// FIXTURE: derive-template-literal
// Verifies: a captured cell used inside a template literal expression is extracted
//   derive(value, fn) → derive(schema, schema, { value, prefix }, fn)
export default pattern(() => {
    const value = Writable.of(10, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    const prefix = Writable.of("Value: ", {
        type: "string"
    } as const satisfies __ctHelpers.JSONSchema);
    const result = __ctHelpers.derive({
        type: "object",
        properties: {
            value: {
                type: "number",
                asCell: true
            },
            prefix: {
                type: "string",
                asCell: true
            }
        },
        required: ["value", "prefix"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __ctHelpers.JSONSchema, {
        value,
        prefix: prefix
    }, ({ value: v, prefix }) => `${prefix.get()}${v}`);
    return result;
}, false as const satisfies __ctHelpers.JSONSchema, {
    type: "string",
    asOpaque: true
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
