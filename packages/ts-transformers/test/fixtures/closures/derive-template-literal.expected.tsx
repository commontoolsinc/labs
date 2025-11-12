import * as __ctHelpers from "commontools";
import { cell, derive } from "commontools";
export default function TestDerive() {
    const value = cell(10);
    const prefix = cell("Value: ");
    const result = __ctHelpers.derive({
        $schema: "https://json-schema.org/draft/2020-12/schema",
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
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "string"
    } as const satisfies __ctHelpers.JSONSchema, {
        value,
        prefix: prefix
    }, ({ value: v, prefix }) => `${prefix.get()}${v}`);
    return result;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
