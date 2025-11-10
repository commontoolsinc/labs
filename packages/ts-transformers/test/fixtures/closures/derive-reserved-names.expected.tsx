import * as __ctHelpers from "commontools";
import { cell, derive } from "commontools";
export default function TestDerive() {
    const value = cell(10);
    // Reserved JavaScript keyword as variable name (valid in TS with quotes)
    const __ct_reserved = cell(2);
    const result = __ctHelpers.derive({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
            value: {
                type: "number",
                asOpaque: true
            },
            __ct_reserved: {
                type: "number",
                asOpaque: true
            }
        },
        required: ["value", "__ct_reserved"]
    } as const satisfies __ctHelpers.JSONSchema, {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, {
        value,
        __ct_reserved: __ct_reserved
    }, ({ value: v, __ct_reserved }) => v * __ct_reserved.get());
    return result;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
